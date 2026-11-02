import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commitWriter, chatPushes, ownRead } from '../lib/own-read.mjs';

const c = (oid, at, extra = {}) => ({ oid, at, additions: 10, deletions: 2, login: 'alex', message: 'Change', ...extra });

test('commitWriter tells you, agents and others apart', () => {
  assert.deepEqual(commitWriter(c('a', 't'), 'alex'), { by: 'me' });
  assert.deepEqual(commitWriter(c('a', 't', { message: 'Fix\n\nCo-authored-by: Copilot <1+Copilot@users.noreply.github.com>' }), 'alex'), { by: 'agent', agent: 'Copilot' });
  assert.deepEqual(commitWriter(c('a', 't', { login: 'Copilot' }), 'alex'), { by: 'agent', agent: 'Copilot agent' });
  assert.deepEqual(commitWriter(c('a', 't', { message: 'x\n\nCo-Authored-By: Claude <noreply@anthropic.com>' }), 'alex'), { by: 'agent', agent: 'Claude' });
  assert.deepEqual(commitWriter(c('a', 't', { login: 'sam' }), 'alex'), { by: 'other', who: 'sam' });
  assert.deepEqual(commitWriter(c('a', 't', { login: null, name: 'Someone' }), 'alex'), { by: 'other', who: 'Someone' });
});

test('a commit a Clearsky chat pushed counts as the chat\'s', () => {
  const pushes = chatPushes([{ at: '2026-11-02T10:05:00Z', where: 'github', what: 'git push to acme/api (feature-x)', decided: 'auto' }]);
  const pr = { url: 'https://github.com/acme/api/pull/5', repo: 'acme/api', branch: 'feature-x', headOid: 'b',
    commits: [c('a', '2026-11-01T09:00:00Z'), c('b', '2026-11-02T10:00:00Z')] };
  const r = ownRead(pr, 'alex', null, pushes);
  assert.equal(r.state, 'unread');
  assert.equal(r.unread, 1);
  assert.equal(r.by, 'Copilot chat');
  assert.deepEqual(r.writers, ['you', 'Copilot chat']);
});

test('ownRead: unread, read, new commits since, and the risky ones', () => {
  const agent = { message: 'x\n\nCo-authored-by: Copilot <c@users.noreply.github.com>' };
  const pr = { url: 'https://github.com/acme/api/pull/5', repo: 'acme/api', branch: 'f', headOid: 'c', approvals: [], pendingReviewers: [],
    commits: [c('a', '2026-11-01T09:00:00Z', agent), c('b', '2026-11-01T10:00:00Z'), c('c', '2026-11-02T10:00:00Z', agent)] };
  const unread = ownRead(pr, 'alex', null);
  assert.equal(unread.state, 'unread');
  assert.equal(unread.unread, 2);
  assert.equal(unread.lines, 24);
  assert.equal(unread.risk, null);
  assert.deepEqual(unread.label, ['not read', 'blue']);

  const asked = ownRead({ ...pr, pendingReviewers: ['sam'] }, 'alex', null);
  assert.deepEqual(asked.label, ['not read', 'amber']);
  assert.match(asked.step, /^in review, not read by you/);
  const approved = ownRead({ ...pr, approvals: ['sam'] }, 'alex', 'a');
  assert.equal(approved.state, 'new');
  assert.deepEqual(approved.label, ['1 new', 'red']);
  assert.equal(approved.unread, 1, 'b is yours, c is new');
  assert.equal(approved.diffUrl, 'https://github.com/acme/api/pull/5/files/a..c');

  const read = ownRead(pr, 'alex', 'c');
  assert.equal(read.state, 'read');
  assert.deepEqual(read.label, ['read by you', 'green']);

  const viewed = ownRead({ ...pr, viewed: { files: 3, viewed: 3 } }, 'alex', null);
  assert.equal(viewed.state, 'read');
  assert.equal(viewed.viaViewed, true);
  assert.match(ownRead({ ...pr, viewed: { files: 3, viewed: 1 } }, 'alex', null).step, /1 of 3 files viewed$/);

  const rewritten = ownRead(pr, 'alex', 'zzz');
  assert.equal(rewritten.state, 'new');
  assert.match(rewritten.step, /rewritten/);
  assert.equal(rewritten.diffUrl, 'https://github.com/acme/api/pull/5/files');

  const allMine = ownRead({ ...pr, commits: [c('b', '2026-11-01T10:00:00Z')], headOid: 'b' }, 'alex', null);
  assert.equal(allMine.state, 'read');
  assert.deepEqual(allMine.label, ['all yours', null]);
  assert.equal(ownRead({ ...pr, draft: true, pendingReviewers: ['sam'] }, 'alex', null).risk, null, 'a draft isn\'t out for review');
});
