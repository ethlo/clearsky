// OAuth for a remote MCP server, for any plugin (lent to plugins as `mcpOAuth`): find its
// authorization server (RFC 9728 / RFC 8414), log in in your browser with PKCE and a callback on
// localhost, refresh, and keep the token in a file only you can read. No token to create or paste.
// A server without a client ID for us (Atlassian's) gets one by dynamic client registration
// (RFC 7591); the client is kept with the token, and used again while its redirect URL is the same.

import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, chmodSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';

const b64url = (buf) => Buffer.from(buf).toString('base64url');
export const pkce = () => {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) };
};


async function getJson(url, fetchImpl) {
  try {
    const res = await fetchImpl(url, { headers: { Accept: 'application/json' } });
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

// Where a 401 from the server says its metadata is (WWW-Authenticate: Bearer resource_metadata="…").
async function metadataHint(mcpUrl, fetchImpl) {
  try {
    const res = await fetchImpl(mcpUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'ping' }) });
    return res.headers.get('www-authenticate')?.match(/resource_metadata="([^"]+)"/)?.[1] || null;
  } catch { return null; }
}

// The authorization server's endpoints (and registration_endpoint, when it has one) for the MCP
// server at `mcpUrl`. `defaults` fills what the server doesn't publish.
export async function discover(mcpUrl, { fetchImpl = fetch, defaults = {} } = {}) {
  const u = new URL(mcpUrl);
  const path = u.pathname.replace(/\/$/, '');
  const hint = await metadataHint(mcpUrl, fetchImpl);
  const pr = (hint && await getJson(hint, fetchImpl))
    || (path && await getJson(`${u.origin}/.well-known/oauth-protected-resource${path}`, fetchImpl))
    || await getJson(`${u.origin}/.well-known/oauth-protected-resource`, fetchImpl);
  const issuer = new URL(pr?.authorization_servers?.[0] || u.origin);
  const ipath = issuer.pathname.replace(/\/$/, '');
  const as = await getJson(`${issuer.origin}/.well-known/oauth-authorization-server${ipath}`, fetchImpl)
    || await getJson(`${issuer.origin}/.well-known/openid-configuration${ipath}`, fetchImpl) || {};
  return {
    authorization_endpoint: as.authorization_endpoint || defaults.authorization_endpoint,
    token_endpoint: as.token_endpoint || defaults.token_endpoint,
    registration_endpoint: as.registration_endpoint || null,
    resource: pr?.resource || null,
    scopes_supported: pr?.scopes_supported || as.scopes_supported || [],
  };
}

// The token file: { access_token, refresh_token, expires_at, user, team, scope, at }.
export function tokenStore(file) {
  return {
    get() { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } },
    set(t) {
      if (!t) { rmSync(file, { force: true }); return; }
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(file, JSON.stringify(t, null, 2), { mode: 0o600 });
      try { chmodSync(file, 0o600); } catch { /* not on this filesystem */ }
    },
  };
}

// A token endpoint's answer, in the standard shape or Slack's (`ok`, `authed_user`).
export function readToken(body, now = Date.now()) {
  if (!body || body.ok === false || body.error) {
    const why = body?.error_description || body?.error || 'no answer';
    throw Object.assign(new Error(`the login was refused: ${why}`), /invalid_grant|invalid_refresh|token_revoked|invalid_code/.test(why) ? { auth: true } : {});
  }
  const u = body.authed_user || {};
  const access = body.access_token || u.access_token;
  if (!access) throw new Error('the token endpoint gave no access token');
  const expires = Number(body.expires_in || u.expires_in) || 0;
  return {
    access_token: access,
    refresh_token: body.refresh_token || u.refresh_token || null,
    expires_at: expires ? now + expires * 1000 : null,
    scope: body.scope || u.scope || '',
    user: u.id || body.user_id || null,
    team: body.team?.name || body.team?.id || null,
    at: new Date(now).toISOString(),
  };
}

async function postForm(url, form, fetchImpl) {
  const body = new URLSearchParams(Object.entries(form).filter(([, v]) => v));
  const res = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body });
  let data = null;
  try { data = await res.json(); } catch { /* not JSON */ }
  if (!res.ok && !data) throw new Error(`${res.status} ${res.statusText} from ${new URL(url).host}`);
  return data;
}

const PAGE = (text) => `<!doctype html><meta charset="utf-8"><title>Clearsky</title><body style="font:16px system-ui;margin:3em;color:#333">${text}</body>`;

// Only a callback on this machine: http://localhost:<port>/<path> or 127.0.0.1.
export function callbackAddress(redirectUri) {
  let u;
  try { u = new URL(redirectUri); } catch { throw new Error('the redirect URL is not a URL'); }
  if (u.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) || !u.port) {
    throw new Error('the redirect URL must be http://localhost:<port>/<path>, as set where the client is registered');
  }
  return { port: Number(u.port), path: u.pathname || '/' };
}

