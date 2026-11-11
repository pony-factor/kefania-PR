import { spawn } from 'node:child_process';
import { createSign } from 'node:crypto';
import { loadAppEnvironment } from './app-credentials.js';
import { githubUserRequest } from './user-auth.js';

// gh uses its existing login; credentials never enter tool arguments or logs.
export function githubCliRequest(endpoint, { method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const args = ['api', '--hostname', 'github.com', '--method', method, endpoint];
    if (body !== undefined) args.push('--input', '-');
    const child = spawn(process.env.KEFANIA_GH_COMMAND || 'gh', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '', error = '', size = 0, settled = false;
    const finish = (failure, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      failure ? reject(failure) : resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error('GitHub request timed out. Check whether the PR exists before retrying a write.'));
    }, 60000);
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > 16 * 1024 * 1024) {
        child.kill();
        finish(new Error('GitHub response exceeded the size limit. Narrow the branch changes.'));
      } else output += chunk;
    });
    child.stderr.on('data', chunk => { error += chunk; });
    child.on('error', () => finish(new Error('GitHub CLI is unavailable. Install gh and sign in before starting Kefania.')));
    child.on('close', code => {
      if (code !== 0) {
        const status = error.match(/HTTP (\d{3})/)?.[1];
        const failure = new Error(`GitHub request failed${status ? ` (HTTP ${status})` : ''}. Check repository access and gh authentication.`);
        failure.status = Number(status) || undefined;
        return finish(failure);
      }
      try { finish(null, JSON.parse(output)); }
      catch { finish(new Error('GitHub returned an invalid response.')); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

// Describe only the GitHub operation, never the URL, token, request body, or
// GitHub's unchecked error message. The latter can contain user-controlled data.
function appOperation(endpoint) {
  if (endpoint === 'app') return 'identifying codex-pony';
  if (/^app\/installations\/\d+\/access_tokens$/.test(endpoint)) return 'issuing an installation token';
  if (/^repos\/[^/]+\/[^/]+\/installation$/.test(endpoint)) return 'checking the repository installation';
  if (/\/compare\//.test(endpoint)) return 'comparing the published branches';
  if (/\/pulls\/\d+\/commits/.test(endpoint)) return 'checking prior PR commits';
  if (/\/pulls(?:\?|$)/.test(endpoint)) return 'checking pull requests';
  if (/\/commits\//.test(endpoint)) return 'reading the published branch';
  return 'accessing GitHub';
}

// Credentials are supplied by the process environment, never read from files.
export function createAppRequest({ env = process.env, fetchImpl = fetch, now = Date.now } = {}) {
  let appPromise;
  const tokens = new Map(), tokenPromises = new Map(), repositoryInstallations = new Map();
  const api = async (endpoint, authorization, { method = 'GET', body } = {}) => {
    let response;
    try {
      response = await fetchImpl(`https://api.github.com/${endpoint}`, {
        method, headers: { Authorization: `Bearer ${authorization}`, Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2026-03-10', 'User-Agent': 'kefania',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60000),
      });
    } catch { throw new Error('GitHub App request failed or timed out. Check whether the write succeeded before retrying.'); }
    if (!response.ok) {
      const operation = appOperation(endpoint);
      const rejectedToken = response.status === 422 && operation === 'issuing an installation token';
      const rejectedRead = response.status === 422 && method === 'GET';
      const hint = rejectedToken
        ? ' GitHub rejected token issuance; verify codex-pony permissions, then retry after other App checks settle.'
        : rejectedRead
          ? ' Verify the remote branches and repository access; repeated checks may also trigger GitHub validation limits.'
          : ' Check codex-pony installation access and permissions.';
      // Keep GitHub's free-form error body out of messages: it can contain
      // repository names, input values, or other data that should not be logged.
      const error = new Error(`GitHub App request failed (HTTP ${response.status}) while ${operation}.${hint}`);
      error.status = response.status;
      error.operation = operation;
      throw error;
    }
    try { return await response.json(); }
    catch { throw new Error('GitHub App returned an invalid response.'); }
  };
  const jwt = () => {
    if (!env.KEFANIA_GITHUB_APP_ID || !env.KEFANIA_GITHUB_PRIVATE_KEY) {
      throw new Error('Configure KEFANIA_GITHUB_APP_ID and KEFANIA_GITHUB_PRIVATE_KEY for codex-pony. Supply credentials securely through the process environment.');
    }
    const seconds = Math.floor(now() / 1000);
    const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iat: seconds - 60, exp: seconds + 540, iss: env.KEFANIA_GITHUB_APP_ID })}`;
    try {
      const signer = createSign('RSA-SHA256');
      signer.update(unsigned);
      return `${unsigned}.${signer.sign(env.KEFANIA_GITHUB_PRIVATE_KEY).toString('base64url')}`;
    } catch { throw new Error('GitHub App private key is invalid. Supply a PEM private key through the process environment.'); }
  };
  const app = async () => {
    if (!appPromise) {
      appPromise = api('app', jwt()).then(value => {
        if (value.slug !== 'codex-pony') throw new Error('Configured GitHub App must be codex-pony.');
        return value;
      }).catch(error => { appPromise = undefined; throw error; });
    }
    return appPromise;
  };
  const token = async installationId => {
    await app();
    const id = String(installationId || '');
    if (!/^\d+$/.test(id)) throw new Error('No GitHub App installation is available for this request.');
    const cached = tokens.get(id);
    if (cached?.expires > now() + 60000) return cached.token;
    if (!tokenPromises.has(id)) {
      tokenPromises.set(id, api(`app/installations/${id}/access_tokens`, jwt(), { method: 'POST' })
        .then(value => {
          const expires = Date.parse(value.expires_at);
          if (!value.token || !Number.isFinite(expires) || expires <= now() + 60000) throw new Error('GitHub returned an invalid installation token.');
          tokens.set(id, { token: value.token, expires });
          return value.token;
        }).finally(() => { tokenPromises.delete(id); }));
    }
    return tokenPromises.get(id);
  };
  const installedRequest = async (id, endpoint, options) => {
    const authorization = await token(id);
    try { return await api(endpoint, authorization, options); }
    catch (error) {
      if (error.status === 401 || error.status === 403) tokens.delete(String(id));
      // Never retry a write automatically: GitHub may already have accepted it.
      throw error;
    }
  };
  const request = async (endpoint, options) => {
    await app();
    const root = endpoint.match(/^repos\/[^/?]+\/[^/?]+(?=\/|\?|$)/)?.[0];
    let id = env.KEFANIA_GITHUB_INSTALLATION_ID;
    if (root) {
      const key = root.toLowerCase();
      if (!repositoryInstallations.has(key)) {
        repositoryInstallations.set(key, api(`${root}/installation`, jwt()).then(installation => {
          if (installation.suspended_at) throw new Error('The GitHub App installation for this repository is suspended.');
          return String(installation.id);
        }).catch(error => {
          repositoryInstallations.delete(key);
          if (error.status === 404) throw new Error('Install codex-pony on this repository before creating a bot PR.');
          throw error;
        }));
      }
      id = await repositoryInstallations.get(key);
    } else if (!id) {
      id = (await request.installations()).find(item => !item.suspended_at)?.id;
    }
    return installedRequest(id, endpoint, options);
  };
  request.installations = async () => {
    await app();
    const installations = [];
    for (let page = 1; ; page++) {
      const batch = await api(`app/installations?per_page=100&page=${page}`, jwt());
      installations.push(...batch);
      if (batch.length < 100) return installations;
    }
  };
  request.repositories = async () => {
    const repos = new Map();
    for (const installation of (await request.installations()).filter(item => !item.suspended_at)) {
      for (let page = 1; ; page++) {
        const batch = await installedRequest(installation.id, `installation/repositories?per_page=100&page=${page}`);
        for (const repo of batch.repositories || []) {
          repos.set(repo.full_name.toLowerCase(), { ...repo,
            canCreatePullRequest: installation.permissions?.pull_requests === 'write'
              && ['read', 'write'].includes(installation.permissions?.contents)
              && !repo.archived && !repo.disabled });
        }
        if ((batch.repositories || []).length < 100) break;
      }
    }
    return [...repos.values()];
  };
  request.status = async () => {
    const installations = (await request.installations()).filter(item => !item.suspended_at);
    if (!installations.length) throw new Error('Install codex-pony on a GitHub account or organization first.');
    return { githubLogin: `${(await app()).slug}[bot]`, githubAuth: 'app', automaticInstallation: true,
      installations: installations.map(item => ({ id: String(item.id), account: item.account.login,
        settingsUrl: item.account.type === 'Organization'
          ? `https://github.com/organizations/${encodeURIComponent(item.account.login)}/settings/installations/${item.id}`
          : `https://github.com/settings/installations/${item.id}`,
        missingPermissions: [!['read', 'write'].includes(item.permissions?.contents) && 'Contents: read',
          item.permissions?.pull_requests !== 'write' && 'Pull requests: read/write',
          item.permissions?.issues !== 'write' && 'Issues: read/write'].filter(Boolean) })) };
  };
  return request;
}

