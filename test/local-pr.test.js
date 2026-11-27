import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runLocalPullRequest } from '../src/local-pr.js';

test('CLI executes through a symlinked checkout and reports invalid input', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kefania-entry-'));
  try {
    const checkout = join(directory, 'kefania');
    await symlink(fileURLToPath(new URL('../', import.meta.url)), checkout, 'dir');
    for (const runner of [fileURLToPath(new URL('../src/local-pr.js', import.meta.url)), join(checkout, 'src', 'local-pr.js')]) {
      const result = spawnSync(process.execPath, [runner], { input: '{}', encoding: 'utf8' });
      assert.equal(result.status, 1, result.stderr);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /repository/);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('local drafter passes the verified head and generated text to the gh publisher', async () => {
  const source = { kind: 'chatgpt', uuid: '11111111-2222-4333-8444-555555555555', url: 'https://chatgpt.com/c/11111111-2222-4333-8444-555555555555' };
  let published;
  const result = await runLocalPullRequest({ repository: 'owner/repo', head: 'branch', source }, {
    actions: {
      async context(selection) { assert.equal(selection.base, 'main'); return { aheadBy: 1, headSha: 'verified', files: [] }; },
      async create(args) { published = args; return { url: 'https://github.com/owner/repo/pull/1' }; },
    },
    async draft(prompt) { assert.match(prompt, /Do not publish anything or use tools/); assert.match(prompt, /Weave GitHub backreferences into the narrative/); return { title: '🛠️ Fix PR drafting', body: 'Explain the change.' }; },
  });
  assert.equal(published.expectedHeadSha, 'verified');
  assert.equal(published.title, '🛠️ Fix PR drafting');
  assert.deepEqual(published.source, source);
  assert.equal(published.draft, false);
  assert.equal(result.url, 'https://github.com/owner/repo/pull/1');
});

test('existing PR short-circuits both local drafting and browser context', async () => {
  const existingPullRequest = { number: 42, url: 'https://github.com/owner/repo/pull/42', base: 'release', head: 'branch' };
  const actions = {
    async context() { return { aheadBy: 0, existingPullRequest }; },
    async create() { assert.fail('Do not publish a second PR'); },
  };
  const draft = () => assert.fail('Do not start a model for an existing PR');
  const input = { repository: 'owner/repo', head: 'branch' };
  const context = await runLocalPullRequest({ ...input, contextOnly: true }, { actions, draft });
  assert.deepEqual(context.existingPullRequest, existingPullRequest);
  const result = await runLocalPullRequest(input, { actions, draft });
  assert.equal(result.existing, true);
  assert.equal(result.url, existingPullRequest.url);
});

test('draft-only performs no write and returns an unadorned description', async () => {
  const result = await runLocalPullRequest({ repository: 'owner/repo', head: 'branch', draftOnly: true }, {
    actions: { async context() { return { aheadBy: 1, headSha: 'verified' }; }, async create() { assert.fail('Must not publish'); } },
    async draft() { return { title: '🛠️ Fix PR drafting', body: 'Explain the change.' }; },
  });
  assert.equal(result.published, false);
  assert.equal(result.body, 'Explain the change.');
});

test('empty comparison and invalid model output cannot publish', async () => {
  const actions = { async context() { return { aheadBy: 0 }; }, async create() { assert.fail('Must not publish'); } };
  await assert.rejects(runLocalPullRequest({ repository: 'owner/repo', head: 'branch' }, { actions }), /committed changes/);
  actions.context = async () => ({ aheadBy: 1, headSha: 'verified' });
  await assert.rejects(runLocalPullRequest({ repository: 'owner/repo', head: 'branch' }, { actions, draft: async () => ({ title: 'Only title' }) }));
});

test('browser context and prepared drafts never invoke Codex and publish against the current head', async () => {
  const sha = 'a'.repeat(40);
  let writes = 0;
  const actions = { async context() { return { aheadBy: 1, headSha: sha, files: [] }; },
    async create(input) {
      writes++;
      assert.equal(input.expectedHeadSha, sha);
      assert.equal(input.title, '🔧 Improve setup');
      assert.equal(input.body, 'Explain the change with a verified source.');
      return { published: true };
    } };
  const dependencies = { actions, draft() { assert.fail('Browser drafting must not consume a Codex run'); } };
  const input = { repository: 'owner/repo', head: 'branch' };
  assert.equal((await runLocalPullRequest({ ...input, contextOnly: true }, dependencies)).headSha, sha);
  assert.equal(writes, 0);
  const preparedDraft = { title: '🔧 Improve setup', body: 'Explain the change with a verified source.' };
  await runLocalPullRequest({ ...input, preparedDraft, expectedHeadSha: sha }, dependencies);
  assert.equal(writes, 1);
  await assert.rejects(runLocalPullRequest({ ...input, preparedDraft }, dependencies), /verified head SHA/);
  const result = await runLocalPullRequest({ ...input, preparedDraft, expectedHeadSha: 'b'.repeat(40) }, dependencies);
  assert.equal(result.published, true);
  assert.equal(writes, 2);
});


test('local upstream publication exposes an immutable Sites handoff without writing DNS', async () => {
  const sha = 'a'.repeat(40);
  const existingPullRequest = { url: 'https://github.com/upstream/project/pull/7', number: 7 };
  let requests = 0;
  const actions = {
    async context() {
      requests++;
      return requests === 1
        ? { aheadBy: 1, headSha: sha, files: [] }
        : { aheadBy: 1, headSha: sha, existingPullRequest, files: [] };
    },
    async create() { return existingPullRequest; },
  };
  const result = await runLocalPullRequest({ repository: 'upstream/project',
    headRepository: 'person/project', head: 'feature/test', previewZone: 'example.com' }, {
    actions, async draft() { return { title: '🧪 Preview', body: 'Preview the branch.' }; },
  });
  assert.equal(result.url, existingPullRequest.url);
  assert.equal(result.preview.headSha, sha);
  assert.match(result.preview.hostname, /\.project\.preview\.example\.com$/);
  assert.equal(result.preview.siteDeployed, false);
  assert.equal(result.preview.dnsPublished, false);
  assert.equal(requests, 2);
});

test('local runner rejects preview zone on non-upstream PR before any GitHub write', async () => {
  const actions = { async context() { assert.fail('Invalid preview must not call GitHub'); },
    async create() { assert.fail('Invalid preview must not create PR'); } };
  await assert.rejects(runLocalPullRequest({
    repository: 'owner/project', head: 'feature', previewZone: 'example.com',
  }, { actions }), /upstream destination/);
});

test('Sites handoff failure does not hide an already published upstream PR', async () => {
  let requests = 0;
  const actions = {
    async context() {
      requests++;
      return requests === 1 ? { aheadBy: 1, headSha: 'a'.repeat(40) }
        : { aheadBy: 1, headSha: 'b'.repeat(40) };
    },
    async create() { return { url: 'https://github.com/upstream/project/pull/8' }; },
  };
  const result = await runLocalPullRequest({
    repository: 'upstream/project', headRepository: 'person/project',
    head: 'branch', previewZone: 'example.com',
  }, { actions, async draft() { return { title: '🧪 Preview', body: 'Explain the change.' }; } });
  assert.match(result.url, /pull\/8$/);
  assert.match(result.previewError, /Publish an upstream PR/);
});
