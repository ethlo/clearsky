import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupStandup, ticketOf, JIRA_KEY, isJiraKey } from '../lib/standup.mjs';

const P = new Set(['PAY', 'OPS']);
const pr = (number, title, o = {}) => ({ repo: 'acme/payments-api', number, title, url: `https://github.com/acme/payments-api/pull/${number}`, ...o });
const waiting = (who) => ({ status: { label: 'Waiting for review', owner: 'others' }, pendingReviewers: who, approvals: [] });

// A busy day: the same ticket shows up in Jira, as a PR, in several Copilot review chats and in the queue.
const busy = {
  sinceLabel: 'Monday 09:45',
  jiraProjects: ['PAY', 'OPS'],
  yesterday: {
    jira: {
      done: [{ key: 'PAY-405', summary: 'Rounding error on three-way split', status: 'Done' }],
      touched: [
        { key: 'PAY-412', summary: 'Partial refunds for split payments', status: 'Code Review' },
        { key: 'PAY-401', summary: 'Refund API: idempotency keys', status: 'QA Verify' },
        { key: 'PAY-422', summary: 'Problem details (RFC-9457) in error responses', status: 'Code Review' },
      ],
    },
    github: {
      merged: [pr(470, 'PAY-401: Idempotency keys for refunds', { commits: 2 })],
      opened: [pr(479, 'PAY-412: Partial refunds for split payments', { commits: 6, branch: 'PAY-412-partial-refunds' }), pr(481, 'PAY-422: Add RFC 9457 fields to errors', { commits: 3 })],
      reviewed: [{ ...pr(1299, 'Cart: keep coupon'), repo: 'acme/web-shop', author: 'bob', verdict: 'APPROVED' }],
      commits: [{ repo: 'acme/payments-api', count: 11 }],
    },
    copilot: { sessions: [
      { title: 'Review: PAY-412 against main', repo: 'acme/payments-api', branch: 'PAY-412-partial-refunds', ticket: 'PAY-412' },
      { title: 'Review: PAY-412 against main', repo: 'acme/payments-api', branch: 'PAY-412-partial-refunds', ticket: 'PAY-412' },
      { title: 'Review: PAY-420-query-counts against main', repo: 'acme/payments-api', branch: 'PAY-420-query-counts', ticket: 'PAY-420' },
      { title: 'Why is the build slow', repo: 'acme/payments-api', branch: 'main', ticket: null },
      { title: 'Review: something against main', repo: 'acme/payments-api', branch: 'main', ticket: null },
    ] },
  },
  today: {
    inProgress: [
      { key: 'PAY-420', summary: 'Faster ledger export', status: 'In Progress' },
      { key: 'PAY-412', summary: 'Partial refunds for split payments', status: 'Code Review', waiting: true },
    ],
    reviews: [{ ...pr(482, 'Retry webhooks'), author: 'anna' }],
    myPrs: [pr(490, 'OPS-7: Alert on payout backlog', { status: { label: 'CI failing', owner: 'me' } })],
    inReview: [
      pr(479, 'PAY-412: Partial refunds for split payments', waiting(['anna'])),
      pr(480, 'PAY-420: Bulk reads in the ledger export', waiting(['bob', 'carla'])),
      pr(481, 'PAY-422: Add RFC 9457 fields to errors', waiting(['bob'])),
      pr(475, 'PAY-430: Move tests off the old endpoints', waiting(['dev'])),
    ],
    meetings: [],
  },
  blockers: [{ ...pr(475, 'PAY-430: Move tests off the old endpoints'), days: 6, pendingReviewers: ['dev'] }],
  extra: [],
};

test('stand-up: each ticket once, in the section that fits it', () => {
  const g = groupStandup(busy);
  const all = [...g.yesterday, ...g.today, ...g.blockers].join('\n');
  for (const key of ['PAY-412', 'PAY-420', 'PAY-422', 'PAY-405']) assert.equal(all.match(new RegExp(`${key}\\b`, 'g'))?.length, 1, `${key} once in:\n${all}`);
  assert.deepEqual(g.yesterday, [
    'Merged, ready to test: PAY-401: Refund API: idempotency keys (acme/payments-api#470)',
    'Finished: PAY-405: Rounding error on three-way split',
    'In review: PAY-412: Partial refunds for split payments (acme/payments-api#479 waiting for anna)',
    'In review: PAY-422: Problem details (RFC-9457) in error responses (acme/payments-api#481 waiting for bob)',
    'Reviewed acme/web-shop#1299 (bob, approved)',
  ]);
  assert.deepEqual(g.today, [
    'CI failing: OPS-7: Alert on payout backlog (acme/payments-api#490)',
    'Continue PAY-420: Faster ledger export (acme/payments-api#480 waiting for bob, carla)',
    'Review acme/payments-api#482 (anna)',
  ]);
  // A PR that has waited long is a blocker, and only a blocker.
  assert.deepEqual(g.blockers.length, 1);
  assert.match(g.blockers[0], /^PAY-430: Move tests off the old endpoints: acme\/payments-api#475 has waited 6d for review \(dev\)$/);
  // The long story is in the details: chats counted, commits, review chats without a ticket dropped.
  assert.ok(g.details.includes('PAY-412: Partial refunds for split payments · Jira: Code Review · acme/payments-api#479 opened, waiting for anna, 6 commits · 2 Copilot chats'), g.details.join('\n'));
  assert.ok(g.details.includes('Copilot chat: Why is the build slow (payments-api)'));
  assert.ok(!g.details.some((d) => /Review: something/.test(d)));
  assert.ok(g.details.includes('Commits: 11 in payments-api'));
});

test('stand-up: merged work is ready to test', () => {
  const g = groupStandup({ yesterday: { jira: { touched: [{ key: 'PAY-401', summary: 'Refund API: idempotency keys', status: 'QA Verify' }] },
    github: { merged: [pr(470, 'PAY-401: Idempotency keys for refunds')] } }, today: {}, jiraProjects: ['PAY'] });
  assert.deepEqual(g.yesterday, ['Merged, ready to test: PAY-401: Refund API: idempotency keys (acme/payments-api#470)']);
});

test('stand-up: what counts as a Jira key', () => {
  const keys = (t, p) => [...t.matchAll(JIRA_KEY)].map((m) => m[1]).filter((k) => isJiraKey(k, p));
  assert.deepEqual(keys('PAY-12 and RFC-9457 and ISO-8601'), ['PAY-12']);
  assert.deepEqual(keys('branch PAY-12-query-counts and acme/PAY-13 but (PAY-14)'), ['PAY-14']);
  assert.deepEqual(keys('PAY-1, OPS-2, ABC-3', P), ['PAY-1', 'OPS-2']);
  assert.equal(ticketOf({ title: 'Add RFC-9457 errors', branch: 'PAY-9-errors' }, P), 'PAY-9');
  assert.equal(ticketOf({ title: 'Bump deps', branch: 'feature/ops-9-pager' }), 'OPS-9');
  assert.equal(ticketOf({ title: 'Bump deps', branch: 'main' }), null);
});
