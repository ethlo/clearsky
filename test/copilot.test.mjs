import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const port = 7790 + Math.floor(Math.random() * 100);
const base = `http://127.0.0.1:${port}`;

test('the chat panel talks to the local Copilot CLI with the chosen options', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'clearsky-cp-'));
  const server = spawn(process.execPath, [fileURLToPath(new URL('../bin/clearsky.mjs', import.meta.url)), 'serve', '--port', String(port)], {
    cwd: home, stdio: 'ignore',
    env: { PATH: process.env.PATH, HOME: home, CLEARSKY_POLL_MINUTES: '0', GITHUB_TOKEN: 'gh-secret', COPILOT_BIN: fileURLToPath(new URL('./fake-copilot.mjs', import.meta.url)) },
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
  const info0 = (evs) => JSON.parse(textOf(evs).match(/info=(.*)\n/)[1]);
  const firstEvs = await events(await ask({ message: 'What first?', session: 'sess-1234', model: 'claude-opus-5', permission: 'read', allow: 'shell(git:*)' }));
  const r = info0(firstEvs);
  assert.match(r.prompt, /work dashboard[\s\S]*What first\?$/);
  assert.equal(r.model, 'claude-opus-5');
  assert.equal(r.hasToken, false, "Clearsky's tokens aren't passed to Copilot");
  assert.ok(r.flags.includes('--deny-tool') && r.flags.includes('--allow-tool'));

  // Every mode runs over ACP, so a step Copilot won't run unattended (here: Full mode, resumed)
  // still reaches the panel as Allow/Deny instead of being refused.
  const fullEvs = [];
  {
    const rd = (await ask({ message: 'And then, gated?', session: 'sess-1234', resume: true, permission: 'full' })).body.getReader();
    let buf = '';
    for (;;) {
      const { value, done } = await rd.read();
      if (done) break;
      buf += new TextDecoder().decode(value);
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const e of lines.map((l) => JSON.parse(l))) {
        fullEvs.push(e);
        if (e.type === 'permission') await ask0(`${base}/api/copilot/permission`, { chat: 'sess-1234', id: e.id, option: 'yes' });
      }
    }
  }
  const next = info0(fullEvs);
  assert.equal(next.prompt, 'And then, gated?');
  assert.equal(next.session, 'sess-1234', 'resumed the same session');
  assert.ok(next.flags.includes('--allow-all-tools'));
  assert.match(textOf(fullEvs), /answer=yes/);
  assert.equal((await ask({ message: 'x', session: 'sess-1234', model: 'bad model; rm' })).status, 400);

  // Assisted: reads go ahead on their own; anything else still asks.
  const readEvs = await events(await ask({ message: 'just read it', session: 'sess-1234', resume: true, permission: 'assisted' }));
  assert.ok(!readEvs.some((e) => e.type === 'permission' || e.type === 'error'));
  assert.match(textOf(readEvs), /answer=yes/);
  assert.ok(!info0(readEvs).flags.includes('--assisted-approval'), "Copilot's judge doesn't work over ACP");

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
      // A new Ask-mode chat takes Copilot's own session id, which the panel uses from then on.
      assert.equal(seen.find((e) => e.type === 'session')?.id, 'acp-session-1');
      const ok = await ask0(`${base}/api/copilot/permission`, { chat: 'acp-session-1', id: perm.id, option: 'yes' });
      assert.equal(ok.status, 200);
    }
  }
  assert.ok(perm, 'got a permission question');
  assert.match(textOf(seen), /flags=\s*answer=yes|answer=yes/);
  assert.ok(!/--allow-all-tools/.test(textOf(seen)), 'Ask mode does not pre-approve tools');
  assert.ok(seen.some((e) => e.type === 'commands'));
  assert.deepEqual(seen.filter((e) => e.type === 'tool').map((e) => e.status), ['pending', 'completed']);
  assert.equal(seen.at(-1).type, 'done');

  // Leaving a chat mid-turn (switching or reloading) doesn't stop it: coming back shows the
  // open question, answering it finishes the turn, and Stop ends one on purpose.
  {
    const ctrl = new AbortController();
    const res2 = await fetch(`${base}/api/copilot`, { method: 'POST', signal: ctrl.signal, headers: { 'X-Clearsky-Token': csrf, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Again', session: 'acp-session-1', resume: true, permission: 'ask' }) });
    const rd = res2.body.getReader();
    let got = '';
    while (!got.includes('"permission"')) got += new TextDecoder().decode((await rd.read()).value);
    ctrl.abort();
    await new Promise((r) => setTimeout(r, 200));
    const live = await fetch(`${base}/api/copilot/sessions/acp-session-1/live`);
    const lr = live.body.getReader();
    let feed = '';
    while (!feed.includes('"permission"')) feed += new TextDecoder().decode((await lr.read()).value);
    const q = JSON.parse(feed.split('\n').find((l) => l.includes('"permission"')));
    assert.equal((await ask0(`${base}/api/copilot/permission`, { chat: 'acp-session-1', id: q.id, option: 'yes' })).status, 200);
    for (;;) { const { value, done } = await lr.read(); if (done) break; feed += new TextDecoder().decode(value); }
    assert.match(feed, /answer=yes/);
    assert.match(feed, /"type":"done"/);
    assert.equal((await ask0(`${base}/api/copilot/stop`, { chat: 'nope-0000' })).status, 200);
  }

  // Copilot's slash commands (built-ins and skills) are offered in the panel.
  assert.deepEqual((await (await fetch(`${base}/api/copilot`)).json()).commands.map((c) => c.name), ['standup', 'review']);
  assert.ok(textOf(seen).includes('--no-ask-user'), "Ask mode turns off Copilot's own questions, which the panel can't show");

  // The page token survives a restart.
  assert.equal(readFileSync(join(home, '.config', 'clearsky', 'csrf'), 'utf8'), csrf);

  // Sessions come from Copilot itself, wherever they were started, newest first.
  // A session a running Copilot holds (inuse.<pid>.hold) shows as open.
  mkdirSync(join(home, '.copilot', 'session-state', 'cli-old-session'), { recursive: true });
  writeFileSync(join(home, '.copilot', 'session-state', 'cli-old-session', `inuse.${process.pid}.hold`), '');
  const list = await (await fetch(`${base}/api/copilot/sessions`)).json();
  assert.deepEqual(list.sessions.map((x) => [x.id, x.here, x.open]), [['personal-1', false, false], ['acp-session-1', true, false], ['cli-old-session', false, true]]);
  const hist = await (await fetch(`${base}/api/copilot/sessions/cli-old-session?cwd=/tmp`)).json();
  assert.deepEqual(hist.messages, [
    { role: 'me', text: 'What broke?' },
    { role: 'cp', segs: [{ type: 'tool', id: 'x', title: 'Read log', status: 'completed' }, { type: 'text', text: 'The build broke.' }] },
  ]);
  assert.equal(hist.cwd, '/tmp');

  // Attached PRs and tickets go in front of the message.
  const withRef = info0(await events(await ask({ message: 'Summarise', session: 'sess-ref-1', resume: true, permission: 'read',
    refs: [{ kind: 'issue', key: 'SSP-1234' }, { kind: 'pr', repo: 'bad repo', number: 1 }] })));
  assert.match(withRef.prompt, /^I am asking about these items:\n\n## SSP-1234[\s\S]*\n---\nMy message:\nSummarise$/);
  assert.ok(!/bad repo/.test(withRef.prompt), 'invalid references are dropped');
});
