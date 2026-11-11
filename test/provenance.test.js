import assert from 'node:assert/strict';
import test from 'node:test';
import { createActions, descriptionBody, FOOTER } from '../src/pull-requests.js';

test('publishing an existing PR adds the supplied conversation once', async () => {
  const comments = [];
  let commentPosts = 0;
  const existing = {
    number: 42, html_url: 'https://github.com/example/demo/pull/42',
    head: { ref: 'topic', label: 'example:topic' }, base: { ref: 'main' }
  };
  const request = async (path, options = {}) => {
    if (path.startsWith('repos/example/demo/pulls?')) return [existing];
    if (path.startsWith('repos/example/demo/issues/42/comments?')) return comments;
    if (path === 'repos/example/demo/issues/42/comments' && options.method === 'POST') {
      commentPosts++;
      const item = { body: options.body.body, html_url: 'https://github.com/example/demo/pull/42#issuecomment-1' };
      comments.push(item);
      return item;
    }
    throw new Error('Unexpected request: ' + path);
  };
  const args = {
    owner: 'example', repo: 'demo', head: 'topic', base: 'main',
    source: {
      kind: 'chatgpt',
      uuid: '11111111-2222-4333-8444-555555555555',
      url: 'https://chatgpt.com/c/11111111-2222-4333-8444-555555555555',
      intentSummary: 'Explain a GitHub change'
    }
  };
  const actions = createActions({ request });
  const first = await actions.create(args);
  const second = await actions.create(args);
  assert.equal(first.existing, true);
  assert.equal(second.existing, true);
  assert.equal(second.review.status, 'unavailable');
  assert.equal(commentPosts, 1);
  assert.equal(second.source.existing, true);
  assert.match(comments[0].body, /11111111-2222-4333-8444-555555555555/);
  assert.match(comments[0].body, /Explain a GitHub change/);
});

test('PR description is unchanged and does not inject an image', () => {
  const description = descriptionBody('Summary of work.');
  assert.equal(description, 'Summary of work.');
  assert.equal(FOOTER, '');
});


test('Codex provenance emits named Markdown links and updates the original comment when shared', async () => {
  const comments = [];
  let posts = 0, patches = 0;
  const existing = {
    number: 42, html_url: 'https://github.com/example/demo/pull/42',
    head: { ref: 'topic', label: 'example:topic' }, base: { ref: 'main' }
  };
  const request = async (path, options = {}) => {
    if (path.startsWith('repos/example/demo/pulls?')) return [existing];
    if (path.startsWith('repos/example/demo/issues/42/comments?')) return comments;
    if (path === 'repos/example/demo/issues/42/comments' && options.method === 'POST') {
      posts++;
      const item = { id: 101, body: options.body.body, html_url: 'https://github.com/example/demo/pull/42#issuecomment-101' };
      comments.push(item);
      return item;
    }
    if (path === 'repos/example/demo/issues/comments/101' && options.method === 'PATCH') {
      patches++;
      comments[0].body = options.body.body;
      return comments[0];
    }
    throw new Error('Unexpected request: ' + path);
  };
  const uuid = '01a16743-8a10-7f91-b014-27af201bf264';
  const url = 'https://vscode.dev/redirect?url=' + encodeURIComponent(
    `vscode://jfwooten4.scm-toolkit-workspace-search/codex/${uuid}`);
  const source = { kind: 'codex', uuid, url };
  const actions = createActions({ request });
  await actions.create({ owner: 'example', repo: 'demo', head: 'topic', base: 'main', source });
  assert.equal(posts, 1);
  assert.match(comments[0].body, new RegExp(`\\[Open in Codex app\\]\\(codex://threads/${uuid}\\)`));
  assert(comments[0].body.includes(`[Open in VS Code](${url})`));
  assert(!comments[0].body.includes('View shared conversation'));
  const sharedUrl = 'https://chatgpt.com/s/cx_6adb2bd8052c8191a37230ab0c89afde';
  const updated = await actions.create({ owner: 'example', repo: 'demo', head: 'topic', base: 'main',
    source: { ...source, sharedUrl } });
  assert.equal(updated.source.updated, true);
  assert.equal(posts, 1);
  assert.equal(patches, 1);
  assert(comments[0].body.includes(`[View shared conversation](${sharedUrl})`));
  await actions.create({ owner: 'example', repo: 'demo', head: 'topic', base: 'main',
    source: { ...source, sharedUrl } });
  assert.equal(patches, 1, 'Identical provenance must not trigger a redundant edit');
});
