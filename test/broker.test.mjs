import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { needs, serveBroker, safeGitEnv, ghWrites, gitWrites } from '../lib/broker.mjs';

test('which commands go through Clearsky, and which ask', () => {
  assert.equal(needs('acli', ['jira', 'workitem', 'view', 'ABC-1']), 'run');
  assert.equal(needs('acli', ['jira', 'workitem', 'transition', '--key', 'ABC-1', '--status', 'Done']), 'ask');
  assert.equal(needs('acli', ['jira', 'workitem', 'transition', '--key', 'ABC-1'], ['acli jira workitem transition']), 'run');
  assert.equal(needs('gh', ['pr', 'view', '3']), 'no');
  assert.equal(needs('gh', ['pr', 'create', '--fill']), 'ask');
  assert.equal(needs('gh', ['api', '-X', 'POST', 'repos/acme/api/issues']), 'ask');
  assert.equal(needs('gh', ['api', 'repos/acme/api/pulls']), 'no');
  assert.equal(needs('git', ['status']), 'no');
  assert.equal(needs('git', ['-C', 'x', 'push', 'origin', 'HEAD']), 'ask');
  assert.equal(needs('outside', ['./mvnw', 'verify']), 'ask');
  assert.equal(needs('outside', ['./mvnw', 'verify'], ['outside ./mvnw verify']), 'run');
  assert.equal(needs('outside', ['./mvnw', 'exec:exec'], ['outside ./mvnw']), 'ask');
  assert.equal(needs('rm', ['-rf', '/']), 'no');
  assert.ok(ghWrites(['auth', 'logout'])); assert.ok(!ghWrites(['auth', 'git-credential', 'get'])); assert.ok(!gitWrites(['fetch']));
});

test('git and gh run with the clone\'s hooks and helpers off', () => {
  const env = safeGitEnv({ PATH: '/bin', GIT_DIR: '/x', HOME: '/h' }, ['!gh auth git-credential']);
  assert.equal(env.GIT_DIR, undefined);
  const pairs = Array.from({ length: +env.GIT_CONFIG_COUNT }, (_, i) => `${env[`GIT_CONFIG_KEY_${i}`]}=${env[`GIT_CONFIG_VALUE_${i}`]}`);
  for (const p of ['core.hooksPath=/dev/null', 'core.sshCommand=ssh', 'protocol.allow=never', 'credential.helper=', 'credential.helper=!gh auth git-credential']) assert.ok(pairs.includes(p), p);
  assert.ok(pairs.indexOf('credential.helper=') < pairs.indexOf('credential.helper=!gh auth git-credential'));
});

test('the sandbox\'s commands reach Clearsky, which asks in the chat and runs them here', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'broker-'));
  const path = join(dir, 's', 'broker.sock');
  const work = join(dir, 'work'); mkdirSync(work);
  const seen = [], asked = [];
  let answer = true;
  const run = (bin, argv, opts, cb) => { seen.push([bin, ...argv, opts.cwd || '-']); cb(null, 'ok\n', ''); };
  const server = serveBroker({ path, run, env: () => ({}), where: (key) => (key === 'k1' ? [work] : null),
    ask: async (q) => { asked.push(`${q.key} ${q.tool} ${q.argv.join(' ')}`); return answer; } });
  await new Promise((r) => server.once('listening', r));
  const bin = (n) => fileURLToPath(new URL(`../scripts/sandbox-bin/${n}`, import.meta.url));
  const go = (n, args, { key = 'k1', cwd = work } = {}) => new Promise((r) => execFile(process.execPath, [bin(n), ...args],
    { cwd, env: { ...process.env, CLEARSKY_BROKER_SOCKET: path, CLEARSKY_BROKER_KEY: key } }, (e, out, err) => r({ code: e ? e.code : 0, out, err })));
  try {
    assert.equal((await go('acli', ['jira', 'workitem', 'view', 'ABC-1'])).code, 0);
    assert.equal((await go('git', ['push', 'origin', 'HEAD'])).code, 0);
    answer = false;
    const no = await go('gh', ['pr', 'create', '--fill']);
    assert.equal(no.code, 1); assert.match(no.err, /declined/);
    assert.equal((await go('outside', ['./mvnw', 'verify'], { key: 'other' })).code, 1); // not a chat Clearsky knows
    answer = true;
    assert.equal((await go('outside', ['./mvnw', 'verify'], { cwd: dir })).code, 1); // outside your folders
    assert.deepEqual(asked, ['k1 git push origin HEAD', 'k1 gh pr create --fill']);
    assert.deepEqual(seen, [['acli', 'jira', 'workitem', 'view', 'ABC-1', '-'], ['git', 'push', 'origin', 'HEAD', work]]);
  } finally { server.close(); }
});
