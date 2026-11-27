import { createHash, randomBytes } from 'node:crypto';
import { AccessDeniedError, InvalidGrantError, InvalidRequestError, InvalidScopeError,
  InvalidTokenError, InvalidClientMetadataError } from '@modelcontextprotocol/sdk/server/auth/errors.js';

const random = () => randomBytes(32).toString('base64url');
const hash = value => createHash('sha256').update(value).digest('base64url');
export const hostedScopes = ['kefania:read', 'kefania:publish', 'kefania:redirect'];

// Ephemeral, bounded OAuth state. Restarting the host requires reconnecting clients.
function expiringStore(now, capacity = 1000) {
  const values = new Map();
  const prune = () => { for (const [key, value] of values) if (value.expires <= now()) values.delete(key); };
  return {
    get(key) { prune(); return values.get(key); },
    delete(key) { values.delete(key); },
    set(key, value) {
      prune();
      if (!values.has(key) && values.size >= capacity) throw new InvalidRequestError('Authorization capacity reached. Try again later.');
      values.set(key, value);
    },
  };
}

export function createHostedOAuth({ publicUrl, clientId, clientSecret, allowedUserIds,
  redirectUris, fetchImpl = fetch, now = Date.now }) {
  const origin = new URL(publicUrl);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') {
    throw new Error('KEFANIA_PUBLIC_URL must be an HTTPS origin without a path.');
  }
  if (!clientId || !clientSecret || !allowedUserIds?.length || !redirectUris?.length) {
    throw new Error('Hosted OAuth requires a GitHub App client ID/secret, allowed user IDs, and exact OAuth redirect URIs.');
  }
  if (allowedUserIds.some(id => !/^\d+$/.test(String(id)))) throw new Error('Allowed GitHub user IDs must be numeric.');
  for (const value of redirectUris) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('OAuth client redirect URIs must use HTTPS.');
  }
  const resource = new URL('/mcp', origin).href;
  const callback = new URL('/oauth/github/callback', origin).href;
  const clients = expiringStore(now), pending = expiringStore(now), codes = expiringStore(now);
  const sessions = expiringStore(now), access = expiringStore(now), refresh = expiringStore(now);
  const scopes = requested => {
    const value = requested?.length ? requested : ['kefania:read', 'kefania:publish'];
    if (value.some(scope => !hostedScopes.includes(scope))) throw new InvalidScopeError('Unsupported Kefania scope.');
    return [...new Set(value)];
  };
  const checkResource = requested => {
    if (requested && requested.href !== resource) throw new InvalidRequestError('Token resource must be this Kefania MCP endpoint.');
  };
  const github = async (token, endpoint) => {
    let response;
    try {
      response = await fetchImpl(`https://api.github.com/${endpoint}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2026-03-10', 'User-Agent': 'kefania' },
        redirect: 'error', signal: AbortSignal.timeout(15000),
      });
    } catch { throw new AccessDeniedError('GitHub authorization could not be checked.'); }
    if (!response.ok) throw new AccessDeniedError('GitHub authorization is unavailable or revoked.');
    try { return await response.json(); } catch { throw new AccessDeniedError('GitHub returned an invalid authorization response.'); }
  };
  const checkUser = async token => {
    const user = await github(token, 'user');
    if (!allowedUserIds.map(String).includes(String(user.id))) throw new AccessDeniedError('This GitHub account is not authorized for this publisher.');
    return { id: String(user.id), login: user.login };
  };
  const grant = (client, code) => {
    const value = codes.get(hash(code));
    if (!value || value.clientId !== client.client_id) throw new InvalidGrantError('Authorization code is invalid or expired.');
    return value;
  };
  const issue = (sessionId, session) => {
    const accessToken = random(), refreshToken = random();
    const expires = Math.min(session.expires, now() + 15 * 60000);
    access.set(hash(accessToken), { sessionId, expires });
    refresh.set(hash(refreshToken), { sessionId, expires: session.expires });
    return { access_token: accessToken, refresh_token: refreshToken, token_type: 'Bearer',
      expires_in: Math.floor((expires - now()) / 1000), scope: session.scopes.join(' ') };
  };
  const provider = {
    clientsStore: {
      getClient(id) { return clients.get(id)?.client; },
      registerClient(input) {
        if (!input.redirect_uris?.length || input.redirect_uris.some(uri => !redirectUris.includes(uri))) {
          throw new InvalidClientMetadataError('Register only configured exact redirect URIs.');
        }
        if (input.token_endpoint_auth_method && input.token_endpoint_auth_method !== 'none') {
          throw new InvalidClientMetadataError('Use a public OAuth client with PKCE.');
        }
        const client = { ...input, client_id: random(), client_id_issued_at: Math.floor(now() / 1000),
          token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] };
        delete client.client_secret;
        clients.set(client.client_id, { client, expires: now() + 8 * 3600000 });
        return client;
      },
    },
    async authorize(client, params, res) {
      checkResource(params.resource);
      if (!redirectUris.includes(params.redirectUri) || !client.redirect_uris.includes(params.redirectUri)) {
        throw new InvalidRequestError('Redirect URI is not registered.');
      }
      const state = random(), browserBinding = random(), verifier = random();
      pending.set(hash(state), { clientId: client.client_id, params: { ...params, scopes: scopes(params.scopes) },
        browserBinding: hash(browserBinding), verifier, expires: now() + 10 * 60000 });
      res.setHeader('Set-Cookie', `__Host-kefania-oauth=${browserBinding}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=600`);
      const url = new URL('https://github.com/login/oauth/authorize');
      for (const [key, value] of Object.entries({ client_id: clientId, redirect_uri: callback, state,
        code_challenge: hash(verifier), code_challenge_method: 'S256' })) url.searchParams.set(key, value);
      res.redirect(url.href);
    },
    async githubCallback(req, res) {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Referrer-Policy', 'no-referrer');
      const state = typeof req.query.state === 'string' ? req.query.state : '';
      const value = pending.get(hash(state));
      const binding = req.headers.cookie?.split(';').map(cookie => cookie.trim()).find(cookie => cookie.startsWith('__Host-kefania-oauth='))?.split('=')[1];
      if (!value || !binding || hash(binding) !== value.browserBinding) {
        return res.status(400).json({ error: 'Invalid or expired OAuth browser session. Start authorization again.' });
      }
      pending.delete(hash(state));
      res.setHeader('Set-Cookie', '__Host-kefania-oauth=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
      const destination = new URL(value.params.redirectUri);
      if (value.params.state) destination.searchParams.set('state', value.params.state);
      try {
        if (req.query.error || typeof req.query.code !== 'string') throw new AccessDeniedError('GitHub authorization was declined.');
        const response = await fetchImpl('https://github.com/login/oauth/access_token', {
          method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code: req.query.code,
            redirect_uri: callback, code_verifier: value.verifier }), redirect: 'error', signal: AbortSignal.timeout(15000),
        });
        const result = await response.json();
        if (!response.ok || !result.access_token || result.error) throw new AccessDeniedError('GitHub authorization failed.');
        const user = await checkUser(result.access_token);
        const code = random();
        const duration = Number(result.expires_in ?? 28800);
        if (!Number.isFinite(duration) || duration <= 0) throw new AccessDeniedError('GitHub authorization has expired.');
        codes.set(hash(code), { ...value, user, githubToken: result.access_token,
          sessionExpires: now() + Math.min(duration, 28800) * 1000, expires: now() + 60000 });
        destination.searchParams.set('code', code);
      } catch {
        destination.searchParams.set('error', 'access_denied');
        destination.searchParams.set('error_description', 'GitHub authorization failed or this account is not allowed.');
      }
      res.redirect(destination.href);
    },
    async challengeForAuthorizationCode(client, code) { return grant(client, code).params.codeChallenge; },
    async exchangeAuthorizationCode(client, code, _verifier, redirectUri, requestedResource) {
      checkResource(requestedResource);
      const value = grant(client, code);
      if (redirectUri !== value.params.redirectUri) throw new InvalidGrantError('Redirect URI does not match authorization.');
      codes.delete(hash(code));
      const sessionId = random();
      const session = { clientId: client.client_id, user: value.user, githubToken: value.githubToken,
        scopes: value.params.scopes, expires: value.sessionExpires };
      sessions.set(sessionId, session);
      return issue(sessionId, session);
    },
    async exchangeRefreshToken(client, token, requestedScopes, requestedResource) {
      checkResource(requestedResource);
      const value = refresh.get(hash(token)), session = value && sessions.get(value.sessionId);
      if (!session || session.clientId !== client.client_id) throw new InvalidGrantError('Refresh token is invalid or expired.');
      if (requestedScopes?.some(scope => !session.scopes.includes(scope))) throw new InvalidScopeError('Refresh cannot expand scopes.');
      // Consume before the asynchronous GitHub check so concurrent refreshes cannot reuse this token.
      refresh.delete(hash(token));
      await checkUser(session.githubToken);
      if (sessions.get(value.sessionId) !== session) throw new InvalidGrantError('Authorization session changed. Reconnect the client.');
      const updated = { ...session, scopes: requestedScopes?.length ? requestedScopes : session.scopes };
      sessions.set(value.sessionId, updated);
      return issue(value.sessionId, updated);
    },
    async verifyAccessToken(token) {
      const value = access.get(hash(token)), session = value && sessions.get(value.sessionId);
      if (!session) throw new InvalidTokenError('Kefania token is invalid or expired.');
      try { await checkUser(session.githubToken); }
      catch { sessions.delete(value.sessionId); throw new InvalidTokenError('GitHub authorization is unavailable or revoked.'); }
      return { token, clientId: session.clientId, scopes: session.scopes, expiresAt: value.expires / 1000,
        resource, extra: { user: session.user, githubToken: session.githubToken } };
    },
    async revokeToken(client, request) {
      const key = hash(request.token), value = access.get(key) || refresh.get(key);
      const session = value && sessions.get(value.sessionId);
      if (session?.clientId === client.client_id) sessions.delete(value.sessionId);
    },
    github,
  };
  return provider;
}
