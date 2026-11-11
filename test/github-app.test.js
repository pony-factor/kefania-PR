import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { createAppRequest } from '../src/github.js';
import { createActions } from '../src/pull-requests.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const env = { KEFANIA_GITHUB_APP_ID: '123', KEFANIA_GITHUB_INSTALLATION_ID: '456',
  KEFANIA_GITHUB_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
function fixture({ slug = 'codex-pony', failWrite = false } = {}) {
  let time = Date.parse('2026-10-09T12:00:00Z'), tokens = 0;
  const calls = [];
  const request = createAppRequest({ env, now: () => time, fetchImpl: async (url, options) => {
    const endpoint = url.replace('https://api.github.com/', '');
    calls.push({ endpoint, options });
    if (endpoint === 'app' || endpoint.endsWith('/access_tokens') || endpoint.endsWith('/installation') || endpoint.startsWith('app/installations?')) {
      const jwt = options.headers.Authorization.slice(7), [header, payload, signature] = jwt.split('.');
      const verifier = createVerify('RSA-SHA256');
      verifier.update(`${header}.${payload}`);
      assert(verifier.verify(publicKey, Buffer.from(signature, 'base64url')));
      const claims = JSON.parse(Buffer.from(payload, 'base64url'));
      assert.equal(claims.iss, '123');
      assert(claims.iat < time / 1000 && claims.exp > time / 1000 && claims.exp < time / 1000 + 600);
      if (endpoint.startsWith('app/installations?')) return { ok: true, json: async () => [{ id: 456, account: { login: 'example' }, permissions: { contents: 'read', pull_requests: 'write', issues: 'write' } }] };
      if (endpoint.endsWith('/installation')) return { ok: true, json: async () => ({ id: 456 }) };
      return { ok: true, json: async () => endpoint === 'app' ? { slug } : {
        token: `fixture-${++tokens}`, expires_at: new Date(time + 3600000).toISOString() } };
    }
    assert.match(options.headers.Authorization, /^Bearer fixture-/);
    if (failWrite && options.method === 'POST') return { ok: false, status: 401 };
    return { ok: true, json: async () => ({ html_url: 'https://github.com/example/demo/issues/1#issuecomment-2' }) };
  } });
  return { request, calls, advance: () => { time += 3600000; } };
}

test('app JWT exchange, shared refresh, and comment requests use installation identity', async () => {
  const { request, calls, advance } = fixture();
  await Promise.all([request('repos/example/demo/issues/1/comments', { method: 'POST', body: { body: 'Comment' } }), request('repos/example/demo/pulls')]);
  assert.equal(calls.filter(call => call.endpoint.endsWith('/access_tokens')).length, 1);
  advance();
  await Promise.all([request('repos/example/demo/pulls'), request('repos/example/demo/pulls')]);
  assert.equal(calls.filter(call => call.endpoint.endsWith('/access_tokens')).length, 2);
  assert.equal(JSON.parse(calls.find(call => call.endpoint.endsWith('/comments')).options.body).body, 'Comment');
});
test('422 authentication and branch errors name the operation without exposing credentials', async () => {
  const failures = [];
  const make = endpointToFail => createAppRequest({ env, fetchImpl: async (url, options) => {
    const endpoint = url.replace('https://api.github.com/', '');
    failures.push({ endpoint, method: options.method });
    if (endpoint === endpointToFail) return { ok: false, status: 422, json: async () => ({
      message: 'secret error payload must never surface' }) };
    const value = endpoint === 'app' ? { slug: 'codex-pony' }
      : endpoint.endsWith('/installation') ? { id: 456 }
        : endpoint.endsWith('/access_tokens')
          ? { token: 'fixture', expires_at: new Date(Date.now() + 3600000).toISOString() } : {};
    return { ok: true, json: async () => value };
  } });
  await assert.rejects(make('app/installations/456/access_tokens')('repos/example/demo/pulls'), error => {
    assert.equal(error.status, 422);
    assert.match(error.message, /issuing an installation token/);
    assert.match(error.message, /retry after other App checks settle/);
    assert.doesNotMatch(error.message, /secret error payload/);
    assert.doesNotMatch(error.message, /fixture/);
    return true;
  });
  await assert.rejects(make('repos/example/demo/compare/main...draft')(
    'repos/example/demo/compare/main...draft'), error => {
    assert.equal(error.status, 422);
    assert.match(error.message, /comparing the published branches/);
    return true;
  });
  assert.equal(failures.filter(call => call.endpoint.endsWith('/access_tokens')).length, 2,
    'Failed installation-token issuance must not be silently retried');
});

