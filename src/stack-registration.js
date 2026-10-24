// GitHub-native stacks contain linear, same-repository PR chains.
// This module only registers existing pull requests; it never creates PRs,
// retargets branches, rewrites history, or merges a stack.
const MAX_OPEN_PAGES = 10;
const MAX_CHAIN_LENGTH = 50;
const sha = /^[0-9a-f]{40}$/i;

const name = pr => pr?.head?.repo?.full_name?.toLowerCase();
const ref = pr => pr?.head?.ref;
const isOpen = pr => pr?.state === 'open' && !pr?.merged_at;

function result(status, details = {}) { return { status, ...details }; }

async function openPulls(api, root) {
  const entries = [];
  for (let page = 1; page <= MAX_OPEN_PAGES; page++) {
    const prs = await api(root + '/pulls?state=open&per_page=100&page=' + page);
    if (!Array.isArray(prs)) throw new Error('GitHub returned an invalid open pull-request list.');
    entries.push(...prs);
    if (prs.length < 100) return entries;
  }
  throw new Error('Cannot verify the complete set of open PR dependencies.');
}

async function findStack(api, root, number) {
  const stacks = await api(root + '/stacks?pull_request=' + number + '&per_page=100');
  if (!Array.isArray(stacks) || stacks.length > 1) throw new Error('GitHub returned ambiguous stack membership.');
  return stacks[0];
}

function members(stack) {
  const list = stack?.pull_requests;
  if (!Array.isArray(list) || !list.length || list.some(pr => !Number.isSafeInteger(pr.number)))
    throw new Error('GitHub returned incomplete stack membership.');
  return list.map(pr => pr.number);
}

export async function registerPublishedStack({ api, root, repository, published }) {
  if (!/^repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(root)
      || repository.toLowerCase() !== root.slice('repos/'.length).toLowerCase()
      || !Number.isSafeInteger(published?.number) || published.number < 1) {
    throw new Error('Invalid stack registration target.');
  }
  // GitHub-native stacks never span forks. Do not infer ownership from a ref name.
  if (name(published) !== repository.toLowerCase() ||
      published.base?.repo?.full_name?.toLowerCase() !== repository.toLowerCase()) {
    return result('skipped', { reason: 'Native stacks require both PR branches in the same repository.' });
  }
  if (!isOpen(published) || !ref(published) || !published.base?.ref || !sha.test(published.head.sha || '')) {
    return result('skipped', { reason: 'The PR must be open with verifiable head and base refs.' });
  }

  const opened = await openPulls(api, root);
  const ancestry = [published];
  const seen = new Set([published.number]);
  let child = published;
  for (let depth = 0; depth < MAX_CHAIN_LENGTH; depth++) {
    const parents = opened.filter(pr => pr.number !== child.number &&
      isOpen(pr) && name(pr) === repository.toLowerCase() && ref(pr) === child.base.ref);
    if (!parents.length) break;
    if (parents.length !== 1) return result('skipped', { reason: 'Multiple parent PRs share the same base branch.' });
    const parent = parents[0];
    if (seen.has(parent.number)) return result('skipped', { reason: 'Cyclic PR dependencies cannot form a stack.' });
    const siblings = opened.filter(pr => pr.number !== child.number && isOpen(pr) &&
      pr.base?.ref === parent.head.ref && pr.head?.repo?.full_name?.toLowerCase() === repository.toLowerCase());
    if (siblings.length) return result('skipped', {
      reason: 'The parent has multiple open child PRs. Keep this fan-out independent instead of inventing a linear stack.'
    });
    if (!sha.test(parent.head.sha || '')) return result('skipped', { reason: 'The parent head SHA could not be verified.' });
    const comparison = await api(root + '/compare/' + parent.head.sha + '...' + child.head.sha);
    if (comparison.merge_base_commit?.sha !== parent.head.sha || !(comparison.ahead_by > 0)) {
      return result('skipped', { reason: 'The child does not contain its current parent HEAD; restack the branch before linking.' });
    }
    ancestry.unshift(parent);
    seen.add(parent.number);
    child = parent;
  }
  if (ancestry.length === MAX_CHAIN_LENGTH) {
    const upper = ancestry[0];
    if (opened.some(pr => pr.number !== upper.number && isOpen(pr) &&
      name(pr) === repository.toLowerCase() && ref(pr) === upper.base.ref)) {
      return result('skipped', { reason: 'PR ancestry exceeds the safe stack depth.' });
    }
  }
  if (ancestry.length === 1) return result('not-applicable', { reason: 'No open parent PR targets this branch.' });

  const numbers = ancestry.map(pr => pr.number);
  const childStack = await findStack(api, root, published.number);
  if (childStack) {
    const actual = members(childStack);
    return actual.join(',') === numbers.join(',')
      ? result('already-linked', { stackNumber: childStack.number, pullRequests: actual })
      : result('skipped', { reason: 'The PR is already registered in a different stack; no changes made.' });
  }

  // A parent might be the top layer of an existing stack. We may append only
  // to that top, never insert into a stack or overwrite its sibling ordering.
  const parent = ancestry.at(-2);
  const parentStack = await findStack(api, root, parent.number);
  let endpoint, proposed;
  if (parentStack) {
    const registered = members(parentStack);
    if (registered.at(-1) !== parent.number ||
        registered.join(',') !== numbers.slice(0, -1).join(',')) {
      return result('skipped', { reason: 'Parent membership is not the verified linear prefix of this stack.' });
    }
    endpoint = root + '/stacks/' + parentStack.number + '/add';
    proposed = [published.number];
  } else {
    // Do not try to overlap an unrecognized native stack farther down the chain.
    for (const ancestor of ancestry.slice(0, -2)) {
      if (await findStack(api, root, ancestor.number)) {
        return result('skipped', { reason: 'An ancestor belongs to a separate native stack.' });
      }
    }
    endpoint = root + '/stacks';
    proposed = numbers;
  }

  let error;
  try {
    await api(endpoint, { method: 'POST', body: { pull_requests: proposed } });
  } catch (failure) {
    error = failure;
    // A concurrent linker may already have succeeded. Never retry a
    // potentially completed write; just re-read GitHub's recorded membership.
  }
  let linked;
  try { linked = await findStack(api, root, published.number); }
  catch (failure) {
    return result('unverified', { reason: 'Stack registration may have completed, but verification failed: ' + failure.message });
  }
  if (linked && members(linked).join(',') === numbers.join(',')) {
    return result(error ? 'already-linked' : 'linked', {
      stackNumber: linked.number, pullRequests: numbers
    });
  }
  return result(error ? 'failed' : 'unverified', {
    reason: error
      ? 'The PR exists, but native stack registration failed: ' + error.message + '. Retry registration only.'
      : 'GitHub did not confirm the expected stack membership. Check GitHub before retrying.'
  });
}
