// A client registered for fewer scopes than a login now asks for is registered again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { login } from '../lib/mcp-oauth.mjs';

test('a wider scope registers a new client; the same scope keeps it; the token says what was asked and offered', async (t) => {
  const regs = [];
  let base = '', challenge = '';
  const srv = createServer(async (req, res) => {
    const u = new URL(req.url, base);
    let b = ''; for await (const c of req) b += c;
    const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (u.pathname === '/.well-known/oauth-protected-resource/mcp') return send(200, { resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ['read:x', 'write:x'] });
    if (u.pathname === '/.well-known/oauth-authorization-server') return send(200, { issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register` });
    if (u.pathname === '/register') { regs.push(JSON.parse(b).scope); return send(201, { client_id: `c${regs.length}` }); }
    if (u.pathname === '/authorize') { challenge = u.searchParams.get('code_challenge'); const back = new URL(u.searchParams.get('redirect_uri')); back.searchParams.set('code', 'k'); back.searchParams.set('state', u.searchParams.get('state')); res.writeHead(302, { Location: back.href }); return res.end(); }
    if (u.pathname === '/token') { const f = Object.fromEntries(new URLSearchParams(b)); assert.equal(createHash('sha256').update(f.code_verifier).digest('base64url'), challenge); return send(200, { access_token: 'a', expires_in: 60, scope: 'read:x' }); }
    send(404, {});
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  base = `http://127.0.0.1:${srv.address().port}`;
  const port = await new Promise((r) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const go = (scope, client) => login({ mcpUrl: `${base}/mcp`, client, redirectUri: `http://localhost:${port}/cb`, scope, open: (u) => { fetch(u).catch(() => {}); } });
  const a = await go('read:x');
  assert.deepEqual([a.client.client_id, a.client.scope, a.asked, a.offered, a.scope], ['c1', 'read:x', 'read:x', 'read:x write:x', 'read:x']);
  const b = await go('read:x', a.client);
  assert.equal(b.client.client_id, 'c1', 'same scope: the same client');
  const c = await go('read:x write:x', b.client);
  assert.equal(c.client.client_id, 'c2', 'wider scope: a new client');
  assert.deepEqual(regs, ['read:x', 'read:x write:x']);
});
