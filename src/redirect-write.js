// Deliberately limited to Wooten Link's append-only redirect registry.
export const redirectRepository = 'JFWooten4/JFWooten4';
const root = 'repos/' + redirectRepository;
const bot = { name: 'codex-pony[bot]', email: '326443430+codex-pony[bot]@users.noreply.github.com' };
const shaPattern = /^[0-9a-f]{40}$/;
const reserved = new Set(['search', 'search-index.json', 'api', 'codex', 'friends', 'assets', 'scripts', '404', '404.html', 'index', 'index.html', 'favicon.ico', 'robots.txt', 'sitemap.xml', 'feed.xml', 'legal', 'static', 'redirects']);
const fail = message => { throw new Error(message); };
export function validateRedirect(input) {
  if (!input || typeof input !== 'object' || Object.keys(input).some(k => !['key', 'href', 'comment'].includes(k))) fail('Invalid redirect fields.');
  const { key, href, comment = '' } = input;
  if (typeof key !== 'string' || !/^(?:[a-z0-9]|[_+][a-z0-9])[a-z0-9._-]{0,79}$/i.test(key)) fail('Invalid shortlink key.');
  if (typeof href !== 'string' || !href || href.length > 2048 || /[\s\\<>\u0000-\u001f\u007f]/u.test(href) || /%(?![a-f0-9]{2})/i.test(href)) fail('Invalid destination URL.');
  const relative = href.startsWith('/') && !href.startsWith('//') && !/^\/%(?:2f|5c)/i.test(href);
  if (!relative && !/^https?:\/\//i.test(href)) fail('Destination must be an HTTP(S) URL or a root-relative path.');
  let url;
  try { url = new URL(href, 'https://wooten.link'); } catch { fail('Invalid destination URL.'); }
  if (url.username || url.password || !['http:', 'https:'].includes(url.protocol)) fail('Invalid destination URL.');
  if (typeof comment !== 'string' || comment.length > 240 || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(comment)) fail('Invalid comment.');
  const canonical = key.toLowerCase();
  if (reserved.has(canonical)) fail('Reserved shortlink key.');
  return { key: canonical, href, comment };
}
function sectionOf(line) {
  const section = line.match(/^\s*\[redirects(?:\.("(?:\\.|[^"\\])*"))?\]\s*(?:#.*)?$/);
  if (section) return section[1] === undefined ? '' : JSON.parse(section[1]);
  if (/^\s*\[[A-Z][A-Z0-9_]*\]\s*(?:#.*)?$/.test(line)) return '';
  if (/^\s*\[/.test(line)) fail('Unsupported redirect registry table.');
  return null;
}
export function registryEntries(source) {
  let prefix = null;
  const entries = new Map();
  for (const line of source.split(/\r?\n/)) {
    const section = sectionOf(line);
    if (section !== null) { prefix = section; continue; }
    if (/^\s*(?:#.*)?$/.test(line)) continue;
    if (prefix === null) fail('Invalid redirect registry.');
    const match = line.match(/^\s*("(?:\\.|[^"\\])*")\s*=\s*("(?:\\.|[^"\\])*")\s*(?:#(.*))?$/);
    if (!match) fail('Invalid redirect registry entry.');
    const key = (prefix + JSON.parse(match[1])).toLowerCase();
    if (entries.has(key)) fail('Duplicate key in current redirect registry.');
    entries.set(key, JSON.parse(match[2]));
  }
  return entries;
}
export function appendMapping(registries, input, routeKeys = []) {
  const entry = validateRedirect(input);
  const all = new Set();
  for (const source of Object.values(registries)) {
    for (const key of registryEntries(source).keys()) {
      if (all.has(key)) fail('Duplicate key in current redirect registries.');
      all.add(key);
    }
  }
  if (all.has(entry.key)) fail('Shortlink already exists.');
  if (routeKeys.some(k => k.toLowerCase() === entry.key)) fail('Reserved shortlink key.');
  const prefix = /^[+_]/.test(entry.key) ? entry.key[0] : '';
  const path = prefix ? 'redirects/law.toml' : 'redirects/main.toml';
  const source = registries[path];
  if (typeof source !== 'string') fail('Required redirect registry is missing.');
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.split(newline);
  const heading = prefix ? '[redirects.' + JSON.stringify(prefix) + ']' : '[redirects]';
  const indexes = lines.flatMap((line, i) => line.trim().split(/\s+#/)[0] === heading ? [i] : []);
  if (indexes.length !== 1) fail('Required redirect table is missing or duplicated.');
  let end = indexes[0] + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
  while (end > indexes[0] + 1 && /^\s*$/.test(lines[end - 1])) end--;
  const mapping = JSON.stringify(entry.key.slice(prefix.length)) + ' = ' + JSON.stringify(entry.href) + (entry.comment ? ' # ' + entry.comment : '');
  lines.splice(end, 0, mapping);
  let content = lines.join(newline);
  if (!content.endsWith(newline)) content += newline;
  const updated = registryEntries(content);
  if (updated.size !== registryEntries(source).size + 1 || updated.get(entry.key) !== entry.href) fail('Redirect append verification failed.');
  return { ...entry, path, content, line: end + 1 };
}
function routeNames(tree, config) {
  const names = new Set(reserved);
  const add = value => {
    const part = String(value).split('/').filter(Boolean)[0];
    if (!part) return;
    names.add(part.toLowerCase());
    names.add(part.replace(/\.(html?|md|markdown)$/i, '').toLowerCase());
  };
  for (const item of tree) {
    add(item.path);
    if (item.path.startsWith('static/')) add(item.path.slice(7));
  }
  for (const rule of [...(config.rewrites || []), ...(config.redirects || []), ...(config.headers || [])]) {
    if (rule.source === '/:path*' && rule.destination === '/api/redirect') continue;
    const first = rule.source?.split('/').filter(Boolean)[0];
    if (!first || /[:*()[\]{}]/.test(first)) fail('Unrecognized route pattern; review redirect writer configuration.');
    add(first);
  }
  return [...names];
}
export async function verifiedActor({ auth, oauth, allowedRepositories }) {
  if (!auth.scopes.includes('kefania:redirect')) fail('Redirect permission is required.');
  if (!allowedRepositories.some(repo => repo.toLowerCase() === redirectRepository.toLowerCase())) fail('Redirect repository is not authorized.');
  const token = auth.extra.githubToken;
  const user = await oauth.github(token, 'user');
  if (String(user.id) !== String(auth.extra.user.id)) fail('GitHub identity changed.');
  const info = await oauth.github(token, root);
  if (!info.permissions?.push || info.archived || info.disabled) fail('Your GitHub account lacks repository write access.');
  const emails = await oauth.github(token, 'user/emails');
  // Never publish a private address or manufacture a GitHub noreply address.
  const eligible = emails.filter(email => email.verified && (email.visibility === 'public' || /@users\.noreply\.github\.com$/i.test(email.email)));
  const email = eligible.find(email => email.primary) || eligible[0];
  if (!email) fail('No verified public or GitHub-provided noreply author email is available.');
  const name = user.name || user.login;
  if (!name || /[\r\n<>]/.test(name)) fail('Invalid GitHub author name.');
  return { id: String(user.id), login: user.login, name, email: email.email };
}
const readBlob = async (request, item) => {
  if (!item || item.type !== 'blob' || !/^100(?:644|755)$/.test(item.mode) || item.size > 1024 * 1024) fail('Unsupported registry or route file.');
  const blob = await request(root + '/git/blobs/' + item.sha);
  if (blob.encoding !== 'base64' || blob.sha !== item.sha) fail('Invalid GitHub blob.');
  return Buffer.from(blob.content, 'base64').toString('utf8');
};
function assertCommit(commit, expected, actor, parent, tree) {
  if (commit.sha !== expected || commit.commit?.tree?.sha !== tree || commit.parents?.length !== 1 ||
      commit.parents[0].sha !== parent || commit.author?.login?.toLowerCase() !== actor.login.toLowerCase() ||
      commit.committer?.login !== bot.name || commit.commit?.author?.email !== actor.email ||
      commit.commit?.committer?.email !== bot.email) fail('GitHub commit attribution or tree verification failed.');
}
async function verifyBlame(request, sha, path, line, actor) {
  const response = await request('graphql', { method: 'POST', body: {
    query: 'query($sha:GitObjectID!,$path:String!){repository(owner:"JFWooten4",name:"JFWooten4"){object(oid:$sha){... on Commit{blame(path:$path){ranges{startingLine endingLine commit{oid author{user{login}}}}}}}}}',
    variables: { sha, path }
  } });
  const ranges = response.data?.repository?.object?.blame?.ranges;
  if (response.errors || !ranges?.some(range => range.startingLine <= line && range.endingLine >= line &&
      range.commit.oid === sha && range.commit.author?.user?.login?.toLowerCase() === actor.login.toLowerCase())) fail('GitHub blame attribution could not be verified.');
}
export async function writeRedirect({ request, actor, input, reauthorize }) {
  const branch = await request(root + '/branches/main');
  const rules = await request(root + '/rules/branches/main');
  if (branch.protected !== false || !Array.isArray(rules) || rules.length) fail('Main branch has protection or rules; direct saves are disabled.');
  const parent = branch.commit.sha, baseTree = branch.commit.commit.tree.sha;
  if (!shaPattern.test(parent) || !shaPattern.test(baseTree)) fail('Invalid main branch response.');
  const snapshot = await request(root + '/git/trees/' + baseTree + '?recursive=1');
  if (snapshot.truncated || !Array.isArray(snapshot.tree)) fail('Repository tree could not be fully inspected.');
  const items = snapshot.tree;
  const registries = Object.create(null);
  for (const item of items.filter(item => /^redirects\/[^/]+\.toml$/.test(item.path))) registries[item.path] = await readBlob(request, item);
  const config = JSON.parse(await readBlob(request, items.find(item => item.path === 'vercel.json')));
  const routes = routeNames(items, config);
  // Inspect custom Jekyll permalink declarations rather than relying only on file names.
  for (const item of items.filter(item => item.type === 'blob' && /^(?:static\/.*|[^/]+)\.(?:html?|md|markdown)$/i.test(item.path))) {
    const source = await readBlob(request, item);
    const front = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    const permalink = front?.[1].match(/^permalink:\s*['"]?\/([^/\s'"]+)/m);
    if (permalink) routes.push(permalink[1]);
  }
  const change = appendMapping(registries, input, routes);
  const blob = await request(root + '/git/blobs', { method: 'POST', body: { content: change.content, encoding: 'utf-8' } });
  const tree = await request(root + '/git/trees', { method: 'POST', body: { base_tree: baseTree, tree: [{ path: change.path, mode: '100644', type: 'blob', sha: blob.sha }] } });
  if (!shaPattern.test(tree.sha) || tree.sha === baseTree) fail('No meaningful redirect change.');
  const commit = await request(root + '/git/commits', { method: 'POST', body: {
    message: '🖍️ Add ' + change.key + ' shortlink\n\nAppend the ' + change.key + ' redirect to ' + change.path + '.\n\nCo-authored-by: ChatGPT 6.2 <noreply@openai.com>',
    tree: tree.sha, parents: [parent], author: { name: actor.name, email: actor.email }, committer: bot
  } });
  if (!shaPattern.test(commit.sha)) fail('Invalid commit response.');
  const metadata = await request(root + '/commits/' + commit.sha);
  assertCommit(metadata, commit.sha, actor, parent, tree.sha);
  if (metadata.files?.length !== 1 || metadata.files[0].filename !== change.path) fail('Commit changed unexpected files.');
  await verifyBlame(request, commit.sha, change.path, change.line, actor);
  const currentActor = await reauthorize();
  if (currentActor.id !== actor.id || currentActor.email !== actor.email || currentActor.login !== actor.login) fail('GitHub authorization or author identity changed.');
  const latest = await request(root + '/branches/main');
  const latestRules = await request(root + '/rules/branches/main');
  if (latest.commit.sha !== parent || latest.protected !== false || !Array.isArray(latestRules) || latestRules.length) fail('Main changed or is protected; refresh and try again.');
  // Non-force update only. GitHub rejects a concurrent non-fast-forward update.
  try {
    await request(root + '/git/refs/heads/main', { method: 'PATCH', body: { sha: commit.sha, force: false } });
    const pushed = await request(root + '/branches/main');
    if (pushed.commit.sha !== commit.sha) fail('Main advanced after save.');
    const final = await request(root + '/commits/' + commit.sha);
    assertCommit(final, commit.sha, actor, parent, tree.sha);
    const stored = await request(root + '/contents/' + change.path + '?ref=' + commit.sha);
    if (Buffer.from(stored.content, 'base64').toString('utf8') !== change.content) fail('Pushed redirect differs from request.');
    await verifyBlame(request, commit.sha, change.path, change.line, actor);
  } catch {
    // Never retry a potentially successful write automatically.
    const error = new Error('Save outcome requires verification. Check commit ' + commit.sha + ' before retrying.');
    error.commitSha = commit.sha;
    throw error;
  }
  return { key: change.key, sha: commit.sha, url: 'https://github.com/' + redirectRepository + '/commit/' + commit.sha };
}
