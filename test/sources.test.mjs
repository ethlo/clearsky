import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, copyFileSync, writeFileSync, chmodSync } from 'node:fs';
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

  assert.deepEqual((await get('/api/sources')).sources, [{ name: 'school', label: 'School', panel: { zone: 'track', title: 'School' } }]);
  const school = await get('/api/source/school');
  assert.deepEqual(school.items.map((i) => i.title), ['Teacher: Trip on Friday']);
  const att = await get('/api/attention');
  assert.ok(att.items.some((i) => i.key === 'school:m1' && i.kind === 'school'));
  const plan = await get('/api/plan');
  assert.ok(plan.plan.agenda.some((e) => e.title === 'Ada: Swimming' && e.fyi && e.calendar === 'School') || new Date().getHours() >= 13);
  const su = await get('/api/standup');
  assert.match(su.text, /School: Ada has Swimming/);
  const st = await get('/api/settings');
  assert.deepEqual(st.extra.map((f) => [f.key, f.secret, f.value]), [['SCHOOL_CHILD', false, 'Ada'], ['SCHOOL_TOKEN', true, null]]);
});