export function createGithubRequest({ env = process.env, appRequest, userRequest = githubUserRequest, cliRequest = githubCliRequest } = {}) {
  let selected, resolvedApp;
  const getApp = async () => appRequest || (resolvedApp ||= createAppRequest({ env: await loadAppEnvironment(env) }));
  const cliStatus = async () => ({ githubLogin: (await cliRequest('user')).login, githubAuth: 'cli' });
  const choose = async () => {
    const mode = env.KEFANIA_GITHUB_AUTH || 'auto';
    if (mode === 'cli') return { request: cliRequest, status: cliStatus, method: 'cli' };
    if (mode === 'user') return { request: userRequest, status: userRequest.status, method: 'user' };
    if (mode === 'app') { const app = await getApp(); return { request: app, status: app.status, method: 'app' }; }
    if (mode !== 'auto') throw new Error('KEFANIA_GITHUB_AUTH must be auto, user, app, or cli.');
    if (!selected) {
      selected = (async () => {
        try {
          const app = await getApp();
          await app.status();
          return { request: app, status: app.status, method: 'app' };
        } catch {
          // Prefer bot attribution; select a working fallback before any write.
        }
        try {
          await userRequest.status();
          return { request: userRequest, status: async () => ({ ...await userRequest.status(),
            fallbackFrom: 'app', fallbackReason: 'No authorized GitHub App installation is available.' }), method: 'user' };
        } catch {
          // Select the fallback before any repository write. Never replay a
          // failed write under a different identity: it may have succeeded.
          await cliStatus();
          return { request: cliRequest, status: async () => ({ ...await cliStatus(),
            fallbackFrom: 'app', fallbackReason: 'No authorized GitHub user or App installation is available.' }), method: 'cli' };
        }
      })().catch(error => { selected = undefined; throw error; });
    }
    return selected;
  };
  const request = async (endpoint, options) => (await choose()).request(endpoint, options);
  request.status = async () => (await choose()).status();
  request.reset = () => { selected = undefined; resolvedApp = undefined; };
  request.repositories = async () => {
    const provider = await choose();
    if (provider.request.repositories) return provider.request.repositories();
    const results = [];
    for (let page = 1; page <= 10; page++) {
      const endpoint = provider.method === 'app'
        ? 'installation/repositories?per_page=100&page=' + page
        : 'user/repos?per_page=100&page=' + page + '&affiliation=owner,collaborator,organization_member';
      const response = await provider.request(endpoint);
      const batch = Array.isArray(response) ? response : (response.repositories || []);
      results.push(...batch);
      if (batch.length < 100) break;
    }
    return results;
  };
  return request;
}

export const githubRequest = createGithubRequest();
