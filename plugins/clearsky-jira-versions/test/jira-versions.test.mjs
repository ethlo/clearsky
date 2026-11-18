// The door's commands, the change it works out, and the whole plugin against a fake Atlassian
// (OAuth with dynamic client registration and an MCP server with Atlassian-shaped Jira tools).
// Nothing here reaches a real Atlassian site; the tickets are made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCommand, pickTool, fixVersionsOf, change, jiraScopes, createVersions, sitesOf, REDIRECT } from '../lib/jira-versions.mjs';
import makePlugin from '../source.mjs';
import { core } from './core.mjs';

const { sourceFromDir, parseManifest, PLUGIN_LENDS } = await core('lib/plugins.mjs');
const { tokenStore } = await core('lib/mcp-oauth.mjs');

test('the manifest is valid and gives chats one door', () => {
  const m = parseManifest(JSON.parse(readFileSync(new URL('../clearsky-plugin.json', import.meta.url), 'utf8')));
  assert.deepEqual(m.doors.map((d) => d.name), ['jira-versions']);
});

test('commands are checked before anything reaches Jira', () => {
  assert.deepEqual(parseCommand(['add', '1.7.0', 'ACME-1', 'acme-2,ACME-3', 'ACME-1']), { cmd: 'add', versions: ['1.7.0'], keys: ['ACME-1', 'ACME-2', 'ACME-3'] });
  assert.deepEqual(parseCommand(['remove', '1.7.0, 1.7.1', 'ACME-4']), { cmd: 'remove', versions: ['1.7.0', '1.7.1'], keys: ['ACME-4'] });
  assert.deepEqual(parseCommand(['show', 'ACME-1']), { cmd: 'show', keys: ['ACME-1'] });
  assert.deepEqual(parseCommand([]), { cmd: 'help' });
  assert.match(parseCommand(['add', 'ACME-1', 'ACME-2']).error, /version first/);
  assert.match(parseCommand(['add', '1.7.0']).error, /tickets/);
  assert.match(parseCommand(['add', '1.7.0', 'not-a-key']).error, /not a ticket key/);
  assert.match(parseCommand(['add', '1.7.0', 'ACME-1', '--jql', 'x']).error, /unknown option/);
  assert.match(parseCommand(['set', '1.7.0', 'ACME-1']).error, /unknown command/);
  assert.match(parseCommand(['show']).error, /tickets/);
});

test('the change keeps the other versions and matches names as Jira does', () => {
  const had = [{ id: '10', name: '1.6.0' }, { id: '11', name: '1.7.0' }];
  assert.deepEqual(change(had, 'add', ['1.7.0']), { after: had, changed: false });
  assert.deepEqual(change(had, 'add', ['1.8.0']), { after: [...had, { name: '1.8.0' }], changed: true });
  assert.deepEqual(change(had, 'remove', [' 1.7.0 ']), { after: [had[0]], changed: true });
  assert.deepEqual(change(had, 'remove', ['2.0']), { after: had, changed: false });
  assert.deepEqual(fixVersionsOf({ content: [{ type: 'text', text: JSON.stringify({ key: 'A-1', fields: { fixVersions: [{ id: 10, name: '1.6.0', released: true }] } }) }] }), [{ id: '10', name: '1.6.0' }]);
  assert.deepEqual(fixVersionsOf({ content: [{ type: 'text', text: '{"fields":{"fixVersions":null}}' }] }), []);
  assert.equal(fixVersionsOf({ content: [{ type: 'text', text: 'Issue A-1: summary' }] }), null, 'not JSON: no guess');
  assert.equal(fixVersionsOf({ content: [{ type: 'text', text: '{"fields":{"summary":"x"}}' }] }), null, 'no fixVersions field: no guess');
  assert.equal(pickTool([{ name: 'getJiraIssue' }, { name: 'editJiraIssue' }], 'edit').name, 'editJiraIssue');
  assert.equal(jiraScopes(['read:me', 'offline_access', 'read:jira-work', 'write:jira-work', 'manage:jira-configuration', 'read:confluence:agent-interface', 'read:jira:agent-interface', 'write:jira:agent-interface']),
    'read:me offline_access read:jira-work write:jira-work read:jira:agent-interface write:jira:agent-interface');
});

