import test from 'node:test';
import assert from 'node:assert/strict';
import { registerPublishedStack } from '../src/stack-registration.js';
import { createActions } from '../src/pull-requests.js';

const root = 'repos/pony-factor/kefania';
const repository = 'pony-factor/kefania';
const sha = char => char.repeat(40);
const pull = (number, head, base, letter) => ({
  number, state: 'open', merged_at: null,
  html_url: 'https://github.com/' + repository + '/pull/' + number,
  head: { ref: head, sha: sha(letter),
    repo: { full_name: repository }, label: 'pony-factor:' + head },
  base: { ref: base, repo: { full_name: repository } }
});
const parent = pull(10, 'parent', 'main', 'a');
const child = pull(11, 'child', 'parent', 'b');
const grandchild = pull(12, 'grandchild', 'child', 'c');

function fixture({ prs = [parent, child], stacks = [], failPost = false } = {}) {
  const calls = [];
  const native = structuredClone(stacks);
  const api = async (endpoint, options = {}) => {
    calls.push({ endpoint, ...options });
    if (endpoint.startsWith(root + '/compare/')) {
      const refs = endpoint.slice((root + '/compare/').length).split('...');
      const from = prs.find(pr => pr.head.sha === refs[0]);
      const to = prs.find(pr => pr.head.sha === refs[1]);
      return { merge_base_commit: { sha: from?.head.sha }, ahead_by: to ? 1 : 0 };
    }
    if (endpoint.startsWith(root + '/stacks?')) {
      const number = Number(new URLSearchParams(endpoint.split('?')[1]).get('pull_request'));
      return native.filter(stack => stack.pull_requests.some(pr => pr.number === number));
    }
    if (endpoint === root + '/stacks' && options.method === 'POST') {
      if (failPost) throw Error('HTTP 409 conflict');
      const stack = { number: 77, pull_requests: options.body.pull_requests.map(number => ({ number })) };
      native.push(stack);
      return stack;
    }
    if (endpoint.endsWith('/add') && options.method === 'POST') {
      if (failPost) throw Error('HTTP 409 conflict');
      const num = Number(endpoint.match(/\/stacks\/(\d+)\/add$/)?.[1]);
      const stack = native.find(item => item.number === num);
      if (!stack) throw Error('Unknown stack');
      stack.pull_requests.push(...options.body.pull_requests.map(number => ({ number })));
      return stack;
    }
    if (endpoint === root + '/pulls?state=open&per_page=100&page=1') return prs;
    if (endpoint.startsWith(root + '/pulls/')) {
      const number = Number(endpoint.split('/').at(-1));
      const pr = prs.find(item => item.number === number);
      if (!pr) throw Error('PR not found');
      return pr;
    }
    throw Error('Unexpected request: ' + endpoint);
  };
  return { api, calls, native };
}
const registration = (f, published) => registerPublishedStack({ api: f.api, root, repository, published });
const posts = calls => calls.filter(call => call.method === 'POST');

test('registers a linear pair through the GitHub App REST API, with verified ordered membership', async () => {
  const f = fixture();
  const result = await registration(f, child);
  assert.deepEqual(result, { status: 'linked', stackNumber: 77, pullRequests: [10, 11] });
  assert.equal(posts(f.calls).length, 1);
  assert.equal(posts(f.calls)[0].endpoint, root + '/stacks');
  assert.deepEqual(posts(f.calls)[0].body, { pull_requests: [10, 11] });
  const again = await registration(f, child);
  assert.equal(again.status, 'already-linked');
  assert.equal(posts(f.calls).length, 1, 'Repeated publication must not create another stack');
});

test('appends a new child to the existing native stack top, without creating a new stack', async () => {
  const stack = { number: 8, pull_requests: [{ number: 10 }, { number: 11 }] };
  const f = fixture({ prs: [parent, child, grandchild], stacks: [stack] });
  const result = await registration(f, grandchild);
  assert.deepEqual(result, { status: 'linked', stackNumber: 8, pullRequests: [10, 11, 12] });
  assert.deepEqual(posts(f.calls).map(call => [call.endpoint, call.body]),
    [[root + '/stacks/8/add', { pull_requests: [12] }]]);
});

test('reusing a lower layer already in a longer native stack preserves its membership', async () => {
  const stack = { number: 8, pull_requests: [{ number: 10 }, { number: 11 }, { number: 12 }] };
  const f = fixture({ prs: [parent, child, grandchild], stacks: [stack] });
  const result = await registration(f, child);
  assert.equal(result.status, 'already-linked');
  assert.deepEqual(result.pullRequests, [10, 11, 12]);
  assert.equal(posts(f.calls).length, 0);
});

test('creates an ordered stack from the whole verified unlinked branch chain', async () => {
  const f = fixture({ prs: [parent, child, grandchild] });
  const result = await registration(f, grandchild);
  assert.deepEqual(result.pullRequests, [10, 11, 12]);
  assert.deepEqual(posts(f.calls)[0].body.pull_requests, [10, 11, 12]);
});

test('leaves parallel siblings independent instead of inventing a single linear stack', async () => {
  const sibling = pull(13, 'sibling', 'parent', 'd');
  const f = fixture({ prs: [parent, child, sibling] });
  const result = await registration(f, child);
  assert.equal(result.status, 'skipped');
  assert.match(result.reason, /multiple open child/);
  assert.equal(posts(f.calls).length, 0);
});