test('status discovers all installations rather than using the user endpoint', async () => {
  const { request, calls } = fixture();
  const status = await createActions({ request }).status();
  assert.equal(status.githubLogin, 'codex-pony[bot]');
  assert.equal(status.githubAuth, 'app');
  assert(calls.some(call => call.endpoint.startsWith('app/installations?')));
  assert.equal(status.automaticInstallation, true);
  assert(!calls.some(call => call.endpoint === 'user'));
});
test('missing credentials and wrong app fail before repository writes', async () => {
  await assert.rejects(createAppRequest({ env: {}, fetchImpl: () => assert.fail('No API request expected') })('repos/example/demo/pulls'), /Configure KEFANIA/);
  const { request, calls } = fixture({ slug: 'different-app' });
  await assert.rejects(request('repos/example/demo/pulls', { method: 'POST' }), /must be codex-pony/);
  assert.equal(calls.length, 1);
});
test('a failed write is not retried and authentication is refreshed on the next call', async () => {
  const { request, calls } = fixture({ failWrite: true });
  await assert.rejects(request('repos/example/demo/issues/1/comments', { method: 'POST' }), /HTTP 401/);
  assert.equal(calls.filter(call => call.endpoint.endsWith('/comments')).length, 1);
  await request('repos/example/demo/pulls');
  assert.equal(calls.filter(call => call.endpoint.endsWith('/access_tokens')).length, 2);
});

test('automatic mode falls back before publishing when the app is unavailable', async () => {
  const { createGithubRequest } = await import('../src/github.js');
  const calls = [];
  const app = () => assert.fail('Unavailable app must not publish');
  app.status = async () => { throw new Error('Missing app setup'); };
  const request = createGithubRequest({ env: {}, appRequest: app, cliRequest: async (endpoint, options) => {
    calls.push({ endpoint, options });
    return endpoint === 'user' ? { login: 'example-user' } : { number: 42 };
  } });
  const result = await request('repos/example/demo/pulls', { method: 'POST' });
  assert.equal(result.number, 42);
  assert.equal(calls[0].endpoint, 'user');
  assert.equal(calls.filter(call => call.options?.method === 'POST').length, 1);
  assert.equal((await request.status()).fallbackFrom, 'app');
});
test('explicit app mode and uncertain app writes never fall back', async () => {
  const { createGithubRequest } = await import('../src/github.js');
  const app = async () => { throw new Error('Write timed out'); };
  app.status = async () => ({ githubAuth: 'app' });
  for (const mode of ['auto', 'app']) {
    const request = createGithubRequest({ env: { KEFANIA_GITHUB_AUTH: mode }, appRequest: app,
      cliRequest: () => assert.fail('Must not retry a write through gh') });
    await assert.rejects(request('repos/example/demo/pulls', { method: 'POST' }), /Write timed out/);
  }
});

test('bot routes each repository to its installation, shares tokens per installation, and lists all repositories', async () => {
  const authorizations = [], exchanges = [];
  const installations = [{ id: 11, account: { login: 'first' }, permissions: { contents: 'read', pull_requests: 'write' } },
    { id: 22, account: { login: 'second' }, permissions: {} }];
  const request = createAppRequest({ env, fetchImpl: async (url, options) => {
    const endpoint = url.replace('https://api.github.com/', '');
    const result = value => ({ ok: true, json: async () => value });
    if (endpoint === 'app') return result({ slug: 'codex-pony' });
    if (endpoint.startsWith('app/installations?')) return result(installations);
    if (endpoint === 'repos/first/project/installation') return result(installations[0]);
    if (endpoint === 'repos/second/project/installation') return result(installations[1]);
    if (endpoint === 'repos/missing/project/installation') return { ok: false, status: 404 };
    const id = endpoint.match(/^app\/installations\/(\d+)\/access_tokens$/)?.[1];
    if (id) {
      exchanges.push(id);
      return result({ token: 'fixture-installation-' + id, expires_at: new Date(Date.now() + 3600000).toISOString() });
    }
    const authorization = options.headers.Authorization;
    if (endpoint.startsWith('installation/repositories')) {
      const owner = authorization.endsWith('-11') ? 'first' : 'second';
      return result({ repositories: [{ full_name: owner + '/project' }] });
    }
    authorizations.push({ endpoint, authorization, method: options.method });
    return result({ number: 42 });
  } });
  await Promise.all([request('repos/first/project/pulls'), request('repos/second/project/pulls'), request('repos/first/project/commits/main')]);
  assert.deepEqual(exchanges.sort(), ['11', '22']);
  assert(authorizations.filter(item => item.endpoint.includes('/first/')).every(item => item.authorization.endsWith('-11')));
  assert(authorizations.filter(item => item.endpoint.includes('/second/')).every(item => item.authorization.endsWith('-22')));
  const repos = await request.repositories();
  assert.equal(repos.length, 2);
  assert.equal(repos[0].canCreatePullRequest, true, 'Bot can create PRs without Git push permission');
  assert.equal(repos[1].canCreatePullRequest, false);
  const status = await request.status();
  assert.equal(status.installations.length, 2);
  assert(status.installations[1].missingPermissions.includes('Pull requests: read/write'));
  const { createGithubRequest } = await import('../src/github.js');
  const automatic = createGithubRequest({ env: {}, appRequest: request,
    userRequest: Object.assign(() => assert.fail('Must not change author'), { status: () => assert.fail('Must not change author') }),
    cliRequest: () => assert.fail('Must not change author') });
  await assert.rejects(automatic('repos/missing/project/pulls', { method: 'POST' }), /Install codex-pony on this repository/);
  assert(!authorizations.some(item => item.method === 'POST'), 'Missing installation cannot publish');
});
