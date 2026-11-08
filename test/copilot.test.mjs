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

  // A dropped file: uploaded, named in the message, kept in the chat's own folder, and listed
  // (and readable) in its outputs. A path that wasn't uploaded here isn't named.
  const up = await (await fetch(`${base}/api/copilot/attach?name=${encodeURIComponent('../notes 1.txt')}`, { method: 'POST', headers: { 'X-Clearsky-Token': csrf }, body: 'hello' })).json();
  assert.match(up.path, /attachments\/\w+\/notes_1\.txt$/);
  const attEvs = await events(await ask({ message: 'Read this', session: 'sess-1234', resume: true, permission: 'read', attachments: [up.path, '/etc/passwd'] }));
  assert.match(info0(attEvs).prompt, new RegExp(`Read this\\n\\nFiles I attached: ${up.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
  const outs = await (await fetch(`${base}/api/copilot/outputs?chat=sess-1234`)).json();
  const kept = outs.files.find((f) => f.kind === 'attached');
  assert.ok(kept && kept.name === 'notes_1.txt' && kept.exists, JSON.stringify(outs.files));
  assert.equal(await (await fetch(`${base}/api/copilot/file?chat=sess-1234&path=${encodeURIComponent(kept.path)}`)).text(), 'hello');
  assert.equal((await fetch(`${base}/api/copilot/file?chat=sess-1234&path=${encodeURIComponent('/etc/passwd')}`)).status, 404, 'only the chat\'s own files');

  // A file on disk you point at with @: found by name or path, only its path goes in, and it
  // shows in the outputs. Paths outside the chat's folders are refused, not quietly dropped.
  mkdirSync(join(home, 'dev', 'proj', 'logs'), { recursive: true });
  writeFileSync(join(home, 'dev', 'proj', 'logs', 'big-run.log'), 'line\n'.repeat(5000));
  const found = (await (await fetch(`${base}/api/copilot/files?q=big-run&chat=sess-1234`)).json()).files;
  assert.deepEqual(found.map((f) => f.shown), ['~/dev/proj/logs/big-run.log']);
  const listed = (await (await fetch(`${base}/api/copilot/files?q=${encodeURIComponent('~/dev/proj/')}&chat=sess-1234`)).json()).files;
  assert.deepEqual(listed.map((f) => [f.name, f.dir]), [['logs', true]]);
  const ptEvs = await events(await ask({ message: 'Why did it fail?', session: 'sess-1234', resume: true, permission: 'read', files: [found[0].path] }));
  const ptPrompt = info0(ptEvs).prompt;
  assert.match(ptPrompt, /Why did it fail\?\n\nFiles I'm pointing you at \(read them from disk, and only the parts you need\): ~\/dev\/proj\/logs\/big-run\.log$/);
  assert.ok(!ptPrompt.includes('line\nline'), 'the contents stay on disk');
  const outs2 = await (await fetch(`${base}/api/copilot/outputs?chat=sess-1234`)).json();
  assert.ok(outs2.files.some((f) => f.kind === 'pointed' && f.name === 'big-run.log'), JSON.stringify(outs2.files));
  const bad = await ask({ message: 'And this', session: 'sess-1234', resume: true, permission: 'read', files: ['/etc/passwd'] });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /outside this chat's folders/);

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
      assert.equal(perm.detail, 'git push');
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
    // A chat waiting on your OK holds up a restart, and the restart note names it.
    const rs = await (await fetch(`${base}/api/restart`)).json();
    assert.deepEqual(rs.busy.map((c) => [c.id, c.status]), [['acp-session-1', 'needs-you']]);
    assert.equal(rs.pending, null);
    assert.equal(rs.updateReady, false);
    assert.equal((await ask0(`${base}/api/copilot/permission`, { chat: 'acp-session-1', id: q.id, option: 'yes' })).status, 200);
    for (;;) { const { value, done } = await lr.read(); if (done) break; feed += new TextDecoder().decode(value); }
    assert.match(feed, /answer=yes/);
    assert.match(feed, /"type":"done"/);
    assert.equal((await ask0(`${base}/api/copilot/stop`, { chat: 'nope-0000' })).status, 200);
  }

  // Renaming a session: your name wins over Copilot's title.
  assert.equal((await ask0(`${base}/api/copilot/rename`, { id: 'acp-session-1', title: 'Storage review' })).status, 200);
  assert.equal((await ask0(`${base}/api/copilot/rename`, { id: '../x', title: 'y' })).status, 400);
  assert.equal((await (await fetch(`${base}/api/copilot/sessions`)).json()).sessions.find((x) => x.id === 'acp-session-1').title, 'Storage review');

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
    refs: [{ kind: 'issue', key: 'ABC-1234' }, { kind: 'pr', repo: 'bad repo', number: 1 }] })));
  assert.match(withRef.prompt, /^I am asking about these items:\n\n## ABC-1234[\s\S]*\n---\nMy message:\nSummarise$/);
  assert.ok(!/bad repo/.test(withRef.prompt), 'invalid references are dropped');
});

test('lets Copilot use your code folders without asking', async () => {
  const { folderArgs } = await import('../lib/copilot.mjs');
  const { validate } = await import('../lib/settings.mjs');
  const home = mkdtempSync(join(tmpdir(), 'clearsky-home-'));
  mkdirSync(join(home, 'dev', 'acme'), { recursive: true });
  assert.deepEqual(folderArgs(['~/dev/acme', '~/dev/gone', '/nope'], home), ['--add-dir', join(home, 'dev', 'acme')]);
  assert.equal(validate({ COPILOT_FOLDERS: '~/dev/acme, /home/m/dev/mine' }).COPILOT_FOLDERS, '~/dev/acme, /home/m/dev/mine');
  assert.throws(() => validate({ COPILOT_FOLDERS: 'dev/acme' }), /full paths/);
  assert.throws(() => validate({ COPILOT_FOLDERS: '~/dev/../..' }), /full paths/);
});
