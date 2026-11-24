import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWhen, whenText, nextRun, dueNow, cleanSchedule, addSchedule, noteRun, schedulePrompt, MAX } from '../lib/schedules.mjs';

process.env.TZ = 'Europe/Oslo';
const at = (s) => new Date(s).getTime(); // local time

test('when, as typed', () => {
  assert.deepEqual(parseWhen('weekdays 08:30'), { days: [1, 2, 3, 4, 5], time: '08:30' });
  assert.deepEqual(parseWhen('Daily at 7.05'), { days: [0, 1, 2, 3, 4, 5, 6], time: '07:05' });
  assert.deepEqual(parseWhen('mon, thu 16:15'), { days: [1, 4], time: '16:15' });
  assert.deepEqual(parseWhen('every 2h'), { everyHours: 2 });
  for (const bad of ['', 'weekdays', 'someday 08:00', 'daily 25:00', 'every 0h', 'every 30h', 'mon 8']) assert.equal(parseWhen(bad), null, bad);
  assert.equal(whenText(parseWhen('mon,tue,wed,thu,fri 9:00')), 'weekdays 09:00');
  assert.equal(whenText(parseWhen('thu,mon 9:00')), 'mon,thu 09:00');
});

test('the next run, in local time', () => {
  const w = parseWhen('weekdays 08:30');
  assert.equal(nextRun(w, at('2026-11-27T09:00')), at('2026-11-30T08:30')); // Friday after: Monday
  assert.equal(nextRun(w, at('2026-11-24T08:00')), at('2026-11-24T08:30'));
  assert.equal(nextRun(w, at('2026-11-24T08:30')), at('2026-11-25T08:30')); // not the same minute again
  assert.equal(nextRun(parseWhen('every 3h'), at('2026-11-24T10:20')), at('2026-11-24T12:00'));
});

test('due, missed and paused', () => {
  const s = { when: parseWhen('daily 08:30'), lastRun: new Date(at('2026-11-23T08:30')).toISOString() };
  assert.equal(dueNow(s, at('2026-11-24T08:29')), null);
  assert.equal(dueNow(s, at('2026-11-24T08:31')), 'run');
  assert.equal(dueNow(s, at('2026-11-24T16:00')), 'skip'); // Clearsky was off: too long ago
  assert.equal(dueNow({ ...s, paused: true }, at('2026-11-24T08:31')), null);
  assert.equal(dueNow({ when: s.when, createdAt: new Date(at('2026-11-24T09:00')).toISOString() }, at('2026-11-24T10:00')), null); // made after today's time
});

test('a schedule from the page is checked', () => {
  assert.match(cleanSchedule({ prompt: 'x', when: 'daily 8:00' }).error, /name/);
  assert.match(cleanSchedule({ name: 'x', when: 'daily 8:00' }).error, /do/);
  assert.match(cleanSchedule({ name: 'x', prompt: 'y', when: 'soon' }).error, /weekdays/);
  assert.match(cleanSchedule({ name: 'x', prompt: 'y', when: 'daily 8:00', cwd: 'rel' }, { isDir: () => true }).error, /folder/);
  const ok = cleanSchedule({ name: ' CI ', prompt: 'Check CI', when: 'weekdays 08:30', cwd: '/d', extra: 1 }, { isDir: () => true });
  assert.deepEqual(ok, { name: 'CI', prompt: 'Check CI', when: { days: [1, 2, 3, 4, 5], time: '08:30' }, cwd: '/d', paused: false });
  const { list, schedule } = addSchedule([], ok);
  assert.equal(list.length, 1);
  assert.match(schedule.id, /^[0-9a-f]{10}$/);
  assert.match(addSchedule(Array(MAX).fill(schedule), ok).error, /most/);
  const runs = Array.from({ length: 12 }, (_, i) => ({ at: String(i) })).reduce((s, r) => noteRun(s, r), schedule);
  assert.equal(runs.runs.length, 10);
  assert.equal(runs.lastRun, '11');
  assert.match(schedulePrompt(schedule, new Date('2026-11-24T07:30:00Z')), /schedule \("CI", weekdays 08:30\) at 2026-11-24 07:30 UTC[\s\S]*Check CI$/);
});