// An in-memory Jira behind Atlassian-shaped tools.
function fakeClient(issues) {
  const calls = [];
  const tools = [
    { name: 'getAccessibleAtlassianResources', inputSchema: { properties: {} } },
    { name: 'getJiraIssue', annotations: { readOnlyHint: true }, inputSchema: { properties: { cloudId: {}, issueIdOrKey: {}, fields: {} } } },
    { name: 'editJiraIssue', inputSchema: { properties: { cloudId: {}, issueIdOrKey: {}, fields: {} } } },
    { name: 'transitionJiraIssue', inputSchema: { properties: { cloudId: {}, issueIdOrKey: {}, transition: {} } } },
  ];
  const text = (t) => ({ content: [{ type: 'text', text: typeof t === 'string' ? t : JSON.stringify(t) }] });
  return {
    calls,
    issues,
    listTools: async () => tools,
    async callTool(name, a) {
      calls.push({ name, args: a });
      if (name === 'getAccessibleAtlassianResources') return text([{ id: 'cloud-1', url: 'https://acme.atlassian.net' }]);
      const i = issues[a.issueIdOrKey];
      if (!i) return { isError: true, ...text(`Issue ${a.issueIdOrKey} does not exist or you do not have permission to see it.`) };
      if (name === 'getJiraIssue') return text({ key: a.issueIdOrKey, fields: { fixVersions: i.fixVersions } });
      if (name === 'editJiraIssue') {
        const bad = a.fields.fixVersions.find((v) => !v.id && !['1.7.0', '1.8.0'].includes(v.name));
        if (bad) return { isError: true, ...text(`Version name '${bad.name}' is not valid`) };
        i.fixVersions = a.fields.fixVersions.map((v) => (v.id ? i.fixVersions.find((h) => h.id === v.id) : { id: `n-${v.name}`, name: v.name }));
        return text({ ok: true });
      }
      return { isError: true, ...text('no') };
    },
  };
}

test('add asks once with each ticket before and after, then writes only fixVersions', async () => {
  const client = fakeClient({ 'ACME-1': { fixVersions: [{ id: '10', name: '1.6.0' }] }, 'ACME-2': { fixVersions: [{ id: '11', name: '1.7.0' }] }, 'ACME-3': { fixVersions: [] } });
  const kept = [];
  const v = createVersions({ client, keepSite: (s) => kept.push(s) });
  const asked = [];
  const r = await v.run(parseCommand(['add', '1.7.0', 'ACME-1', 'ACME-2', 'ACME-3']), async (d) => { asked.push(d); return true; });
  assert.equal(r.code, 0, r.stdout);
  assert.equal(asked.length, 1);
  assert.match(asked[0], /^Add fix version 1\.7\.0 to ACME-1, ACME-3\n/);
  assert.match(asked[0], /ACME-1: 1\.6\.0 → 1\.6\.0, 1\.7\.0/);
  assert.match(asked[0], /ACME-2: 1\.7\.0 \(has it already\)/);
  assert.match(asked[0], /ACME-3: \(none\) → 1\.7\.0/);
  const edits = client.calls.filter((c) => c.name === 'editJiraIssue');
  assert.deepEqual(edits.map((c) => c.args), [
    { cloudId: 'https://acme.atlassian.net', issueIdOrKey: 'ACME-1', fields: { fixVersions: [{ id: '10' }, { name: '1.7.0' }] } },
    { cloudId: 'https://acme.atlassian.net', issueIdOrKey: 'ACME-3', fields: { fixVersions: [{ name: '1.7.0' }] } },
  ]);
  assert.deepEqual(client.calls.find((c) => c.name === 'getJiraIssue').args.fields, ['fixVersions']);
  assert.deepEqual(kept, ['https://acme.atlassian.net']);
  assert.match(r.stdout, /ACME-1: now 1\.6\.0, 1\.7\.0\nACME-2: 1\.7\.0 \(unchanged\)\nACME-3: now 1\.7\.0/);
  assert.equal(r.target, 'ACME-1, ACME-2, ACME-3');
});

