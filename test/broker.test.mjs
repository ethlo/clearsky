import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { needs, serveBroker } from '../lib/broker.mjs';

test('which commands go through Clearsky, and which ask', () => {
  assert.equal(needs('review', ['--ticket', 'ABC-1']), 'run', 'a review only reads');
  assert.equal(needs('acli', ['jira', 'workitem', 'view', 'ABC-1']), 'run');
  assert.equal(needs('acli', ['jira', 'workitem', 'transition', '--key', 'ABC-1', '--status', 'Done']), 'ask');
  assert.equal(needs('acli', ['jira', 'workitem', 'transition', '--key', 'ABC-1'], ['acli jira workitem transition']), 'run');
  assert.equal(needs('git', ['push']), 'no'); // GitHub's door is srt's proxy (lib/github-gate.mjs)
  assert.equal(needs('outside', ['./mvnw', 'verify']), 'ask');
  assert.equal(needs('outside', ['./mvnw', 'verify'], ['outside ./mvnw verify']), 'run');
  assert.equal(needs('outside', ['./mvnw', 'exec:exec'], ['outside ./mvnw']), 'ask');
  assert.equal(needs('rm', ['-rf', '/']), 'no');
});

test('the sandbox\'s commands reach Clearsky, which asks in the chat and runs them here', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'broker-'));
  const path = join(dir, 's', 'broker.sock');
  const work = join(dir, 'work'); mkdirSync(work);
  const seen = [], asked = [];
  let answer = true;
  const run = (bin, argv, opts, cb) => { seen.push([bin, ...argv, opts.cwd || '-']); cb(null, 'ok\n', ''); };
  const server = serveBroker({ path, run, where: (key) => (key === 'k1' ? [work] : null),
    ask: async (q) => { asked.push(`${q.key} ${q.tool} ${q.argv.join(' ')}`); return answer; } });
  await new Promise((r) => server.once('listening', r));
  const bin = (n) => fileURLToPath(new URL(`../scripts/sandbox-bin/${n}`, import.meta.url));
  const go = (n, args, { key = 'k1', cwd = work } = {}) => new Promise((r) => execFile(process.execPath, [bin(n), ...args],
    { cwd, env: { ...process.env, CLEARSKY_BROKER_SOCKET: path, CLEARSKY_BROKER_KEY: key } }, (e, out, err) => r({ code: e ? e.code : 0, out, err })));
  try {
    assert.equal((await go('acli', ['jira', 'workitem', 'view', 'ABC-1'])).code, 0);
    assert.equal((await go('acli', ['jira', 'workitem', 'transition', '--key', 'ABC-1', '--status', 'Done'])).code, 0);
    answer = false;
    const no = await go('outside', ['./mvnw', 'verify']);
    assert.equal(no.code, 1); assert.match(no.err, /declined/);
    assert.equal((await go('outside', ['./mvnw', 'verify'], { key: 'other' })).code, 1); // not a chat Clearsky knows
    answer = true;
    assert.equal((await go('outside', ['./mvnw', 'verify'], { cwd: dir })).code, 1); // outside your folders
    assert.deepEqual(asked, ['k1 acli jira workitem transition --key ABC-1 --status Done', 'k1 outside ./mvnw verify']);
    assert.deepEqual(seen, [['acli', 'jira', 'workitem', 'view', 'ABC-1', '-'], ['acli', 'jira', 'workitem', 'transition', '--key', 'ABC-1', '--status', 'Done', '-']]);
  } finally { server.close(); }
});

