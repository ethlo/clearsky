// Hand-offs: one at a time, now or from a set time, with how each ended from Copilot's last line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { addHandoff, nextHandoff, handoffPrompt, handoffResult, settleAfterRestart, readHandoffs, saveHandoffs, cleanRef } from '../lib/handoff.mjs';

const T = Date.parse('2026-11-09T09:00:00Z');

test('only PRs, issues and tickets, and the same one twice is the first', () => {
  assert.equal(cleanRef({ kind: 'issue', key: 'nope' }), null);
  assert.equal(cleanRef({ kind: 'pr', repo: '../x', number: 1 }), null);
  let { list } = addHandoff([], { kind: 'issue', key: 'ABC-1', title: 'Fix it' }, { now: T });
  const again = addHandoff(list, { kind: 'issue', key: 'ABC-1' }, { now: T });
  assert.equal(again.already, true);
  assert.equal(again.list.length, 1);
  assert.throws(() => addHandoff(list, { kind: 'url' }), /hand off/);
});

test('one at a time, and a later start waits for its time', () => {
  let { list } = addHandoff([], { kind: 'issue', key: 'ABC-1' }, { now: T, after: new Date(T + 36e5).toISOString() });
  ({ list } = addHandoff(list, { kind: 'pr', repo: 'acme/api', number: 7 }, { now: T }));
  assert.equal(nextHandoff(list, T).label, 'acme/api#7');
  assert.equal(nextHandoff(list, T + 2 * 36e5).label, 'ABC-1');
  list[1].status = 'working';
  assert.equal(nextHandoff(list, T + 2 * 36e5), null);
});

test('a restart stops what was running, and says how to carry on', () => {
  const l = settleAfterRestart([{ id: 'a', status: 'working' }, { id: 'b', status: 'queued' }]);
  assert.equal(l[0].status, 'stopped');
  assert.match(l[0].note, /carry on/);
  assert.equal(l[1].status, 'queued');
});

test('the prompt keeps it to a branch, a review and a draft PR, and never a merge', () => {
  const p = handoffPrompt({ ref: { kind: 'issue', key: 'ABC-1' }, label: 'ABC-1' }, { skills: ['continue-work'] });
  assert.match(p, /continue-work/);
  assert.match(p, /review --ticket ABC-1/);
  assert.match(p, /draft/);
  assert.match(p, /Never merge, approve, close or delete/);
  assert.match(p, /HANDOFF: done/);
});

test('how it ended, from the last HANDOFF line', () => {
  assert.deepEqual(handoffResult('Opened it.\n\n**HANDOFF: done https://github.com/acme/api/pull/12**'), { status: 'done', pr: 'https://github.com/acme/api/pull/12', note: '' });
  assert.equal(handoffResult('HANDOFF: blocked Which branch should it start from?').note, 'Which branch should it start from?');
  const vague = handoffResult('I pushed https://github.com/acme/api/pull/3 and stopped.');
  assert.equal(vague.pr, 'https://github.com/acme/api/pull/3');
  assert.match(vague.note, /open the chat/);
});

test('kept in a file of its own', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'clearsky-ho-')), 'handoffs.json');
  assert.deepEqual(readHandoffs(f), []);
  saveHandoffs(f, [{ id: 'a', status: 'queued' }, { id: 'b', status: 'bogus' }]);
  assert.deepEqual(readHandoffs(f).map((h) => h.id), ['a']);
});