// Waits for the browser to come back to the redirect URL with `state`, then answers it.
function waitForCode(redirectUri, state, { timeoutMs }) {
  const { port, path } = callbackAddress(redirectUri);
  let ready;
  const isReady = new Promise((r) => { ready = r; });
  const code = new Promise((resolve, reject) => {
    const servers = [];
    let done = false;
    const finish = (err, code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      for (const s of servers) s.close();
      err ? reject(err) : resolve(code);
    };
    const handler = (req, res) => {
      const u = new URL(req.url, 'http://localhost');
      if (u.pathname !== path) { res.writeHead(404).end(); return; }
      if (u.searchParams.get('state') !== state) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE('This login link is stale. Start the login again in Clearsky.'));
        return;
      }
      const err = u.searchParams.get('error');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', Connection: 'close' })
        .end(PAGE(err ? `The login said: ${err.replace(/[<>&]/g, '')}. You can close this tab.` : 'Logged in. You can close this tab and go back to Clearsky.'));
      finish(err ? new Error(`the login was cancelled (${err})`) : null, u.searchParams.get('code'));
    };
    const timer = setTimeout(() => finish(new Error('no answer from the browser in time; try again')), timeoutMs);
    // localhost can be either address family in the browser; listen on both, where there are both.
    let pending = 2, listening = 0;
    for (const host of ['127.0.0.1', '::1']) {
      const s = createServer(handler);
      servers.push(s);
      s.on('error', (e) => {
        if (--pending === 0 && !listening) finish(new Error(e.code === 'EADDRINUSE' ? `port ${port} is in use; close what uses it, or set another redirect URL here and where the client is registered` : e.message));
      });
      s.listen(port, host, () => { listening++; --pending; ready(); });
    }
  });
  code.catch(() => ready()); // a port in use: don't wait for listening that never comes
  return { ready: isReady, code };
}

// A client of our own at the server's registration endpoint (RFC 7591): public, PKCE, our
// localhost redirect. Gives { client_id, client_secret?, redirect_uri, registered_at }.
export async function register(registrationEndpoint, { redirectUri, scope, clientName = 'Clearsky', fetchImpl = fetch, now = Date.now() }) {
  const res = await fetchImpl(registrationEndpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_name: clientName, redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'], token_endpoint_auth_method: 'none', ...(scope && { scope }) }) });
  let data = null;
  try { data = await res.json(); } catch { /* not JSON */ }
  if (!res.ok || !data?.client_id) {
    const why = data?.error_description || data?.error || `${res.status} ${res.statusText}`;
    throw new Error(`${new URL(registrationEndpoint).host} wouldn't register Clearsky as a client: ${why}`);
  }
  return { client_id: data.client_id, ...(data.client_secret && { client_secret: data.client_secret }), redirect_uri: redirectUri, registered_at: new Date(now).toISOString() };
}

// Log in: open the authorize page in your browser and trade the code for a token.
// `open(url)` shows the authorize page (lends.openUrl: your default browser). Resolves with the
// token object to keep (tokenStore), once the browser has come back.
// Without `clientId`, the server must take registrations: `client` (one registered before, from the
// token kept) is used again if its redirect URL is the same, else a new one is registered; either
// way it's in the token as `client`, for refresh. `scope` may be a function of the scopes the
// server lists, to ask for only some of them.
export async function login({ mcpUrl, clientId, clientSecret, client, redirectUri, scope, open, defaults, clientName, fetchImpl = fetch, timeoutMs = 5 * 60_000, now = () => Date.now() }) {
  callbackAddress(redirectUri);
  const ep = await discover(mcpUrl, { fetchImpl, defaults });
  if (!ep.authorization_endpoint || !ep.token_endpoint) throw new Error(`${new URL(mcpUrl).host} doesn't say where to log in`);
  if (typeof scope === 'function') scope = scope(ep.scopes_supported);
  if (!clientId) {
    if (!(client?.client_id && client.redirect_uri === redirectUri)) {
      if (!ep.registration_endpoint) throw new Error('set the client ID first');
      client = await register(ep.registration_endpoint, { redirectUri, scope, clientName, fetchImpl, now: now() });
    }
    ({ client_id: clientId, client_secret: clientSecret } = client);
  } else client = null;
  const { verifier, challenge } = pkce();
  const state = b64url(randomBytes(16));
  const auth = new URL(ep.authorization_endpoint);
  for (const [k, v] of Object.entries({ client_id: clientId, scope, redirect_uri: redirectUri, state, response_type: 'code',
    code_challenge: challenge, code_challenge_method: 'S256', ...(ep.resource && { resource: ep.resource }) })) if (v) auth.searchParams.set(k, v);
  const back = waitForCode(redirectUri, state, { timeoutMs });
  await back.ready;
  const opened = Promise.resolve(open(auth.href));
  const got = await back.code;
  await opened;
  if (!got) throw new Error('the browser came back without a code');
  const body = await postForm(ep.token_endpoint, { grant_type: 'authorization_code', code: got, redirect_uri: redirectUri,
    client_id: clientId, client_secret: clientSecret, code_verifier: verifier }, fetchImpl);
  return { ...readToken(body, now()), token_endpoint: ep.token_endpoint, ...(client && { client }) };
}

// A new access token from the refresh token, when the old one has run out.
// A registered client (token.client) is used when no client ID is given.
export async function refresh(token, { clientId, clientSecret, fetchImpl = fetch, now = Date.now() }) {
  if (!clientId && token?.client) ({ client_id: clientId, client_secret: clientSecret } = token.client);
  if (!token?.refresh_token || !token.token_endpoint) throw Object.assign(new Error('the login ran out; log in again'), { auth: true });
  const body = await postForm(token.token_endpoint, { grant_type: 'refresh_token',
    refresh_token: token.refresh_token, client_id: clientId, client_secret: clientSecret }, fetchImpl);
  const t = readToken(body, now);
  return { ...token, ...t, refresh_token: t.refresh_token || token.refresh_token, user: t.user || token.user, team: t.team || token.team };
}

export const expiresSoon = (t, now = Date.now()) => !!t?.expires_at && t.expires_at - now < 60_000;
