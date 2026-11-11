import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeviceAuthorization, createUserRequest } from '../src/user-auth.js';
import { createGithubRequest } from '../src/github.js';

test('device login never returns bearer or device secret to the browser', async () => {
  let now = 1000000, stored, calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const fields = new URLSearchParams(options.body);
    assert.equal(options.method, 'POST');
    if (url.endsWith('/device/code')) {
      assert.equal(fields.get('client_id'), 'Iv123456789');
      return { ok: true, json: async () => ({
        device_code: 'device-secret-only-on-server', user_code: 'ABCD-EFGH', interval: 5, expires_in: 900,
      }) };
    }
    assert.equal(fields.get('device_code'), 'device-secret-only-on-server');
    return { ok: true, json: async () => ({ access_token: 'fixture-token-never-to-browser',
      refresh_token: 'fixture-refresh', expires_in: 28800 }) };
  };
  const auth = createDeviceAuthorization({ fetchImpl, now: () => now, save: async session => { stored = session; }, clear: async () => {} });
  const start = await auth.start('Iv123456789');
  assert.equal(start.userCode, 'ABCD-EFGH');
  assert.equal(start.verificationUrl, 'https://github.com/login/device');
  assert(!JSON.stringify(start).includes('secret'));
  assert.equal((await auth.poll()).pending, true);
  assert.equal(calls.length, 1, 'Do not poll GitHub before its allowed interval');
  now += 5000;
  const complete = await auth.poll();
  assert.deepEqual(complete, { connected: true });
  assert.equal(stored.accessToken, 'fixture-token-never-to-browser');
  assert(!JSON.stringify(complete).includes('token'));
});

test('slow-down responses delay GitHub polling and authorization rejection stays readable', async () => {
  let now = 1000000, pollCount = 0;
  const fetchImpl = async url => ({ ok: true, json: async () => url.endsWith('/device/code')
    ? { device_code: 'private', user_code: 'ABCD-EFGH', interval: 5, expires_in: 900 }
    : (++pollCount === 1 ? { error: 'slow_down', interval: 10 } : { error: 'access_denied' }) });
  const auth = createDeviceAuthorization({ fetchImpl, now: () => now });
  await auth.start('Iv123456789');
  now += 5000;
  assert.equal((await auth.poll()).pollAfterMs, 10000);
  now += 9000;
  assert.equal((await auth.poll()).pending, true);
  assert.equal(pollCount, 1);
  now += 1000;
  await assert.rejects(auth.poll(), /declined/);
});

test('user API refreshes an expiring device-flow session and never retries failed writes', async () => {
  let now = 1000000, saved, writes = 0;
  const session = { clientId: 'Iv123456789', accessToken: 'old', refreshToken: 'refresh',
    expiresAt: now + 1000 };
  const request = createUserRequest({ now: () => now, load: async () => saved || session,
    save: async value => { saved = value; }, fetchImpl: async (url, options) => {
      if (url.endsWith('/login/oauth/access_token')) {
        assert.equal(new URLSearchParams(options.body).get('refresh_token'), 'refresh');
        return { ok: true, json: async () => ({ access_token: 'new', refresh_token: 'rotated', expires_in: 28800 }) };
      }
      assert.equal(options.headers.Authorization, 'Bearer new');
      if (options.method === 'POST') { writes++; return { ok: false, status: 401 }; }
      return { ok: true, json: async () => ({ login: 'alice' }) };
    } });
  assert.equal((await request.status()).githubLogin, 'alice');
  await assert.rejects(request('repos/example/project/pulls', { method: 'POST', body: { title: 'test' } }), /HTTP 401/);
  assert.equal(writes, 1);
  assert.equal(saved.refreshToken, 'rotated');
});