test('a decline changes nothing; nothing to change asks nothing; failures are reported per ticket', async () => {
  const client = fakeClient({ 'ACME-1': { fixVersions: [{ id: '11', name: '1.7.0' }] }, 'ACME-2': { fixVersions: [] } });
  const v = createVersions({ client, site: () => 'https://acme.atlassian.net' });
  const no = await v.run(parseCommand(['remove', '1.7.0', 'ACME-1']), async () => false);
  assert.equal(no.code, 1);
  assert.equal(no.decided, 'declined');
  assert.ok(!client.calls.some((c) => c.name === 'editJiraIssue'));
  assert.ok(!client.calls.some((c) => c.name === 'getAccessibleAtlassianResources'), 'a set site is used as is');

  let asked = 0;
  const none = await v.run(parseCommand(['remove', '2.0', 'ACME-1', 'ACME-2']), async () => { asked++; return true; });
  assert.equal(asked, 0);
  assert.match(none.stdout, /^Nothing to change/);

  const mixed = await v.run(parseCommand(['add', '9.9', 'ACME-2', 'ACME-404']), async () => true);
  assert.equal(mixed.code, 1);
  assert.match(mixed.stdout, /ACME-2: not changed: Jira said: Version name '9\.9' is not valid/);
  assert.match(mixed.stdout, /ACME-404: Jira said: Issue ACME-404 does not exist/);

  const ok = await v.run(parseCommand(['remove', '1.7.0', 'ACME-1']), async () => true);
  assert.equal(ok.code, 0);
  assert.deepEqual(client.issues['ACME-1'].fixVersions, []);
  const show = await v.run(parseCommand(['show', 'ACME-1', 'ACME-2']), async () => { throw new Error('show never asks'); });
  assert.equal(show.stdout, 'ACME-1: (none)\nACME-2: (none)');
});

test('the site: the setting, else Clearsky\'s Jira site, else the one the login sees; never a call without one', async () => {
  const text = (t) => ({ content: [{ type: 'text', text: t }] });
  assert.deepEqual(sitesOf(text(JSON.stringify([{ id: 'c1', url: 'https://acme.atlassian.net', name: 'acme' }]))), ['https://acme.atlassian.net']);
  assert.deepEqual(sitesOf({ structuredContent: { resources: [{ id: 'c1', url: 'https://Acme.atlassian.net/' }] } }), ['https://acme.atlassian.net']);
  assert.deepEqual(sitesOf(text(JSON.stringify({ sites: [{ cloudId: 'c1', url: 'https://a.atlassian.net' }, { url: 'https://a.atlassian.net' }] }))), ['https://a.atlassian.net']);
  assert.deepEqual(sitesOf(text('You can reach these sites:\n- acme (https://acme.atlassian.net), cloud id c1')), ['https://acme.atlassian.net']);
  assert.deepEqual(sitesOf(text('nothing here')), []);

  const issues = { 'ACME-1': { fixVersions: [] } };
  // Clearsky's own Jira site, so the site list isn't asked for.
  let client = fakeClient(issues);
  let v = createVersions({ client, clearskySite: async () => 'https://acme.atlassian.net' });
  assert.equal((await v.run(parseCommand(['show', 'ACME-1']), async () => true)).code, 0);
  assert.equal(client.calls.find((c) => c.name === 'getJiraIssue').args.cloudId, 'https://acme.atlassian.net');
  assert.ok(!client.calls.some((c) => c.name === 'getAccessibleAtlassianResources'));

  // A site list Clearsky can't use: a clear error, and no Jira call without a site.
  for (const [answer, why] of [[{ content: [{ type: 'text', text: 'no sites' }] }, /couldn't find a Jira site/],
    [{ content: [{ type: 'text', text: '[{"url":"https://a.atlassian.net"},{"url":"https://b.atlassian.net"}]' }] }, /sees 2 sites \(a\.atlassian\.net, b\.atlassian\.net\)/],
    [{ isError: true, content: [{ type: 'text', text: 'scope missing' }] }, /wouldn't list your sites \(scope missing\)/]]) {
    client = fakeClient(issues);
    const call = client.callTool;
    client.callTool = (n, a) => (n === 'getAccessibleAtlassianResources' ? (client.calls.push({ name: n }), answer) : call(n, a));
    v = createVersions({ client, clearskySite: async () => null });
    await assert.rejects(v.run(parseCommand(['show', 'ACME-1']), async () => true), (e) => why.test(e.message) && /Set Jira site under Settings → Plugins → Jira versions/.test(e.message) && e.site);
    assert.ok(!client.calls.some((c) => c.name === 'getJiraIssue'), 'no call without a site');
  }
});

// ---------------------------------------------------------------- the whole plugin, with a login

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
const readBody = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => r(b)); });
const SCOPES = ['read:me', 'offline_access', 'read:jira:agent-interface', 'write:jira:agent-interface', 'read:confluence:agent-interface', 'write:confluence:agent-interface'];

