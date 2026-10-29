import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { mkdtempSync, copyFileSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadSources } from '../lib/sources.mjs';

// The test source, copied so its file mode is ours whatever the checkout's umask was.
function sourcesDir() {
  const dir = mkdtempSync(join(tmpdir(), 'clearsky-src-'));
  copyFileSync(fileURLToPath(new URL('./sources/school.mjs', import.meta.url)), join(dir, 'school.mjs'));
  chmodSync(join(dir, 'school.mjs'), 0o644);
  return dir;
}

test('loads source modules and refuses broken or unsafe ones', async () => {
  const dir = sourcesDir();
  writeFileSync(join(dir, 'bad.mjs'), 'export default { name: "Bad Name", fetch() {} };', { mode: 0o644 });
  writeFileSync(join(dir, 'github.mjs'), 'export default { name: "github", fetch() {} };', { mode: 0o644 });
  writeFileSync(join(dir, 'open.mjs'), 'export default { name: "open", fetch() {} };');
  chmodSync(join(dir, 'open.mjs'), 0o666);
  const { sources, errors } = await loadSources([dir, join(dir, 'missing')]);
  assert.deepEqual([...sources.keys()], ['school']);
  assert.equal(sources.get('school').panel.zone, 'track');
  assert.equal(errors.length, 3);
  assert.ok(errors.some((e) => /lowercase/.test(e)) && errors.some((e) => /built-in/.test(e)) && errors.some((e) => /writable by others/.test(e)));
  // The repo's own folder is trusted like the rest of its code, whatever the umask made of it.
  assert.ok((await loadSources([dir], { trusted: [dir] })).sources.has('open'));
});

