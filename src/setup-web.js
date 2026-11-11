#!/usr/bin/env node
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { githubRequest } from './github.js';
import { githubDeviceAuthorization } from './user-auth.js';
import { loadPreferences, savePreferences, validatePreferences } from './preferences.js';
import { runLocalPullRequest } from './local-pr.js';
import { createBotSetup } from './bot-setup.js';
import { defaultClientId } from './app-settings.js';
import { ollamaModels } from './ollama.js';
import { createSweetiebotSetup } from './sweetiebot-setup.js';
import { hostedDeployment } from './aws-hosted-deploy.js';

const allowed = (process.env.KEFANIA_ALLOWED_REPOSITORIES || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
const token = randomBytes(32).toString('hex');
const files = {
  '/': new URL('../web/index.html', import.meta.url),
  '/app.js': new URL('../web/app.js', import.meta.url),
  '/style.css': new URL('../web/style.css', import.meta.url),
};
const mime = { '/': 'text/html; charset=utf-8', '/app.js': 'text/javascript; charset=utf-8',
  '/style.css': 'text/css; charset=utf-8' };
const validName = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;

const errorMessage = error => error instanceof Error && typeof error.message === 'string'
  ? error.message.slice(0, 300) : 'The request could not be completed.';

async function readBody(req) {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 20000) throw new Error('Request is too large.');
  }
  try { return JSON.parse(text || '{}'); }
  catch { throw new Error('Please check the supplied values.'); }
}