test('does not register a branch without an open PR parent', async () => {
  const f = fixture({ prs: [child] });
  const result = await registration(f, child);
  assert.equal(result.status, 'not-applicable');
  assert.equal(posts(f.calls).length, 0);
});

test('requires up-to-date ancestry and same-repository refs', async () => {
  const stale = fixture({ prs: [parent, child] });
  const bad = await registration({
    ...stale, api: async (endpoint, opts) => endpoint.includes('/compare/')
      ? { merge_base_commit: { sha: sha('f') }, ahead_by: 5 }
      : stale.api(endpoint, opts)
  }, child);
  assert.equal(bad.status, 'skipped');
  assert.match(bad.reason, /restack/);
  const fork = { ...child, head: { ...child.head, repo: { full_name: 'someone/fork' } } };
  assert.equal((await registration(stale, fork)).status, 'skipped');
  assert.equal(posts(stale.calls).length, 0);
});

test('does not insert in the middle of or overwrite a different native stack', async () => {
  const stack = { number: 8, pull_requests: [{ number: 10 }, { number: 99 }] };
  const f = fixture({ prs: [parent, child], stacks: [stack] });
  const result = await registration(f, child);
  assert.equal(result.status, 'skipped');
  assert.equal(posts(f.calls).length, 0);
});

test('registration failure never creates another PR and reports safe retry', async () => {
  const f = fixture({ failPost: true });
  const result = await registration(f, child);
  assert.equal(result.status, 'failed');
  assert.match(result.reason, /Retry registration only/);
  assert.equal(posts(f.calls).length, 1);
  const action = createActions({ request: f.api, allowedRepositories: [repository] });
  const retried = await action.stack({ owner: 'pony-factor', repo: 'kefania', number: 11 });
  assert.equal(retried.number, 11);
  assert.equal(retried.status, 'failed');
  assert(posts(f.calls).every(call => !call.endpoint.endsWith('/pulls')));
});

test('explicit MCP action validates repository permission scope before any request', async () => {
  const action = createActions({ request: () => assert.fail('No network for out-of-scope repositories'),
    allowedRepositories: [repository] });
  await assert.rejects(action.stack({ owner: 'pony-factor', repo: 'other', number: 11 }), /not in/);
});

test('automatic publisher-side hook links native stacks and returns verified membership', async () => {
  const current = [parent, child];
  const f = fixture({ prs: current });
  const api = async (endpoint, options = {}) => {
    if (endpoint === root + '/commits/child') return { sha: child.head.sha };
    if (endpoint.startsWith(root + '/compare/parent...child')) return {
      ahead_by: 1, head_commit: { sha: child.head.sha }, base_commit: { sha: parent.head.sha },
      merge_base_commit: { sha: parent.head.sha }, files: [], total_commits: 1, commits: [{}]
    };
    if (endpoint.startsWith(root + '/pulls?') && endpoint.includes('head=pony-factor%3Achild')) {
      return options.method ? [] : current.filter(pr => pr.number === 11);
    }
    if (endpoint.startsWith(root + '/pulls?state=closed')) return [];
    if (endpoint.endsWith('/issues/11/comments?per_page=100&page=1')) return [];
    if (endpoint === root + '/pulls/11' && options.method === 'PATCH') return child;
    if (endpoint === root + '/pulls' && options.method === 'POST') return child;
    return f.api(endpoint, options);
  };
  const actions = createActions({ request: api, allowedRepositories: [repository] });
  const published = await actions.create({ owner: 'pony-factor', repo: 'kefania',
    head: 'child', base: 'parent', expectedHeadSha: child.head.sha,
    title: '🔧 Child feature', body: 'Child-only changes' });
  assert.equal(published.existing, true);
  assert.equal(published.stack.status, 'linked');
  assert.equal(posts(f.calls).length, 1);
});

test('newly published child PR uses the same automatic stack registration as reused PRs', async () => {
  const prs = [parent];
  const f = fixture({ prs });
  let created = false;
  const api = async (endpoint, options = {}) => {
    if (endpoint === root + '/commits/child') return { sha: child.head.sha };
    if (endpoint.startsWith(root + '/compare/parent...child')) return {
      ahead_by: 1, head_commit: { sha: child.head.sha }, base_commit: { sha: parent.head.sha },
      merge_base_commit: { sha: parent.head.sha }, files: [], total_commits: 1, commits: [{}]
    };
    if (endpoint.startsWith(root + '/pulls?') && endpoint.includes('head=pony-factor%3Achild')) {
      return created ? [child] : [];
    }
    if (endpoint.startsWith(root + '/pulls?state=closed')) return [];
    if (endpoint === root + '/pulls' && options.method === 'POST') {
      created = true;
      prs.push(child);
      return child;
    }
    if (endpoint === root + '/pulls?state=open&per_page=100&page=1') {
      return created ? [parent, child] : [parent];
    }
    return f.api(endpoint, options);
  };
  const actions = createActions({ request: api, allowedRepositories: [repository] });
  const published = await actions.create({ owner: 'pony-factor', repo: 'kefania',
    head: 'child', base: 'parent', expectedHeadSha: child.head.sha,
    title: '🔧 New child feature', body: 'Child changes' });
  assert.equal(published.existing, false);
  assert.equal(published.stack.status, 'linked');
  assert.deepEqual(published.stack.pullRequests, [10, 11]);
  assert.equal(posts(f.calls).length, 1);
});
