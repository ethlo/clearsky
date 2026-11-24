// Every route of the server, against the demo (made-up data, its own port and home folder):
// each page and read answers with what the page expects, and nothing is changed without the
// page's token. The lists below name every route in lib/app/routes; a route that isn't in
// them fails the last test, so a new one gets a line here and a moved one is noticed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitUp } from '../lib/demo.mjs';

const bin = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'clearsky.mjs');

// Pages and files: path → content type.
const PAGES = { '/': 'text/html', '/index.html': 'text/html', '/settings': 'text/html', '/welcome': 'text/html',
  '/manifest.webmanifest': 'application/manifest+json', '/icon.svg': 'image/svg+xml' };

// Reads: path → fields the answer has.
const READS = {
  '/api/actions': ['actions'], '/api/agent-log': ['writes'], '/api/attention': ['lastPoll', 'dataVersion', 'items'], '/api/branches': ['branches'],
  '/api/builds': ['repos', 'checkedAt'], '/api/copilot': ['available', 'cwd', 'skills', 'agent', 'agents', 'commands'],
  '/api/copilot/chat': ['running', 'busy', 'sandboxed'], '/api/copilot/checkpoints': ['checkpoints', 'busy'], '/api/copilot/files': ['files'], '/api/copilot/jobs': ['jobs', 'watchdog'],
  '/api/copilot/links': ['links', 'live', 'actions'], '/api/copilot/map': ['chats'], '/api/copilot/memory': ['path', 'text', 'max'],
  '/api/copilot/sessions': ['cwd', 'sessions'], '/api/copilot/usage': ['total', 'today', 'week', 'month'], '/api/dismissed': ['dismissed', 'muted'],
  '/api/doctor': ['checks', 'ready', 'platform', 'tracker'], '/api/handoffs': ['handoffs', 'sandbox'], '/api/jira/projects': ['projects', 'starred'],
  '/api/jira/starred': ['starred'], '/api/links': ['groups'], '/api/modules': ['modules'], '/api/notifications/log': ['log', 'pollMinutes'],
  '/api/plan': ['plan', 'nextStandup', 'summary'], '/api/plugins': ['all', 'added', 'available'], '/api/restart': ['pending', 'busy', 'updateReady', 'reasons'], '/api/schedules': ['schedules', 'running', 'sandbox'],
  '/api/servers': ['hosts'], '/api/settings': ['file', 'github', 'jira', 'tracker', 'calendar'], '/api/sources': ['tracker', 'sources', 'errors'],
  '/api/standup': ['generatedAt', 'since', 'nextStandup'], '/api/standup/say': ['text'], '/api/team': ['team'], '/api/vm': ['vm', 'support'],
  '/api/vms': ['limit', 'running', 'waiting', 'vms'], '/api/vpn': ['known', 'up'], '/api/work': ['generatedAt', 'plan', 'summary', 'github', 'jira'],
  // Routes with a name in the path.
  '/api/source/github': ['login', 'reviewRequested', 'myPrs'], '/api/issue/OPS-1': ['key', 'summary', 'status'], '/api/issue/OPS-1/prs': ['key', 'prs'],
  '/api/copilot/sessions/abcdefgh': ['id', 'cwd'],
};

// Reads that need to be told what to read: without it they say so, and don't fall over.
const NEEDS = { '/api/copilot/file': 404, '/api/copilot/job-log': 404, '/api/copilot/outputs': 400, '/api/jira/version': 400, '/api/jira/versions': 400,
  '/api/pr': 400, '/api/pr/reviewers': 400, '/api/source/nope': 404, '/api/nope': 404, '/nope': 404 };

// Changes: POST only, and only with the page's token.
const WRITES = ['/api/calendar/hidden', '/api/copilot', '/api/copilot/attach', '/api/copilot/close', '/api/copilot/folders', '/api/copilot/jobs/stop',
  '/api/copilot/memory', '/api/copilot/permission', '/api/copilot/rename', '/api/copilot/rewind', '/api/copilot/stop', '/api/copilot/watchdog', '/api/demo/start', '/api/demo/stop',
  '/api/dismiss', '/api/handoffs', '/api/jira/star', '/api/links', '/api/links/import', '/api/login/github', '/api/login/jira', '/api/mute', '/api/open',
  '/api/plugins/add', '/api/plugins/check', '/api/plugins/preview', '/api/plugins/remove', '/api/plugins/update', '/api/pr/merge', '/api/push/test', '/api/pr/request-review',
  '/api/read', '/api/restart', '/api/schedules', '/api/settings', '/api/team/join', '/api/team/scaffold', '/api/vm/stop', '/api/vms/image-cache/purge',
  '/api/source/github/login', '/api/source/github/logins'];

