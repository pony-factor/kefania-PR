#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { createHostedOAuth, hostedScopes } from './hosted-oauth.js';
import { createAppRequest } from './github.js';
import { verifiedActor, validateRedirect, writeRedirect } from './redirect-write.js';
import { createActions, rules } from './pull-requests.js';
import { createMcpServer, contextInputSchema, publishInputSchema } from './server.js';

const list = value => (value || '').split(',').map(item => item.trim()).filter(Boolean);

export function hostedActions({ actions, oauth, auth, allowedRepositories }) {
  const authorize = async (args, write) => {
    const scope = write ? 'kefania:publish' : 'kefania:read';
    if (!auth.scopes.includes(scope)) throw new Error('This connection does not have the required Kefania scope.');
    const repository = `${args.owner}/${args.repo}`;
    if (!allowedRepositories.some(item => item.toLowerCase() === repository.toLowerCase())) {
      throw new Error('Repository is not authorized for this publisher.');
    }
    const info = await oauth.github(auth.extra.githubToken, `repos/${repository}`);
    if (!info.permissions?.pull) throw new Error('Your GitHub account lacks upstream repository read access.');
    if (write) {
      const cross = args.headRepository && args.headRepository.toLowerCase() !== repository.toLowerCase();
      const writable = cross ? await oauth.github(auth.extra.githubToken, `repos/${args.headRepository}`) : info;
      if (!writable.permissions?.push && !writable.permissions?.admin && !writable.permissions?.maintain) {
        throw new Error('Your GitHub account lacks write access to the selected head repository.');
      }
    }
  };
  const wrap = (name, write) => async args => { await authorize(args, write); return actions[name](args); };
  return {
    status: async () => ({ githubLogin: auth.extra.user.login, provider: 'github-app', bot: 'codex-pony[bot]',
      allowedRepositories }),
    context: wrap('context', false), create: wrap('create', true), comment: wrap('comment', true),
    issue: async () => { throw new Error('Hosted Kefania publishes pull requests only.'); },
  };
}