async function fakeAtlassian() {
  const seen = { calls: [], auth: null, challenge: null, clients: new Set() };
  const jira = fakeClient({ 'ACME-1': { fixVersions: [] } });
  let base = '';
  const srv = createServer(async (req, res) => {
    const u = new URL(req.url, base);
    const send = (code, body, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
    if (u.pathname === '/.well-known/oauth-protected-resource/v2/mcp') return send(200, { resource: `${base}/v2/mcp`, authorization_servers: [`${base}/t`], scopes_supported: SCOPES });
    if (u.pathname === '/.well-known/oauth-authorization-server/t') return send(200, { issuer: `${base}/t`, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`, code_challenge_methods_supported: ['S256'] });
    if (u.pathname === '/register') { const b = JSON.parse(await readBody(req)); seen.clients.add('c1'); return send(201, { client_id: 'c1', redirect_uris: b.redirect_uris, token_endpoint_auth_method: 'none' }); }
    if (u.pathname === '/authorize') {
      seen.auth = Object.fromEntries(u.searchParams);
      seen.challenge = u.searchParams.get('code_challenge');
      const back = new URL(u.searchParams.get('redirect_uri'));
      back.searchParams.set('code', 'the-code');
      back.searchParams.set('state', u.searchParams.get('state'));
      res.writeHead(302, { Location: back.href }); return res.end();
    }
    if (u.pathname === '/token') {
      const f = Object.fromEntries(new URLSearchParams(await readBody(req)));
      if (!seen.clients.has(f.client_id) || createHash('sha256').update(f.code_verifier || '').digest('base64url') !== seen.challenge) return send(400, { error: 'invalid_grant' });
      return send(200, { access_token: 'at-1', refresh_token: 'refresh-1', expires_in: 3600, token_type: 'Bearer' });
    }
    if (u.pathname === '/v2/mcp') {
      if (req.headers.authorization !== 'Bearer at-1') { res.writeHead(401, { 'WWW-Authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/v2/mcp"` }); return res.end(); }
      const msg = JSON.parse(await readBody(req));
      if (msg.id == null) { res.writeHead(202); return res.end(); }
      seen.calls.push({ method: msg.method, name: msg.params?.name, args: msg.params?.arguments });
      const reply = (result) => send(200, { jsonrpc: '2.0', id: msg.id, result });
      if (msg.method === 'initialize') return send(200, { jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake' } } }, { 'Mcp-Session-Id': 's' });
      if (msg.method === 'tools/list') return reply({ tools: await jira.listTools() });
      if (msg.method === 'tools/call') return reply(await jira.callTool(msg.params.name, msg.params.arguments));
    }
    send(404, { error: 'not found' });
  });
  base = `http://127.0.0.1:${await listen(srv)}`;
  return { base, seen, jira, close: () => srv.close() };
}

test('log in with Jira scopes only, then change a fix version through the door after an OK', async (t) => {
  const fake = await fakeAtlassian();
  t.after(fake.close);
  const store = tokenStore(join(mkdtempSync(join(tmpdir(), 'jira-versions-')), 'jira-versions-mcp.json'));
  const lends = { ...PLUGIN_LENDS, openUrl: (u) => { fetch(u).catch(() => {}); } };
  const p = makePlugin(lends, { store });
  const env = { JIRA_MCP_URL: `${fake.base}/v2/mcp` };
  assert.equal(p.doors['jira-versions'].hint(env), '', 'no hint before the login');
  const r = await p.logins.start('atlassian', env);
  assert.match(r.detail, /chats can now change fix versions/);
  assert.equal(fake.seen.auth.redirect_uri, REDIRECT);
  assert.equal(fake.seen.auth.scope, 'read:me offline_access read:jira:agent-interface write:jira:agent-interface', 'no Confluence');
  assert.match(p.doors['jira-versions'].hint(env), /jira-versions add/);

  const asks = [];
  const door = (argv, answer = true) => p.doors['jira-versions'].run(argv, { env, chat: { mode: 'sandboxed' }, ask: async (q) => { asks.push(q); return answer; } });
  const out = await door(['add', '1.7.0', 'ACME-1']);
  assert.equal(out.code, 0, out.stderr);
  assert.equal(asks.length, 1);
  assert.equal(asks[0].title, 'Change Jira fix versions as you');
  assert.match(asks[0].detail, /ACME-1: \(none\) → 1\.7\.0/);
  assert.deepEqual(fake.jira.issues['ACME-1'].fixVersions.map((v) => v.name), ['1.7.0']);
  assert.ok(!fake.seen.calls.some((c) => c.name === 'transitionJiraIssue'));

  assert.equal((await door(['frobnicate'])).code, 2);
  await p.logins.stop('atlassian', env);
  const after = await door(['show', 'ACME-1']);
  assert.equal(after.decided, 'not logged in');
  assert.match(after.stderr, /Settings → Plugins → Jira versions/);

  const sp = await sourceFromDir(fileURLToPath(new URL('..', import.meta.url)));
  assert.equal(sp.area, 'work');
});