export function createSetupServer({ github = githubRequest, authorization = githubDeviceAuthorization,
  preferences = { load: loadPreferences, save: savePreferences }, draftPr = runLocalPullRequest,
  botSetup = createBotSetup(), models = ollamaModels, sweetiebot = createSweetiebotSetup(),
  hosted = hostedDeployment() } = {}) {
  // A random CSRF token is returned only to same-origin callers; it is not a GitHub credential.
  const matchesToken = received => typeof received === 'string' && received.length === token.length
    && timingSafeEqual(Buffer.from(received), Buffer.from(token));
  const connection = async () => {
    try { return { connected: true, ...await github.status() }; }
    catch { return { connected: false, hint: 'Connect GitHub or sign in with gh auth login.' }; }
  };
  const repositories = async () => {
    const repos = await github.repositories();
    return repos.filter(item => validName.test(item.full_name || '')
        && (!allowed.length || allowed.includes(item.full_name.toLowerCase())))
      .map(item => ({ name: item.full_name, canPush: item.canCreatePullRequest ?? Boolean(item.permissions?.push) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  };
  return createServer(async (req, res) => {
    const host = req.headers.host || '';
    const hostName = host.split(':')[0];
    const origin = req.headers.origin || '';
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    const json = (status, result) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(result)); };
    if (!['127.0.0.1', 'localhost'].includes(hostName)
      || (origin && !['http://127.0.0.1:' + host.split(':')[1], 'http://localhost:' + host.split(':')[1]].includes(origin))
      || req.headers['sec-fetch-site'] === 'cross-site') {
      return json(403, { error: 'Open Kefania from its local setup URL.' });
    }
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    try {
      if (req.method === 'GET' && files[url.pathname] && !url.search) {
        const html = await readFile(files[url.pathname]);
        res.writeHead(200, { 'Content-Type': mime[url.pathname] });
        return res.end(html);
      }
      if (req.method === 'GET' && url.pathname === '/api/bootstrap') {
        const settings = await preferences.load();
        return json(200, { csrf: token, settings: { ...settings, clientId: settings.clientId || defaultClientId() }, connection: await connection() });
      }
      if (req.method === 'GET' && url.pathname === '/api/repositories') {
        github.reset();
        return json(200, { repositories: await repositories() });
      }
      if (req.method !== 'POST' || !url.pathname.startsWith('/api/')) return json(404, { error: 'Not found.' });
      if (!matchesToken(req.headers['x-kefania-csrf'])) return json(403, { error: 'Reload the setup page and try again.' });
      const input = await readBody(req);
      if (['/api/sweetiebot/check', '/api/sweetiebot/repair', '/api/sweetiebot/update'].includes(url.pathname)) {
        const settings = await preferences.load();
        if (!validName.test(input.repository || '') || !settings.repositories.includes(input.repository)
          || (allowed.length && !allowed.includes(input.repository.toLowerCase()))) {
          throw new Error('Select the repository and save it in preferences first.');
        }
        const action = url.pathname.split('/').pop();
        return json(200, await sweetiebot[action]({ repository: input.repository, checkoutPath: input.checkoutPath }));
      }
      if (url.pathname === '/api/hosted/deploy' || url.pathname === '/api/hosted/activate') {
        // Loopback host/origin and CSRF are already validated above.
        const action = url.pathname.endsWith('/deploy') ? 'deploy' : 'activate';
        return json(200, await hosted[action](input));
      }
      if (url.pathname === '/api/ollama/models') {
        const settings = await preferences.load();
        return json(200, { models: await models({ ...settings.ollama,
          ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }) }) });
      }
      if (url.pathname === '/api/bot/start' || url.pathname === '/api/bot/finish') {
        try {
          if (url.pathname === '/api/bot/start') return json(200, await botSetup.start(input));
          const bot = await botSetup.finish(input);
          github.reset();
          return json(200, { bot, connection: await connection() });
        } catch {
          // Never reflect credential input or upstream errors into the browser.
          return json(400, { error: 'Bot setup failed. Check the App ID, RSA PEM file, installation access, and macOS Keychain. Select the file again to retry.' });
        }
      }
      if (url.pathname === '/api/connect') {
        const current = await preferences.load();
        const clientId = input.clientId || current.clientId || defaultClientId();
        const flow = await authorization.start(clientId);
        await preferences.save({ ...current, clientId });
        return json(200, flow);
      }
      if (url.pathname === '/api/poll') {
        const result = await authorization.poll();
        if (result.connected) { github.reset(); return json(200, { ...result, connection: await connection() }); }
        return json(200, result);
      }
      if (url.pathname === '/api/disconnect') {
        await authorization.disconnect();
        github.reset();
        return json(200, { connection: await connection() });
      }
      if (url.pathname === '/api/preferences') {
        const settings = validatePreferences(input);
        // Selection is only a preference; an actual request is always authorized separately.
        const saved = await preferences.save(settings);
        return json(200, { settings: saved });
      }
      if (url.pathname === '/api/pr') {
        const settings = await preferences.load();
        const upstream = typeof input.upstreamRepository === 'string' ? input.upstreamRepository.trim() : '';
        const headRepository = typeof input.headRepository === 'string' ? input.headRepository.trim() : '';
        const repository = upstream || input.repository || settings.selectedRepository;
        if (!validName.test(repository || '') || (!upstream && !settings.repositories.includes(repository))
          || (allowed.length && !allowed.includes(repository.toLowerCase()))) {
          throw new Error('Select an authorized repository and save your choices first.');
        }
        if (headRepository && !validName.test(headRepository)) throw new Error('Enter the fork as owner/repo.');
        if (upstream && !headRepository) throw new Error('An upstream target requires a source fork owner/repo.');
        if (typeof input.head !== 'string' || !input.head.trim() || input.head.length > 255
          || typeof input.base !== 'string' || !input.base.trim() || input.base.length > 255) {
          throw new Error('Enter a published head branch and a base branch.');
        }
        const result = await draftPr({ repository, head: input.head.trim(), base: input.base.trim(),
          ...(headRepository ? { headRepository } : {}), draftOnly: input.preview === true });
        return json(200, result);
      }
      return json(404, { error: 'Not found.' });
    } catch (error) {
      return json(400, { error: errorMessage(error) });
    }
  }).on('close', () => botSetup.clear());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.KEFANIA_SETUP_PORT || 8766);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('KEFANIA_SETUP_PORT must be a valid port.');
  const server = createSetupServer();
  server.listen(port, '127.0.0.1', () => {
    console.log('Open Kefania setup at http://127.0.0.1:' + port + '/');
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
}