export function createHostedApp({ publicUrl, clientId, clientSecret, allowedUserIds, redirectUris,
  allowedRepositories, host = '0.0.0.0', oauth, actions, env = process.env, fetchImpl = fetch } = {}) {
  if (!allowedRepositories?.length || allowedRepositories.some(repo => !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo))) {
    throw new Error('Hosted mode requires an explicit KEFANIA_ALLOWED_REPOSITORIES list.');
  }
  const origin = new URL(publicUrl), resource = new URL('/mcp', origin);
  const provider = oauth || createHostedOAuth({ publicUrl, clientId, clientSecret, allowedUserIds, redirectUris, fetchImpl });
  if (!actions && (!env.KEFANIA_GITHUB_APP_ID || !env.KEFANIA_GITHUB_PRIVATE_KEY)) {
    throw new Error('Hosted mode requires GitHub App credentials in the host secret environment.');
  }
  // Explicit App request: never select user/gh authentication or local model drafting.
  const appRequest = createAppRequest({ env, fetchImpl });
  const publisher = actions || createActions({ allowedRepositories, request: appRequest });
  const app = createMcpExpressApp({ host, allowedHosts: [origin.hostname, '127.0.0.1', 'localhost'] });
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });
  app.get('/health', (_req, res) => res.json({ service: 'kefania-hosted', ready: true }));
  app.use(mcpAuthRouter({ provider, issuerUrl: origin, resourceServerUrl: resource,
    scopesSupported: hostedScopes, resourceName: 'Kefania bot PR publisher' }));
  app.get('/oauth/github/callback', (req, res) => {
    void provider.githubCallback(req, res).catch(() => {
      if (!res.headersSent) res.status(400).json({ error: 'GitHub authorization could not be completed.' });
    });
  });
  const authenticate = requireBearerAuth({ verifier: provider, requiredScopes: ['kefania:read'],
    expectedResource: resource, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resource) });
  app.use(['/mcp', '/api'], authenticate);
  // Existing browser handoffs publish locally; hosted tools are called by authenticated clients.
  app.use(['/mcp', '/api'], (req, res, next) => {
    if (req.headers.origin) return res.status(403).json({ error: 'Browser-origin API calls are not supported.' });
    next();
  });
  const forRequest = req => hostedActions({ actions: publisher, oauth: provider, auth: req.auth, allowedRepositories });
  app.get('/api/rules', async (_req, res) => {
    try { res.json({ instructions: await rules() }); }
    catch { res.status(500).json({ error: 'Drafting rules are unavailable.' }); }
  });
  const rest = (schema, name) => async (req, res) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid request. Supply repository, branch, and the required draft fields.' });
    try { res.json(await forRequest(req)[name](parsed.data)); }
    catch (error) {
      // Known application errors are safe; unexpected errors never return credentials or upstream bodies.
      const safe = /^(Repository is not authorized|Your GitHub account lacks|This connection does not have|The published head|The head changed|PR exists|GitHub App request failed|Install codex-pony)/.test(error.message);
      res.status(400).json({ error: safe ? error.message : 'Kefania request failed. Check GitHub for an existing PR before retrying publication.' });
    }
  };
  app.post('/api/context', rest(contextInputSchema, 'context'));
  app.post('/api/pull-requests', rest(publishInputSchema, 'create'));
  // Separate opt-in capability; no PR/issue or generic write endpoint.
  const redirectAttempts = new Map();
  let redirectBusy = false;
  const actorFor = req => verifiedActor({ auth: req.auth, oauth: provider, allowedRepositories });
  const enabled = () => env.KEFANIA_ENABLE_WOOTEN_REDIRECTS === '1';
  app.get('/api/wooten-redirects/session', async (req, res) => {
    if (!enabled()) return res.status(503).json({ error: 'Redirect saves are not enabled on the runner.' });
    try {
      const actor = await actorFor(req);
      await appRequest.redirectWriter();
      res.json({ login: actor.login });
    } catch {
      res.status(403).json({ error: 'GitHub write access, a verified nonprivate author email, and codex-pony Contents write permission are required.' });
    }
  });
  app.post('/api/wooten-redirects', async (req, res) => {
    if (!enabled()) return res.status(503).json({ error: 'Redirect saves are not enabled on the runner.' });
    let actor, input;
    try { actor = await actorFor(req); input = validateRedirect(req.body); }
    catch { return res.status(400).json({ error: 'Invalid redirect or insufficient GitHub authorization.' }); }
    const now = Date.now();
    for (const [id, at] of redirectAttempts) if (now - at > 60000) redirectAttempts.delete(id);
    if (redirectBusy || redirectAttempts.has(actor.id)) return res.status(429).json({ error: 'Another save is in progress or you have saved recently. Try again in one minute.' });
    redirectBusy = true;
    redirectAttempts.set(actor.id, now);
    try {
      const request = await appRequest.redirectWriter();
      const result = await writeRedirect({ request, actor, input, reauthorize: () => actorFor(req) });
      console.info('Wooten redirect saved', JSON.stringify({ userId: actor.id, sha: result.sha }));
      res.json(result);
    } catch (error) {
      const safe = /^(Shortlink already exists|Reserved shortlink key|Main changed|Main branch has protection|Save outcome requires verification|codex-pony needs Contents write permission)/.test(error.message);
      res.status(error.commitSha ? 409 : 400).json({ error: safe ? error.message : 'Redirect save failed before confirmation. Check runner permissions, branch rules and author attribution.', ...(error.commitSha ? { sha: error.commitSha } : {}) });
    } finally { redirectBusy = false; }
  });
  app.post('/mcp', async (req, res) => {
    const server = createMcpServer({ actions: forRequest(req) });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void transport.close(); void server.close(); });
    try { await server.connect(transport); await transport.handleRequest(req, res, req.body); }
    catch { if (!res.headersSent) res.status(500).json({ error: 'MCP request failed.' }); }
  });
  app.all('/mcp', (_req, res) => res.status(405).json({ error: 'Use POST for stateless MCP requests.' }));
  app.use((_error, _req, res, _next) => res.status(400).json({ error: 'Invalid HTTP request.' }));
  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const host = process.env.KEFANIA_HOST || '0.0.0.0', port = Number(process.env.PORT || 8765);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
    const app = createHostedApp({ publicUrl: process.env.KEFANIA_PUBLIC_URL,
      clientId: process.env.KEFANIA_GITHUB_CLIENT_ID, clientSecret: process.env.KEFANIA_GITHUB_CLIENT_SECRET,
      allowedUserIds: list(process.env.KEFANIA_ALLOWED_USER_IDS), redirectUris: list(process.env.KEFANIA_OAUTH_REDIRECT_URIS),
      allowedRepositories: list(process.env.KEFANIA_ALLOWED_REPOSITORIES), host });
    const listener = app.listen(port, host, () => console.error('Kefania hosted publisher listening.'));
    listener.on('error', () => { console.error('Could not bind hosted publisher.'); process.exitCode = 1; });
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => listener.close());
  } catch { console.error('Hosted publisher configuration is invalid. See HOSTING.md for required settings.'); process.exitCode = 1; }
}
