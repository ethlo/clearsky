import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isReviewStatus, transitionOf, reviewReady, reviewGate } from '../lib/review-gate.mjs';
import { serveBroker } from '../lib/broker.mjs';
import { ticketArgv } from '../lib/tracker.mjs';
import { connect } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const move = (key, status) => ticketArgv('jira', ['move', key, ...status.split(' ')]).args;
const pr = (o = {}) => ({ repo: 'acme/pay', number: 7, author: 'dev', state: 'open', pendingReviewers: [], reviewers: [], approvals: [], changesRequested: [], ...o });

test('review statuses', () => {
  for (const s of ['Code review', 'In Review', 'Review', 'Ready for review', 'code-review']) assert.ok(isReviewStatus(s), s);
  for (const s of ['In Progress', 'Done', 'Reviewed', 'Preview', 'To Do', '']) assert.ok(!isReviewStatus(s), s);
});

test('reads what a transition moves', () => {
  assert.deepEqual(transitionOf(move('PAY-1', 'Code review')), { keys: ['PAY-1'], status: 'Code review', bulk: false });
  assert.deepEqual(transitionOf(['jira', 'workitem', 'transition', '--key', 'pay-1,PAY-2', '--status', 'In Review']).keys, ['PAY-1', 'PAY-2']);
  assert.equal(transitionOf(['jira', 'workitem', 'transition', '--jql', 'project = PAY', '--status', 'Review']).bulk, true);
  assert.equal(transitionOf(['jira', 'workitem', 'comment', 'create', '--key', 'PAY-1']), null);
});

test('a person asked, or a person who reviewed, counts; Copilot, teams and the author do not', () => {
  assert.equal(reviewReady('PAY-1', []).ok, false);
  assert.match(reviewReady('PAY-1', []).why, /no PR/);
  assert.equal(reviewReady('PAY-1', [pr()]).ok, false);
  assert.equal(reviewReady('PAY-1', [pr({ pendingReviewers: ['team:payments'] })]).ok, false);
  assert.equal(reviewReady('PAY-1', [pr({ reviewers: ['dev'] })]).ok, false);
  assert.equal(reviewReady('PAY-1', [pr({ state: 'closed', pendingReviewers: ['anna'] })]).ok, false);
  assert.deepEqual(reviewReady('PAY-1', [pr({ pendingReviewers: ['anna'] })]).who, ['anna']);
  assert.equal(reviewReady('PAY-1', [pr({ reviewers: ['bob'] })]).ok, true);
  assert.equal(reviewReady('PAY-1', [pr({ state: 'merged', approvals: ['bob'] })]).ok, true);
});

test('the gate holds a move to review until a person is on the PR', async () => {
  const prs = { 'PAY-1': [pr()], 'PAY-2': [pr({ pendingReviewers: ['anna'] })] };
  const asked = [];
  const prsFor = async (k) => { asked.push(k); return { prs: prs[k] || [] }; };
  assert.match(await reviewGate(move('PAY-1', 'Code review'), prsFor), /PAY-1 stays where it is.*nobody is asked to review acme\/pay#7/s);
  assert.equal(await reviewGate(move('PAY-2', 'Code review'), prsFor), null);
  assert.match(await reviewGate(move('PAY-3', 'In Review'), prsFor), /no PR with PAY-3/);
  assert.equal(await reviewGate(move('PAY-1', 'In Progress'), prsFor), null);
  assert.equal(await reviewGate(['jira', 'workitem', 'view', 'PAY-1'], prsFor), null);
  assert.match(await reviewGate(['jira', 'workitem', 'transition', '--jql', 'x', '--status', 'Review'], prsFor), /one by one/);
  // GitHub not set up or not answering: not held here.
  assert.equal(await reviewGate(move('PAY-1', 'Code review'), async () => ({ prs: [], noGitHub: true })), null);
  assert.equal(await reviewGate(move('PAY-1', 'Code review'), async () => { throw new Error('down'); }), null);
});

test('the broker answers a held move without asking or running acli, even when it is on the never-ask list', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cs-gate-'));
  const path = join(dir, 'b.sock');
  const ran = [], asked = [];
  const server = serveBroker({ path, where: () => [dir], allow: () => ['acli jira workitem transition'],
    ask: async (r) => { asked.push(r); return true; },
    run: (bin, args, opts, cb) => { ran.push(args); cb(null, 'ok', ''); },
    gate: ({ argv }) => reviewGate(argv, async () => ({ prs: [pr()] })) });
  await new Promise((r) => server.once('listening', r));
  const call = (argv) => new Promise((resolve) => {
    const s = connect(path); let out = '';
    s.on('data', (d) => { out += d; }); s.on('end', () => resolve(JSON.parse(out.trim().split('\n').at(-1))));
    s.write(`${JSON.stringify({ tool: 'acli', argv, cwd: dir, key: 'k' })}\n`);
  });
  const held = await call(move('PAY-1', 'Code review'));
  assert.equal(held.code, 1);
  assert.match(held.stderr, /only once a person is asked to review/);
  assert.equal(ran.length, 0);
  const ok = await call(move('PAY-1', 'In Progress'));
  assert.equal(ok.code, 0);
  assert.equal(ran.length, 1);
  assert.equal(asked.length, 0);
  server.close(); rmSync(dir, { recursive: true, force: true });
});
