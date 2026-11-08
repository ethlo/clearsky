import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewProgress, workingDaysSince, workItems } from '../lib/modules/github.mjs';

const now = Date.parse('2026-11-05T12:00:00Z'); // a Thursday
const pr = (o) => ({ pendingReviewers: [], approvals: [], changesRequested: [], commented: [], askedAt: null, lastReviewAt: null, lastReviewer: null, ...o });

test('review progress: working days skip the weekend', () => {
  assert.equal(workingDaysSince('2026-11-04T12:00:00Z', now), 1);
  assert.equal(workingDaysSince('2026-10-30T12:00:00Z', now), 4); // Friday to Thursday: Mon, Tue, Wed, Thu
  assert.equal(workingDaysSince(null, now), 0);
});

test('review progress: one approval is what it takes; how many were asked, and when anyone last answered', () => {
  const fresh = reviewProgress(pr({ pendingReviewers: ['anna', 'bob', 'carla'], askedAt: '2026-11-04T12:00:00Z' }), now);
  assert.deepEqual(fresh.label, ['needs 1 approval', null]);
  assert.match(fresh.step, /^3 asked \S+ ago · no reviews yet$/);
  assert.equal(fresh.at, '2026-11-04T12:00:00Z');

  const answered = reviewProgress(pr({ pendingReviewers: ['anna'], commented: ['bob'], askedAt: '2026-11-03T12:00:00Z', lastReviewAt: '2026-11-05T09:00:00Z', lastReviewer: 'bob' }), now);
  assert.deepEqual(answered.label, ['needs 1 approval', null]);
  assert.match(answered.step, /^2 asked .* · last review \S+ ago \(bob\)$/);
  assert.equal(answered.at, '2026-11-05T09:00:00Z');
});

test('review progress: nobody answering for 3 working days asks for a nudge; an approval that isn\'t enough says so', () => {
  assert.deepEqual(reviewProgress(pr({ pendingReviewers: ['anna'], askedAt: '2026-10-30T12:00:00Z' }), now).label, ['no response in 4d', 'amber']);
  assert.deepEqual(reviewProgress(pr({ pendingReviewers: ['anna'], askedAt: '2026-10-28T12:00:00Z', lastReviewAt: '2026-10-30T12:00:00Z' }), now).label, ['quiet for 4d', 'amber']);
  assert.deepEqual(reviewProgress(pr({ approvals: ['anna'], pendingReviewers: ['bob'], askedAt: '2026-11-04T12:00:00Z' }), now).label, ['1 approved, needs more', null]);
});

test('review progress: a PR waiting for review shows it in the list instead of each reviewer', () => {
  const p = pr({ url: 'https://github.com/acme/api/pull/1', repo: 'acme/api', number: 1, title: 'x', stamp: 's', status: { label: 'Waiting for review', owner: 'others', tone: 'wait' },
    pendingReviewers: ['anna', 'bob'], askedAt: new Date(Date.now() - 2 * 36e5).toISOString(), updatedAt: new Date().toISOString(), issues: [] });
  const [row] = workItems({ myPrs: [p] });
  assert.equal(row.group, 'waiting');
  assert.deepEqual(row.label, ['needs 1 approval', null]);
  assert.match(row.step, /^2 asked 2h ago · no reviews yet$/);
  assert.equal(row.at, p.askedAt);
});
