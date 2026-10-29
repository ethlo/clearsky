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
  const ask0 = (url, body) => fetch(url, { method: 'POST', headers: { 'X-Clearsky-Token': csrf, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const ask = (body, token = csrf) => fetch(`${base}/api/copilot`, { method: 'POST', headers: { 'X-Clearsky-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await ask({ message: 'hi', session: 'sess-1234' }, 'wrong')).status, 403);

  // Answers stream as JSON lines; join the text events.
  const events = async (res) => (await res.text()).trim().split('\n').map((l) => JSON.parse(l));
  const textOf = (evs) => evs.filter((e) => e.type === 'text').map((e) => e.text).join('');
  const first = textOf(await events(await ask({ message: 'What first?', session: 'sess-1234', model: 'claude-opus-5', permission: 'read', allow: 'shell(git:*)' })));
  assert.ok(first.startsWith('Hello '));
  const r = JSON.parse(first.slice(6));
  assert.match(r.prompt, /work dashboard[\s\S]*What first\?$/);
  assert.equal(r.session, 'sess-1234');
  assert.equal(r.model, 'claude-opus-5');
  assert.equal(r.hasToken, false, "Clearsky's tokens aren't passed to Copilot");
  assert.ok(r.flags.includes('--deny-tool') && r.flags.includes('--allow-tool'));

  const next = JSON.parse(textOf(await events(await ask({ message: 'And then?', session: 'sess-1234', resume: true, permission: 'full' }))).slice(6));
  assert.equal(next.prompt, 'And then?');
  assert.equal(next.resume, 'sess-1234');
  assert.equal((await ask({ message: 'x', session: 'sess-1234', model: 'bad model; rm' })).status, 400);

  // Ask mode: Copilot's approval question shows up in the stream and the answer goes back.
  const res = await ask({ message: 'Check the repo', session: 'sess-ask-1', permission: 'ask' });
  const reader = res.body.getReader(), dec = new TextDecoder();
  let buf = '', perm = null;
  const seen = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    for (const l of buf.split('\n').slice(0, -1)) seen.push(JSON.parse(l));
    buf = buf.split('\n').at(-1);
    if (!perm && (perm = seen.find((e) => e.type === 'permission'))) {
      assert.equal(perm.detail, 'git status');
      assert.deepEqual(perm.options.map((o) => o.id), ['yes', 'no']);
      const ok = await ask0(`${base}/api/copilot/permission`, { chat: 'sess-ask-1', id: perm.id, option: 'yes' });
      assert.equal(ok.status, 200);
    }
  }
  assert.ok(perm, 'got a permission question');
  assert.match(textOf(seen), /flags=\s*answer=yes|answer=yes/);
  assert.ok(!/--allow-all-tools/.test(textOf(seen)), 'Ask mode does not pre-approve tools');
  assert.deepEqual(seen.filter((e) => e.type === 'tool').map((e) => e.status), ['pending', 'completed']);
  assert.equal(seen.at(-1).type, 'done');
});
