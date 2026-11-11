import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSetupServer } from '../src/setup-web.js';
import { loadPreferences, savePreferences, writingInstructions } from '../src/preferences.js';
import { CODEX_PONY_CLIENT_ID } from '../src/app-settings.js';
import { defaultOllamaSettings } from '../src/ollama-settings.js';

test('preferences persist and produce effective PR drafting instructions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kefania-settings-test-'));
  try {
    const path = join(directory, 'preferences.json');
    const original = await loadPreferences({ path });
    assert.equal(original.length, 'balanced');
    const changed = { length: 'concise', tone: 'conversational', instructions: 'Use short sentences.',
      repositories: ['example/demo'], selectedRepository: 'example/demo', clientId: 'Iv123456789',
      ollama: { ...defaultOllamaSettings(), model: 'chosen:model', temperature: 0.4 } };
    await savePreferences(changed, { path });
    assert.deepEqual(await loadPreferences({ path }), changed);
    assert.match(writingInstructions(await loadPreferences({ path })), /Use short sentences/);
    await assert.rejects(savePreferences({ ...changed, repositories: ['../../secret'] }, { path }), /valid repositories/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('fresh setup fills the public Client ID and connects without asking users to paste it', async () => {
  let settings = { length: 'balanced', tone: 'professional', instructions: '',
    repositories: [], selectedRepository: '', clientId: '' };
  let received;
  const server = createSetupServer({
    github: { status: async () => ({ githubLogin: 'alice', githubAuth: 'cli' }) },
    preferences: { load: async () => settings, save: async value => { settings = value; } },
    authorization: { start: async clientId => { received = clientId; return { userCode: 'ABCD-EFGH' }; } },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = 'http://127.0.0.1:' + server.address().port;
  try {
    const bootstrap = await (await fetch(address + '/api/bootstrap')).json();
    assert.equal(bootstrap.settings.clientId, process.env.KEFANIA_GITHUB_CLIENT_ID || CODEX_PONY_CLIENT_ID);
    const response = await fetch(address + '/api/connect', { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Kefania-CSRF': bootstrap.csrf }, body: '{}' });
    assert.equal(response.status, 200);
    assert.equal(received, bootstrap.settings.clientId);
    assert.equal(settings.clientId, received);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('Ollama model refresh uses local settings and requires the setup CSRF token', async () => {
  let received;
  const server = createSetupServer({
    github: { status: async () => ({ githubLogin: 'codex-pony[bot]', githubAuth: 'app' }) },
    preferences: { load: async () => ({ ollama: { ...defaultOllamaSettings(), model: 'saved:local' } }) },
    models: async settings => { received = settings; return ['installed:model']; },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = 'http://127.0.0.1:' + server.address().port;
  try {
    const bootstrap = await (await fetch(address + '/api/bootstrap')).json();
    const post = headers => fetch(address + '/api/ollama/models', { method: 'POST', headers,
      body: JSON.stringify({ baseUrl: 'http://localhost:11435' }) });
    assert.equal((await post({})).status, 403);
    const response = await post({ 'X-Kefania-CSRF': bootstrap.csrf });
    assert.deepEqual(await response.json(), { models: ['installed:model'] });
    assert.equal(received.baseUrl, 'http://localhost:11435');
    assert.equal(received.model, 'saved:local');
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('setup exposes working UI, status, repos, CSRF and safe preview without GitHub PR writes', async () => {
  let settings = { length: 'balanced', tone: 'professional', instructions: '',
    repositories: ['example/demo'], selectedRepository: 'example/demo', clientId: 'Iv123456789' };
  const used = [];
  let resets = 0;
  const server = createSetupServer({
    github: {
      status: async () => ({ githubLogin: 'alice', githubAuth: 'user' }),
      repositories: async () => [{ full_name: 'example/demo', permissions: { push: true } }],
      reset: () => { resets++; },
    },
    authorization: {
      start: async () => ({ userCode: 'ABCD-EFGH', verificationUrl: 'https://github.com/login/device', pollAfterMs: 5000 }),
      poll: async () => ({ connected: true }),
      disconnect: async () => {},
    },
    preferences: { load: async () => settings, save: async value => { settings = value; return value; } },
    draftPr: async input => {
      used.push(input);
      if (!input.draftOnly) assert.fail('Do not create real PRs in UI tests');
      return { title: '🔧 Preview', body: 'No footer.', published: false };
    },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = 'http://127.0.0.1:' + server.address().port;
  try {
    const html = await (await fetch(address)).text();
    assert.match(html, /Connect GitHub/);
    assert.match(html, /Writing style/);
    const bootstrap = await (await fetch(address + '/api/bootstrap')).json();
    assert.equal(bootstrap.connection.githubLogin, 'alice');
    assert(!JSON.stringify(bootstrap).includes('github_token'));
    const repos = await (await fetch(address + '/api/repositories')).json();
    assert.equal(repos.repositories[0].name, 'example/demo');
    assert.equal(resets, 1, 'Repository refresh must reload credentials and installation permissions');
    const post = (endpoint, body, headers = {}) => fetch(address + '/api/' + endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json',
        'X-Kefania-CSRF': bootstrap.csrf, ...headers }, body: JSON.stringify(body) });
    assert.equal((await post('preferences', { ...settings, tone: 'formal' }, { 'X-Kefania-CSRF': 'bad' })).status, 403);
    assert.equal((await post('preferences', { ...settings, tone: 'formal' })).status, 200);
    assert.equal(settings.tone, 'formal');
    const preview = await (await post('pr', { repository: 'example/demo', head: 'feature', base: 'main', preview: true })).json();
    assert.equal(preview.body, 'No footer.');
    assert.equal(used.length, 1);
    assert.equal(used[0].draftOnly, true);
    const upstreamPreview = await (await post('pr', { upstreamRepository: 'upstream/project',
      headRepository: 'contributor/project', head: 'fix-bug', base: 'main', preview: true })).json();
    assert.equal(upstreamPreview.body, 'No footer.');
    assert.equal(used[1].repository, 'upstream/project');
    assert.equal(used[1].headRepository, 'contributor/project');
    assert.equal(used[1].draftOnly, true);
    assert.equal((await post('pr', { upstreamRepository: 'upstream/project', head: 'fix-bug',
      base: 'main', preview: true })).status, 400, 'An upstream must have an explicit fork');
    const connect = await (await post('connect', { clientId: 'Iv123456789' })).json();
    assert.equal(connect.userCode, 'ABCD-EFGH');
    const poll = await (await post('poll', {})).json();
    assert.equal(poll.connected, true);
    assert.equal(resets, 2);
    assert.equal((await fetch(address + '/api/bootstrap', { headers: { Origin: 'https://evil.example' } })).status, 403);
  } finally { await new Promise(resolve => server.close(resolve)); }
});


test('Sweetiebot setup routes require CSRF and a saved authorized repository', async () => {
  const actions = [];
  const settings = { repositories: ['blocktransfer/SEC-publications'] };
  const server = createSetupServer({
    github: { status: async () => ({ githubLogin: 'alice', githubAuth: 'cli' }) },
    preferences: { load: async () => settings },
    sweetiebot: {
      check: async input => { actions.push(['check', input]); return { ready: false, linkState: 'missing' }; },
      repair: async input => { actions.push(['repair', input]); return { ready: true, linkState: 'ready' }; },
      update: async input => { actions.push(['update', input]); return { ready: true, linkState: 'ready' }; },
    },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = 'http://127.0.0.1:' + server.address().port;
  try {
    const bootstrap = await (await fetch(address + '/api/bootstrap')).json();
    const call = (action, repository, csrf) => fetch(address + '/api/sweetiebot/' + action, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Kefania-CSRF': csrf },
      body: JSON.stringify({ repository, checkoutPath: '/Users/GitHub/blocktransfer/SEC-publications' }),
    });
    assert.equal((await call('repair', 'blocktransfer/SEC-publications', 'bad')).status, 403);
    assert.equal((await call('update', 'other/repo', bootstrap.csrf)).status, 400);
    assert.equal(actions.length, 0);
    assert.equal((await call('check', 'blocktransfer/SEC-publications', bootstrap.csrf)).status, 200);
    assert.equal((await call('repair', 'blocktransfer/SEC-publications', bootstrap.csrf)).status, 200);
    assert.deepEqual(actions.map(([action]) => action), ['check', 'repair']);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('hosted routes require CSRF and do not call local drafting', async () => {
  const actions = [];
  const server = createSetupServer({
    github: { status: async () => ({ githubLogin: 'tester', githubAuth: 'cli' }) },
    preferences: { load: async () => ({ repositories: [] }) },
    hosted: {
      deploy: async input => { actions.push('deploy'); return { serviceArn: 'example' }; },
      activate: async input => { actions.push('activate'); return { mcpUrl: 'https://example/mcp' }; },
    },
    draftPr: async () => { assert.fail('Local drafter must not run'); },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const csrf = (await (await fetch(base + '/api/bootstrap')).json()).csrf;
    const call = (route, token) => fetch(base + '/api/hosted/' + route, {
      method: 'POST', headers: { 'X-Kefania-CSRF': token }, body: '{}',
    });
    assert.equal((await call('deploy', 'bad')).status, 403);
    assert.deepEqual(actions, []);
    assert.equal((await call('deploy', csrf)).status, 200);
    assert.equal((await call('activate', csrf)).status, 200);
    assert.deepEqual(actions, ['deploy', 'activate']);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
