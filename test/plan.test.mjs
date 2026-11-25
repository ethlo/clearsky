import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatEvent, planEntries, planProgress } from '../lib/acp.mjs';

test('an ACP plan update becomes a plan event with the whole list', () => {
  const e = chatEvent({ sessionUpdate: 'plan', entries: [
    { content: 'Read the code', priority: 'high', status: 'completed' },
    { content: '  Fix\nthe bug ', priority: 'medium', status: 'in_progress' },
    { content: 'Run tests', status: 'weird' },
    { content: '' },
  ] });
  assert.deepEqual(e, { type: 'plan', entries: [
    { content: 'Read the code', status: 'completed' },
    { content: 'Fix the bug', status: 'in_progress' },
    { content: 'Run tests', status: 'pending' },
  ] });
});

test('plan entries are bounded and survive junk', () => {
  assert.deepEqual(planEntries(null), []);
  assert.deepEqual(planEntries('x'), []);
  assert.equal(planEntries(Array.from({ length: 80 }, (_, i) => ({ content: `s${i}` }))).length, 50);
  assert.equal(planEntries([{ content: 'x'.repeat(1000) }])[0].content.length, 300);
});

test('plan progress says how far it is and what is on now', () => {
  assert.equal(planProgress([]), null);
  assert.equal(planProgress(null), null);
  const p = planEntries([{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }, { content: 'c' }]);
  assert.deepEqual(planProgress(p), { done: 1, total: 3, now: 'b' });
  assert.deepEqual(planProgress(planEntries([{ content: 'a', status: 'completed' }, { content: 'b' }])), { done: 1, total: 2, now: 'b' });
  assert.deepEqual(planProgress(planEntries([{ content: 'a', status: 'completed' }])), { done: 1, total: 1, now: null });
});