test('a plugin\'s door runs by its own name or as `door <name>`, and only doors that exist', async () => {
  assert.equal(needs('door', ['grafana', 'query'], [], (n) => n === 'grafana'), 'run');
  assert.equal(needs('door', ['nope'], [], (n) => n === 'grafana'), 'no');
  assert.equal(needs('door', [], [], () => true), 'no');
  assert.equal(needs('grafana', ['query'], [], (n) => n === 'grafana'), 'run');
  assert.equal(needs('grafana', ['query']), 'no', 'no plugin, no door');

  const dir = mkdtempSync(join(tmpdir(), 'broker-door-'));
  const path = join(dir, 's', 'broker.sock');
  const work = join(dir, 'work'); mkdirSync(work);
  const calls = [];
  const doors = (n) => (n === 'grafana' ? async ({ key, name, argv }) => { calls.push([key, name, ...argv]); return { code: 0, stdout: `${argv.join(' ')}\n`, stderr: '' }; } : null);
  const server = serveBroker({ path, doors, where: (key) => (key === 'k1' ? [work] : null) });
  await new Promise((r) => server.once('listening', r));
  const bin = (n) => fileURLToPath(new URL(`../scripts/sandbox-bin/${n}`, import.meta.url));
  const go = (n, args, { key = 'k1', cwd = dir } = {}) => new Promise((r) => execFile(process.execPath, [bin(n), ...args],
    { cwd, env: { ...process.env, CLEARSKY_BROKER_SOCKET: path, CLEARSKY_BROKER_KEY: key } }, (e, out, err) => r({ code: e ? e.code : 0, out, err })));
  try {
    const a = await go('grafana', ['logs', 'api']); // a door works from any folder: it doesn't touch the chat's files
    assert.equal(a.code, 0); assert.equal(a.out, 'logs api\n');
    const b = await go('door', ['grafana', 'metrics']);
    assert.equal(b.code, 0); assert.equal(b.out, 'metrics\n');
    assert.equal((await go('door', ['weather'])).code, 1);
    assert.equal((await go('grafana', ['logs'], { key: 'closed' })).code, 1);
    assert.deepEqual(calls, [['k1', 'grafana', 'logs', 'api'], ['k1', 'grafana', 'metrics']]);
  } finally { server.close(); }
});

test('what Clearsky has to tell the chat comes with its command\'s output: a door\'s and a `vm` command\'s', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'broker-notes-'));
  const path = join(dir, 's', 'broker.sock');
  const work = join(dir, 'work'); mkdirSync(work);
  const asked = [];
  const doors = (n) => (n === 'grafana' ? async () => ({ code: 0, stdout: 'ok\n', stderr: '' }) : null);
  const vm = async (req, out, err) => { err('pull timed out\n'); return 1; };
  const notes = async (key, o) => { asked.push([key, o]); return '\nClearsky: registry.example.com is allowed now: run the command again.\n'; };
  const server = serveBroker({ path, doors, vm, notes, where: (key) => (key === 'k1' ? [work] : null) });
  await new Promise((r) => server.once('listening', r));
  const bin = (n) => fileURLToPath(new URL(`../scripts/sandbox-bin/${n}`, import.meta.url));
  const go = (n, args, { key = 'k1' } = {}) => new Promise((r) => execFile(process.execPath, [bin(n), ...args],
    { cwd: work, env: { ...process.env, CLEARSKY_BROKER_SOCKET: path, CLEARSKY_BROKER_KEY: key } }, (e, out, err) => r({ code: e ? e.code : 0, out, err })));
  try {
    const a = await go('grafana', ['logs']);
    assert.equal(a.out, 'ok\n'); assert.match(a.err, /allowed now/);
    const b = await go('vm', ['docker', 'pull', 'registry.example.com/team/app:1']);
    assert.equal(b.code, 1); assert.match(b.err, /pull timed out\n\nClearsky: registry\.example\.com is allowed now/);
    assert.deepEqual(asked, [['k1', { code: 0 }], ['k1', { code: 1, vm: true }]]);
    assert.equal((await go('grafana', ['logs'], { key: 'closed' })).err.includes('allowed now'), false, 'a closed chat hears nothing');
  } finally { server.close(); }
});

