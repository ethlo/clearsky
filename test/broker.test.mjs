import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync } from 'node:fs';
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
