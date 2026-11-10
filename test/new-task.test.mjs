import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNewTask, cleanNewTask, newTaskPrompt, taskRef, NEW_TASK_HINT } from '../lib/new-task.mjs';

test('a new-task block: ticket, title, repo, then the hand-off', () => {
  const t = parseNewTask('ticket: PAY-431\ntitle: Same rounding fix for the CSV export\nrepo: acme/payments-api\n\nLedgerCsvWriter rounds each line on its own.\n- Use RefundSplitter\'s last-part rule.\n');
  assert.deepEqual(t.ref, { kind: 'issue', key: 'PAY-431' });
  assert.equal(t.title, 'Same rounding fix for the CSV export');
  assert.equal(t.repo, 'acme/payments-api');
  assert.equal(t.handoff, 'LedgerCsvWriter rounds each line on its own.\n- Use RefundSplitter\'s last-part rule.');
});

test('no ticket, a GitHub ref, links, and lines that only look like headers', () => {
  const a = parseNewTask('title: Flaky test\nThe repo: is acme/x\nticket: PAY-1');
  assert.equal(a.ref, null);
  assert.equal(a.handoff, 'The repo: is acme/x\nticket: PAY-1');
  const b = parseNewTask('ticket: acme/web#12\nFix it');
  assert.deepEqual(b.ref, { kind: 'gh', repo: 'acme/web', number: 12 });
  assert.equal(b.repo, 'acme/web');
  assert.equal(b.title, 'acme/web#12');
  assert.deepEqual(taskRef('https://acme.atlassian.net/browse/pay-9'), { kind: 'issue', key: 'PAY-9' });
  assert.deepEqual(taskRef('https://github.com/acme/web/pull/7'), { kind: 'pr', repo: 'acme/web', number: 7 });
  assert.equal(parseNewTask('repo: not a repo\ntitle: x').repo, null);
});

test('what the page sends is checked again', () => {
  assert.equal(cleanNewTask(null), null);
  assert.equal(cleanNewTask({ title: '  ' }), null);
  assert.deepEqual(cleanNewTask({ ref: { kind: 'issue', key: 'PAY-431' }, title: 'T', repo: '../etc', from: 'Old chat' }),
    { ref: { kind: 'issue', key: 'PAY-431' }, title: 'T', repo: null, from: 'Old chat' });
  assert.equal(cleanNewTask({ ref: { kind: 'issue', key: 'pay-1; rm' }, title: 'T' }).ref, null);
  assert.equal(cleanNewTask({ ref: { kind: 'pr', repo: 'acme/web', number: 3 } }).repo, 'acme/web');
});

test('the new chat is told the task, the hand-off, and to keep off the other chat\'s branch', () => {
  const t = cleanNewTask({ ref: { kind: 'issue', key: 'PAY-431' }, title: 'CSV rounding', repo: 'acme/payments-api', from: 'Partial refunds' });
  const p = newTaskPrompt(t, 'Use the last-part rule.', { skills: ['continue-work'] });
  assert.match(p, /another chat \("Partial refunds"\)/);
  assert.match(p, /Task: PAY-431 CSV rounding/);
  assert.match(p, /Repository: acme\/payments-api/);
  assert.match(p, /Use the last-part rule\./);
  assert.match(p, /continue-work skill/);
  assert.match(p, /git worktree add/);
  assert.match(newTaskPrompt(t, '', { skills: ['continue-work', 'feature-delivery'] }), /feature-delivery skill/);
  assert.doesNotMatch(newTaskPrompt({ ...t, repo: null }, 'x'), /Repository:/);
});

test('chats are told to offer new tasks as a card, not start them in place', () => {
  assert.match(NEW_TASK_HINT, /```new-task\n/);
  assert.match(NEW_TASK_HINT, /don't start on it in this chat/);
});