test('acli text in a file from the chat or its scratch folder goes to Jira as an ADF file', async () => {
  const { writeFileSync, readFileSync, realpathSync } = await import('node:fs');
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'broker-')));
  const path = join(dir, 's', 'broker.sock');
  const work = join(dir, 'work'); mkdirSync(work);
  const scratch = join(dir, 'scratch'); mkdirSync(scratch);
  writeFileSync(join(work, 'd.md'), '## Goal\n- a\n');
  writeFileSync(join(scratch, 'c.md'), '## Done\n- b\n');
  const seen = [];
  const run = (bin, argv, opts, cb) => { const f = argv.indexOf('--description-file') + 1 || argv.indexOf('--body-file') + 1; seen.push([argv, f && argv[f].includes('clearsky-acli-') ? readFileSync(argv[f], 'utf8') : null]); cb(null, '', ''); };
  const server = serveBroker({ path, run, where: (key) => (key === 'k1' ? [work] : null), reads: () => [scratch], ask: async () => true });
  await new Promise((r) => server.once('listening', r));
  const bin = fileURLToPath(new URL('../scripts/sandbox-bin/acli', import.meta.url));
  const go = (args) => new Promise((r) => execFile(process.execPath, [bin, ...args],
    { cwd: work, env: { ...process.env, CLEARSKY_BROKER_SOCKET: path, CLEARSKY_BROKER_KEY: 'k1' } }, (e) => r(e ? e.code : 0)));
  try {
    assert.equal(await go(['jira', 'workitem', 'edit', '--key', 'ABC-1', '--description-file', 'd.md']), 0);
    assert.equal(JSON.parse(seen[0][1]).content[0].type, 'heading');
    assert.equal(await go(['jira', 'workitem', 'comment', 'create', '--key', 'ABC-1', '--body-file', join(scratch, 'c.md')]), 0);
    assert.equal(JSON.parse(seen[1][1]).content[1].type, 'bulletList');
    // somewhere Clearsky may not read: refused, as acli would post its Markdown as it is
    writeFileSync(join(dir, 'x.md'), '## Elsewhere\n- c\n');
    assert.equal(await go(['jira', 'workitem', 'comment', 'create', '--key', 'ABC-1', '--body-file', '../x.md']), 1);
    assert.equal(seen.length, 2);
    // `ticket comment` turns into the same acli command, so it goes the same way
    const ticket = fileURLToPath(new URL('../scripts/ticket-bin/ticket', import.meta.url));
    const sandboxBin = fileURLToPath(new URL('../scripts/sandbox-bin', import.meta.url));
    const t = await new Promise((r) => execFile(process.execPath, [ticket, 'comment', 'ABC-1', '--body-file', join(scratch, 'c.md')],
      { cwd: work, env: { ...process.env, PATH: `${sandboxBin}:${process.env.PATH}`, CLEARSKY_TRACKER: 'jira', CLEARSKY_BROKER_SOCKET: path, CLEARSKY_BROKER_KEY: 'k1' } }, (e) => r(e ? e.code : 0)));
    assert.equal(t, 0);
    assert.deepEqual(seen[2][0].slice(0, 6), ['jira', 'workitem', 'comment', 'create', '--key', 'ABC-1']);
    assert.equal(JSON.parse(seen[2][1]).content[1].type, 'bulletList');
  } finally { server.close(); }
});

test('the acli door is for Jira, and reads files only from the chat\'s folders', async () => {
  assert.equal(needs('acli', ['rovodev', 'run', 'list the status of my files']), 'no', 'acli\'s own agent would run outside the sandbox');
  assert.equal(needs('acli', ['admin', 'user', 'list']), 'no');
  assert.equal(needs('acli', ['--help']), 'run');
  assert.equal(needs('acli', ['jira', 'workitem', 'search', '--jql', 'project = ABC']), 'run');
  const { acliFiles } = await import('../lib/broker.mjs');
  assert.deepEqual(acliFiles(['jira', 'workitem', 'create', '--from-file', 'a.txt', '--from-json=b.json', '-f', 'c.txt']), ['a.txt', 'b.json', 'c.txt']);
  assert.deepEqual(acliFiles(['jira', 'workitem', 'search', '-f', 'key,summary']), [], '-f is --fields on a search');

  const dir = mkdtempSync(join(tmpdir(), 'broker-files-'));
  const path = join(dir, 's', 'broker.sock');
  const work = join(dir, 'work'); mkdirSync(work);
  writeFileSync(join(work, 'ticket.txt'), 'Summary\n\nText');
  writeFileSync(join(dir, 'secret.txt'), 'not the chat\'s');
  const seen = [];
  const run = (bin, argv, opts, cb) => { seen.push(argv.join(' ')); cb(null, 'ok\n', ''); };
  const server = serveBroker({ path, run, where: (key) => (key === 'k1' ? [work] : null), ask: async () => true });
  await new Promise((r) => server.once('listening', r));
  const bin = fileURLToPath(new URL('../scripts/sandbox-bin/acli', import.meta.url));
  const go = (args) => new Promise((r) => execFile(process.execPath, [bin, ...args],
    { cwd: work, env: { ...process.env, CLEARSKY_BROKER_SOCKET: path, CLEARSKY_BROKER_KEY: 'k1' } }, (e, out, err) => r({ code: e ? e.code : 0, out, err })));
  try {
    const out = await go(['jira', 'workitem', 'create', '--project', 'ABC', '--type', 'Task', '--from-file', join(dir, 'secret.txt')]);
    assert.equal(out.code, 1); assert.match(out.err, /only from this chat's folders/);
    assert.equal((await go(['jira', 'workitem', 'create', '--project', 'ABC', '--type', 'Task', '--from-file', '../secret.txt'])).code, 1);
    assert.equal((await go(['jira', 'workitem', 'create', '--project', 'ABC', '--type', 'Task', '--from-file', 'ticket.txt'])).code, 0);
    const agent = await go(['rovodev', 'run', 'view this']);
    assert.equal(agent.code, 1); assert.match(agent.err, /acli jira/);
    assert.equal(seen.length, 1, 'only the chat\'s own file reached acli');
  } finally { server.close(); }
});
