import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Jobs, jobReport, jobView, tailOf, took } from '../lib/jobs.mjs';
import { needs, serveBroker } from '../lib/broker.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'jobs-'));
const until = async (f) => { for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 10)); assert.ok(f(), 'timed out'); };

test('a job runs outside the turn, keeps its output, and says how it ended', async () => {
  const dir = tmp(), ended = [];
  const jobs = new Jobs({ file: join(dir, 'jobs.json'), logDir: join(dir, 'logs'), onEnd: (j) => ended.push(j),
    run: async (job, out, err) => { out('line 1\n'); err('line 2\n'); return job.argv[0] === 'ok' ? 0 : 3; } });
  const a = jobs.start({ chat: 'c1', where: 'vm', argv: ['ok'], cwd: dir, ctx: { options: { permission: 'sandboxed' } } });
  const b = jobs.start({ chat: 'c1', where: 'sandbox', argv: ['bad'], cwd: dir });
  assert.equal(a.state, 'running');
  assert.equal(jobs.running('c1').length, 2);
  await until(() => ended.length === 2);
  assert.equal(jobs.get(a.id).state, 'done');
  assert.equal(jobs.get(b.id).state, 'failed');
  assert.equal(jobs.get(b.id).code, 3);
  await until(() => tailOf(a.log).includes('line 2'));
  assert.equal(jobs.tail(a.id), 'line 1\nline 2');
  // On disk, with whether the chat was told.
  const saved = JSON.parse(readFileSync(join(dir, 'jobs.json'), 'utf8')).jobs;
  assert.deepEqual(saved.map((j) => j.state).sort(), ['done', 'failed']);
  jobs.told(a.id);
  assert.equal(jobs.get(a.id).told, true);
  const r = jobReport(jobs.get(b.id), 'boom');
  assert.match(r, /^Background job j[0-9a-f]{6} \(`bad`, in the sandbox\) failed: exit 3, after \d+s\./);
  assert.match(r, /```\nboom\n```/);
  assert.match(r, /Go on with the task/);
  assert.equal(jobView(jobs.get(a.id)).command, 'ok');
  assert.equal(jobView(jobs.get(a.id)).log, undefined, 'no paths for the page');
});

test('a chat runs only so many jobs at once, and a stopped one says so', async () => {
  const dir = tmp(), ended = [];
  const jobs = new Jobs({ file: join(dir, 'jobs.json'), logDir: join(dir, 'logs'), perChat: 1, onEnd: (j) => ended.push(j),
    run: (job, out, err, signal) => new Promise((done) => signal.addEventListener('abort', () => done(143))) });
  const a = jobs.start({ chat: 'c1', where: 'sandbox', argv: ['sleep', '600'], cwd: dir });
  assert.throws(() => jobs.start({ chat: 'c1', where: 'sandbox', argv: ['x'], cwd: dir }), /already has 1 job/);
  const other = jobs.start({ chat: 'c2', where: 'sandbox', argv: ['x'], cwd: dir }); // another chat's count is its own
  assert.equal(jobs.stop(a.id, 'c2'), false, 'only from its own chat');
  assert.equal(jobs.stop(a.id, 'c1'), true);
  await until(() => ended.length === 1);
  assert.equal(jobs.get(a.id).state, 'stopped');
  assert.match(jobReport(jobs.get(a.id), ''), /was stopped before it finished.*\nIt wrote no output\./s);
  assert.throws(() => jobs.start({ chat: 'c1', where: 'moon', argv: ['x'], cwd: dir }), /can't run a job/);
  jobs.stopChat('c2');
  await until(() => jobs.get(other.id).state === 'stopped');
});

test('after a restart, a job that was running is cut short and its chat is told; told ones are not', () => {
  const dir = tmp(), file = join(dir, 'jobs.json');
  writeFileSync(file, JSON.stringify({ jobs: [
    { id: 'j1', chat: 'c1', where: 'vm', argv: ['./mvnw', 'verify'], state: 'running', startedAt: new Date().toISOString(), log: join(dir, 'j1.log'), told: false },
    { id: 'j2', chat: 'c1', where: 'sandbox', argv: ['gh', 'run', 'watch'], state: 'done', code: 0, startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), log: join(dir, 'j2.log'), told: false },
    { id: 'j3', chat: 'c2', where: 'sandbox', argv: ['x'], state: 'done', code: 0, startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), log: join(dir, 'j3.log'), told: true },
  ] }));
  const jobs = new Jobs({ file, logDir: dir, run: async () => 0 });
  const owed = jobs.load();
  assert.deepEqual(owed.map((j) => j.id), ['j1', 'j2']);
  assert.equal(jobs.get('j1').state, 'interrupted');
  assert.match(jobReport(jobs.get('j1'), ''), /cut short after [^:]+: Clearsky restarted while it ran\. Start it again with `bg`/);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).jobs[0].state, 'interrupted', 'saved');
  // Clearsky going down: what ends now isn't recorded as its own end (the next one says interrupted).
  jobs.closing = true;
  assert.throws(() => jobs.start({ chat: 'c1', where: 'sandbox', argv: ['x'], cwd: dir }), /restarting/);
});

