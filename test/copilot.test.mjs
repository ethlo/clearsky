import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const port = 7790 + Math.floor(Math.random() * 100);
const base = `http://127.0.0.1:${port}`;

test('the chat panel talks to the local Copilot CLI with the chosen options', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'clearsky-cp-'));
  const server = spawn(process.execPath, [fileURLToPath(new URL('../bin/clearsky.mjs', import.meta.url)), 'serve', '--port', String(port)], {
    cwd: home, stdio: 'ignore',
    env: { PATH: process.env.PATH, HOME: home, GITHUB_TOKEN: 'gh-secret', COPILOT_BIN: fileURLToPath(new URL('./fake-copilot.mjs', import.meta.url)) },
  });
  t.after(() => server.kill());
  for (let i = 0; i < 50; i++) { try { await fetch(base); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }

  const info = await (await fetch(`${base}/api/copilot`)).json();
  assert.equal(info.available, true);
  assert.deepEqual(info.skills.map((s) => s.name), ['standup', 'github-pr-media']);
  assert.ok(info.permissions.read && info.efforts.includes('high'));

  const csrf = (await (await fetch(base)).text()).match(/name="csrf" content="(\w+)"/)[1];
  const ask = (body, token = csrf) => fetch(`${base}/api/copilot`, { method: 'POST', headers: { 'X-Clearsky-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await ask({ message: 'hi' }, 'wrong')).status, 403);

  const first = await (await ask({ message: 'What first?', session: 'sess-1234', model: 'claude-opus-5', permission: 'read', allow: 'shell(git:*)' })).text();
  assert.ok(first.startsWith('Hello '));
  const r = JSON.parse(first.slice(6));
  assert.match(r.prompt, /work dashboard[\s\S]*What first\?$/);
  assert.equal(r.session, 'sess-1234');
  assert.equal(r.model, 'claude-opus-5');
  assert.equal(r.hasToken, false, "Clearsky's tokens aren't passed to Copilot");
  assert.ok(r.flags.includes('--deny-tool') && r.flags.includes('--allow-tool'));

  const next = JSON.parse((await (await ask({ message: 'And then?', session: 'sess-1234', resume: true })).text()).slice(6));
  assert.equal(next.prompt, 'And then?');
  assert.equal(next.resume, true);
  assert.equal((await ask({ message: 'x', model: 'bad model; rm' })).status, 400);
});