const port = 17300 + Math.floor(Math.random() * 400);
const base = `http://127.0.0.1:${port}`;
let child, csrf = '';

before(async () => {
  const env = { ...process.env };
  delete env.CLEARSKY_DEMO_HOME;
  child = spawn(process.execPath, [bin, 'try', '--no-open', '--port', String(port)], { env, stdio: 'ignore' });
  assert.ok(await waitUp(port, 20_000), 'the demo is up');
  csrf = (await (await fetch(base)).text()).match(/name="csrf" content="(\w+)"/)[1];
});
after(async () => {
  // Leave demo: it stops itself and removes its home folder.
  await fetch(`${base}/api/demo/stop`, { method: 'POST', headers: { 'x-clearsky-token': csrf, 'content-type': 'application/json' }, body: '{}' }).catch(() => {});
  await Promise.race([new Promise((ok) => { child.once('exit', ok); }), new Promise((ok) => { setTimeout(ok, 3000); })]);
  child.kill();
});

test('every page and file is served', async () => {
  for (const [path, type] of Object.entries(PAGES)) {
    const r = await fetch(base + path);
    assert.equal(r.status, 200, path);
    assert.ok(r.headers.get('content-type').startsWith(type), `${path} is ${type}`);
    assert.ok((await r.arrayBuffer()).byteLength > 100, `${path} has something in it`);
  }
  const icon = await fetch(`${base}/favicon.ico`, { redirect: 'manual' });
  assert.equal(icon.status, 302);
  assert.equal(icon.headers.get('location'), '/icon.svg');
});

test('every read answers with the fields the page uses', async () => {
  for (const [path, fields] of Object.entries(READS)) {
    const r = await fetch(base + path);
    assert.equal(r.status, 200, path);
    assert.match(r.headers.get('content-type'), /^application\/json/, path);
    const body = await r.json();
    for (const f of fields) assert.ok(Object.hasOwn(body, f), `${path} has "${f}"`);
  }
});

test('a read that isn\'t told what to read says so', async () => {
  for (const [path, status] of Object.entries(NEEDS)) {
    const r = await fetch(base + path);
    assert.equal(r.status, status, path);
    await r.arrayBuffer();
  }
});

test('nothing is changed without the page\'s token, or from another site', async () => {
  const post = (path, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' });
  for (const path of WRITES) {
    const none = await post(path);
    assert.equal(none.status, 403, `${path} without the token`);
    await none.arrayBuffer();
    const wrong = await post(path, { 'x-clearsky-token': 'x'.repeat(csrf.length) });
    assert.equal(wrong.status, 403, `${path} with a wrong token`);
    await wrong.arrayBuffer();
  }
  const elsewhere = await post('/api/settings', { 'x-clearsky-token': csrf, origin: 'https://example.org' });
  assert.equal(elsewhere.status, 403, 'the right token from another site');
  // A change is not a read: the same paths don't change anything on GET.
  for (const path of ['/api/pr/merge', '/api/copilot/stop', '/api/plugins/add', '/api/team/join']) assert.equal((await fetch(base + path)).status, 404, `GET ${path}`);
  assert.equal((await post('/api/nope', { 'x-clearsky-token': csrf })).status, 404);
});

test('every route in the server is named above', () => {
  const dir = join(dirname(bin), '..', 'lib', 'app', 'routes');
  const src = readdirSync(dir).filter((f) => f.endsWith('.mjs')).map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');
  const inSource = new Set([...src.matchAll(/url\.pathname === '([^']+)'/g)].map((m) => m[1]));
  // Routes live only there: the server hands every request to those groups, and the main file has none.
  for (const f of [bin, join(dir, '..', 'server.mjs')]) assert.doesNotMatch(readFileSync(f, 'utf8'), /url\.pathname ===/, f);
  const named = new Set([...Object.keys(PAGES), ...Object.keys(READS), ...Object.keys(NEEDS), ...WRITES, '/favicon.ico']);
  assert.deepEqual([...inSource].filter((p) => !named.has(p)).sort(), [], 'routes with no line in test/routes.test.mjs');
  assert.ok(inSource.size > 70, 'the routes were found in the source');
});