test('a log\'s tail keeps the last state of lines redrawn with \\r', () => {
  const dir = tmp(), f = join(dir, 'x.log');
  writeFileSync(f, 'a\nprogress 10%\rprogress 90%\rprogress 100%\nb\n\n');
  assert.equal(tailOf(f, 2), 'progress 100%\nb');
  assert.equal(tailOf(join(dir, 'none.log')), '');
  assert.equal(took(4200), '4s');
  assert.equal(took(432_000), '7m 12s');
  assert.equal(took(2 * 36e5 + 5 * 6e4), '2h 5m');
});

test('bg and jobs go through the broker; bg outside asks first', async () => {
  assert.equal(needs('bg', ['./mvnw', 'verify']), 'run');
  assert.equal(needs('bg', ['vm']), 'no');
  assert.equal(needs('bg', []), 'no');
  assert.equal(needs('jobs', []), 'run');
  const dir = tmp();
  const path = join(dir, 's', 'broker.sock');
  const work = join(dir, 'work'); mkdirSync(work);
  const calls = [], asked = [];
  let answer = true;
  const server = serveBroker({ path, where: (key) => (key === 'k1' ? [work] : null), vm: async () => 0,
    ask: async (q) => { asked.push(`${q.tool} ${q.argv.join(' ')} ${q.background ? 'bg' : ''}`); return answer; },
    jobs: ({ key, tool, where, argv }) => { calls.push([key, tool, where, ...argv]); return { code: 0, stdout: `${tool} ok\n`, stderr: '' }; } });
  await new Promise((r) => server.once('listening', r));
  const bin = (n) => fileURLToPath(new URL(`../scripts/sandbox-bin/${n}`, import.meta.url));
  const go = (n, args, { cwd = work } = {}) => new Promise((r) => execFile(process.execPath, [bin(n), ...args],
    { cwd, env: { ...process.env, CLEARSKY_BROKER_SOCKET: path, CLEARSKY_BROKER_KEY: 'k1' } }, (e, out, err) => r({ code: e ? e.code : 0, out, err })));
  try {
    assert.equal((await go('bg', ['./mvnw', 'verify'])).out, 'bg ok\n');
    assert.equal((await go('bg', ['vm', './mvnw', 'verify'])).code, 0);
    assert.equal((await go('bg', ['outside', './gradlew', 'test'])).code, 0);
    answer = 'vm';
    assert.equal((await go('bg', ['outside', 'make'])).code, 0);
    answer = false;
    const no = await go('bg', ['outside', 'rm', '-rf', 'x']);
    assert.equal(no.code, 1); assert.match(no.err, /declined/);
    assert.equal((await go('jobs', ['log', 'j1'])).out, 'jobs ok\n');
    assert.equal((await go('bg', ['ls'], { cwd: dir })).code, 1, 'only in your folders');
    assert.deepEqual(calls, [['k1', 'bg', 'sandbox', './mvnw', 'verify'], ['k1', 'bg', 'vm', './mvnw', 'verify'], ['k1', 'bg', 'outside', './gradlew', 'test'],
      ['k1', 'bg', 'vm', 'make'], ['k1', 'jobs', null, 'log', 'j1']]);
    assert.deepEqual(asked, ['outside ./gradlew test bg', 'outside make bg', 'outside rm -rf x bg']);
  } finally { server.close(); }
});