test('automatic auth prefers the user even with a working App bot and resets cleanly', async () => {
  const calls = [];
  const user = async endpoint => { calls.push(endpoint); return { repositories: [{ full_name: 'alice/project' }] }; };
  user.status = async () => ({ githubAuth: 'user', githubLogin: 'alice' });
  user.repositories = async () => [{ full_name: 'alice/project' }];
  const app = async () => assert.fail('Should not use bot');
  app.status = async () => assert.fail('Should not select bot');
  const request = createGithubRequest({ env: {}, userRequest: user, appRequest: app,
    cliRequest: () => assert.fail('Should not use gh') });
  assert.equal((await request.status()).githubAuth, 'user');
  assert.equal((await request.repositories())[0].full_name, 'alice/project');
  await request('repos/alice/project/pulls', { method: 'POST' });
  assert.equal(calls.at(-1), 'repos/alice/project/pulls');
  request.reset();
  assert.equal((await request.status()).githubLogin, 'alice');
});

test('automatic auth falls back to the App bot when user authorization is unavailable', async () => {
  const calls = [];
  const user = async () => assert.fail('Unavailable user must not publish');
  user.status = async () => { throw new Error('User connection missing'); };
  const app = async endpoint => { calls.push(endpoint); return { repositories: [{ full_name: 'example/project' }] }; };
  app.status = async () => ({ githubAuth: 'app', githubLogin: 'codex-pony[bot]' });
  const request = createGithubRequest({ env: { KEFANIA_GITHUB_AUTH: 'auto' }, userRequest: user,
    appRequest: app, cliRequest: () => assert.fail('Should not use gh') });
  assert.equal((await request.status()).githubAuth, 'app');
  assert.equal((await request.status()).fallbackFrom, 'user');
  assert.equal((await request.repositories())[0].full_name, 'example/project');
  await request('repos/example/project/pulls', { method: 'POST' });
  assert.equal(calls.at(-1), 'repos/example/project/pulls');
  request.reset();
  assert.equal((await request.status()).githubLogin, 'codex-pony[bot]');
});

test('automatic auth falls back to gh only when both App identities are unavailable', async () => {
  const user = async () => assert.fail('Unavailable user must not publish');
  user.status = async () => { throw new Error('User connection missing'); };
  const app = async () => assert.fail('Unavailable bot must not publish');
  app.status = async () => { throw new Error('Missing app setup'); };
  const calls = [];
  const cli = async endpoint => { calls.push(endpoint); return endpoint === 'user'
    ? { login: 'alice' } : { ok: true }; };
  const request = createGithubRequest({ env: {}, userRequest: user, appRequest: app, cliRequest: cli });
  assert.equal((await request.status()).githubAuth, 'cli');
  assert.equal((await request.status()).fallbackFrom, 'user');
  await request('repos/alice/project/pulls', { method: 'POST' });
  assert.equal(calls.at(-1), 'repos/alice/project/pulls');
});

test('explicit App mode still publishes as the bot with a valid user connection', async () => {
  const user = async () => assert.fail('Must not use user');
  user.status = async () => ({ githubAuth: 'user', githubLogin: 'alice' });
  const calls = [];
  const app = async endpoint => { calls.push(endpoint); return { ok: true }; };
  app.status = async () => ({ githubAuth: 'app', githubLogin: 'codex-pony[bot]' });
  const request = createGithubRequest({ env: { KEFANIA_GITHUB_AUTH: 'app' }, userRequest: user,
    appRequest: app, cliRequest: () => assert.fail('Must not use gh') });
  assert.equal((await request.status()).githubAuth, 'app');
  await request('repos/example/project/pulls', { method: 'POST' });
  assert.equal(calls.at(-1), 'repos/example/project/pulls');
});

test('explicit user mode bypasses the bot and failed user writes never change identity', async () => {
  const user = async () => { throw new Error('Write timed out'); };
  user.status = async () => ({ githubAuth: 'user', githubLogin: 'alice' });
  const app = async () => assert.fail('Must not replay write as bot');
  app.status = async () => { throw new Error('Missing app setup'); };
  for (const mode of ['auto', 'user']) {
    const request = createGithubRequest({ env: { KEFANIA_GITHUB_AUTH: mode }, appRequest: app,
      userRequest: user, cliRequest: () => assert.fail('Must not replay write through gh') });
    await assert.rejects(request('repos/alice/project/pulls', { method: 'POST' }), /Write timed out/);
    assert.equal((await request.status()).githubAuth, 'user');
  }
});