test('an extra source shows up in the page, notifications, Now / Next, stand-up and Settings', async (t) => {
  const port = 7700 + Math.floor(Math.random() * 80);
  const base = `http://127.0.0.1:${port}`;
  const home = mkdtempSync(join(tmpdir(), 'clearsky-src-home-'));
  const server = spawn(process.execPath, [fileURLToPath(new URL('../bin/clearsky.mjs', import.meta.url)), 'serve', '--port', String(port)], {
    cwd: home, stdio: 'ignore',
    env: { PATH: process.env.PATH, HOME: home, CLEARSKY_POLL_MINUTES: '0', CLEARSKY_SOURCES_DIR: sourcesDir(), SCHOOL_CHILD: 'Ada',
      GITHUB_TOKEN: 'x', GITHUB_API_URL: 'http://127.0.0.1:9', ACLI_BIN: '/nonexistent/acli', COPILOT_BIN: '/nonexistent/copilot' },
  });
  t.after(() => server.kill());
  for (let i = 0; i < 50; i++) { try { await fetch(base); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  const get = async (p) => (await fetch(base + p)).json();

  // Sources shipped in lib/sources load too; this test is about the one from CLEARSKY_SOURCES_DIR.
  assert.deepEqual((await get('/api/sources')).sources.filter((s) => s.name === 'school'), [{ name: 'school', label: 'School', area: 'personal', panel: { zone: 'track', title: 'School' } }]);
  const school = await get('/api/source/school');
  assert.deepEqual(school.items.map((i) => i.title), ['Teacher: Trip on Friday']);
  const att = await get('/api/attention');
  assert.ok(att.items.some((i) => i.key === 'school:m1' && i.kind === 'school'));
  const plan = await get('/api/plan');
  assert.ok(plan.plan.agenda.some((e) => e.title === 'Ada: Swimming' && e.fyi && e.calendar === 'School') || new Date().getHours() >= 13);
  const su = await get('/api/standup');
  assert.match(su.text, /School: Ada has Swimming/);
  const detail = await get('/api/source/school/detail?key=m1');
  assert.deepEqual([detail.child, detail.messages[0].text], ['Ada', 'Bring a packed lunch']);
  const file = await fetch(`${base}/api/source/school/attachment?key=m1&id=f1`);
  assert.equal(file.headers.get('content-type'), 'application/octet-stream', 'HTML from a source is never served as a page');
  assert.match(file.headers.get('content-disposition'), /^attachment; filename\*=UTF-8''trip\.html$/);
  assert.match(file.headers.get('content-security-policy'), /^sandbox/);
  assert.equal(file.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await fetch(`${base}/api/source/github/detail?key=x`)).status, 404);
  const rebound = await new Promise((resolve) => request({ host: '127.0.0.1', port, path: '/api/source/school', headers: { Host: `evil.example:${port}` } }, resolve).end());
  assert.equal(rebound.statusCode, 421, 'only answers to its own host names');
  const st = await get('/api/settings');
  assert.deepEqual(st.extra.filter((f) => f.key.startsWith('SCHOOL_')).map((f) => [f.key, f.secret, f.value]), [['SCHOOL_CHILD', false, 'Ada'], ['SCHOOL_TOKEN', true, null]]);
});

test('a source login runs from Settings, saves what it learns, and fixes a panel that asked for it', async (t) => {
  const port = 7780 + Math.floor(Math.random() * 80);
  const base = `http://127.0.0.1:${port}`;
  const home = mkdtempSync(join(tmpdir(), 'clearsky-src-home-'));
  const server = spawn(process.execPath, [fileURLToPath(new URL('../bin/clearsky.mjs', import.meta.url)), 'serve', '--port', String(port)], {
    cwd: home, stdio: 'ignore',
    env: { PATH: process.env.PATH, HOME: home, CLEARSKY_POLL_MINUTES: '0', CLEARSKY_SOURCES_DIR: sourcesDir(), SCHOOL_CHILD: 'expired',
      GITHUB_TOKEN: 'x', GITHUB_API_URL: 'http://127.0.0.1:9', ACLI_BIN: '/nonexistent/acli', COPILOT_BIN: '/nonexistent/copilot' },
  });
  t.after(() => server.kill());
  for (let i = 0; i < 50; i++) { try { await fetch(base); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  const get = async (p) => (await fetch(base + p)).json();
  const csrf = (await (await fetch(`${base}/settings`)).text()).match(/const CSRF = '([^']+)'/)[1];
  const post = async (p) => (await fetch(base + p, { method: 'POST', headers: { 'X-Clearsky-Token': csrf, 'Content-Type': 'application/json' }, body: '{}' })).json();
  const school = (st) => st.logins.find((l) => l.name === 'school');

  const before = await get('/api/source/school');
  assert.equal(before.needsLogin, true);
  assert.deepEqual(school(await get('/api/settings')), { name: 'school', label: 'School', button: 'Log in with Testid', loggedIn: false, detail: 'Not logged in', running: false, error: null });

  assert.equal(school(await post('/api/source/school/login')).running, true);
  let st;
  for (let i = 0; i < 30 && (st = school(await get('/api/settings'))).running; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(st.loggedIn, true);
  const saved = readFileSync(join(home, '.config', 'clearsky', '.env'), 'utf8');
  assert.match(saved, /^SCHOOL_CHILD=Bea$/m);
  assert.doesNotMatch(saved, /GITHUB_TOKEN/, 'a source only sets its own settings');
  assert.deepEqual((await get('/api/source/school')).items.map((i) => i.meta), ['Bea']);

  assert.equal((await fetch(`${base}/api/source/github/login`, { method: 'POST', headers: { 'X-Clearsky-Token': csrf } })).status, 404);
});

test('a source says whether it is work or personal', async () => {
  const { checkSource } = await import('../lib/sources.mjs');
  const base = { name: 'gym', fetch() {} };
  assert.equal(checkSource({ default: base }, 'gym.mjs').area, 'personal');
  assert.equal(checkSource({ default: { ...base, area: 'work' } }, 'gym.mjs').area, 'work');
  assert.throws(() => checkSource({ default: { ...base, area: 'home' } }, 'gym.mjs'), /area/);
});
