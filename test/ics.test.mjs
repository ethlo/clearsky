process.env.TZ = 'Europe/Oslo';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventsBetween } from '../lib/ics.mjs';

const ics = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VTIMEZONE
TZID:Europe/Oslo
END:VTIMEZONE
BEGIN:VEVENT
UID:standup
DTSTART;TZID=Europe/Oslo:20260105T091500
DTEND;TZID=Europe/Oslo:20260105T093000
RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR
EXDATE;TZID=Europe/Oslo:20261030T091500
SUMMARY:Standup
DESCRIPTION:Join: https://meet.google.com/abc-defg-hij\\nThanks
ATTENDEE;PARTSTAT=ACCEPTED:mailto:me@acme.test
BEGIN:VALARM
TRIGGER:-PT10M
SUMMARY:ignored alarm
END:VALARM
END:VEVENT
BEGIN:VEVENT
UID:standup
RECURRENCE-ID;TZID=Europe/Oslo:20261029T091500
DTSTART;TZID=Europe/Oslo:20261029T100000
DTEND;TZID=Europe/Oslo:20261029T101500
SUMMARY:Standup (moved)
END:VEVENT
BEGIN:VEVENT
UID:review
DTSTART:20261029T130000Z
DTEND:20261029T140000Z
SUMMARY:Design review\\, part 2
END:VEVENT
BEGIN:VEVENT
UID:declined
DTSTART:20261029T150000Z
DTEND:20261029T153000Z
SUMMARY:Optional sync
ATTENDEE;CN="Me";PARTSTAT=DECLINED:mailto:me@acme.test
END:VEVENT
BEGIN:VEVENT
UID:cancelled
DTSTART:20261029T110000Z
DTEND:20261029T113000Z
STATUS:CANCELLED
SUMMARY:Cancelled thing
END:VEVENT
BEGIN:VEVENT
UID:holiday
DTSTART;VALUE=DATE:20261029
DTEND;VALUE=DATE:20261030
SUMMARY:Team offsite
END:VEVENT
BEGIN:VEVENT
UID:monthly
DTSTART;TZID=Europe/Oslo:20260101T140000
DTEND;TZID=Europe/Oslo:20260101T150000
RRULE:FREQ=MONTHLY;BYDAY=-1TH;COUNT=20
SUMMARY:Last-Thursday retro
END:VEVENT
END:VCALENDAR
`;

const day = (s) => Date.parse(s);

test('expands, overrides and filters events for a day', () => {
  // Thursday 29 Oct 2026 (CET, after the DST change on 25 Oct).
  const events = eventsBetween(ics, day('2026-10-28T23:00:00Z'), day('2026-10-29T23:00:00Z'), 'me@acme.test');
  const rows = events.map((e) => [e.title, e.start, e.allDay, e.declined]);
  assert.deepEqual(rows, [
    ['Team offsite', '2026-10-28T23:00:00.000Z', true, false],
    ['Standup (moved)', '2026-10-29T09:00:00.000Z', false, false],
    ['Design review, part 2', '2026-10-29T13:00:00.000Z', false, false],
    ['Last-Thursday retro', '2026-10-29T13:00:00.000Z', false, false],
    ['Optional sync', '2026-10-29T15:00:00.000Z', false, true],
  ]);
});

test('recurring times follow the zone across DST, and EXDATE removes an instance', () => {
  // Monday 19 Oct is CEST (UTC+2), Monday 26 Oct is CET (UTC+1).
  const before = eventsBetween(ics, day('2026-10-19T00:00:00Z'), day('2026-10-19T23:00:00Z'));
  const after = eventsBetween(ics, day('2026-10-26T00:00:00Z'), day('2026-10-26T23:00:00Z'));
  assert.equal(before.find((e) => e.uid === 'standup').start, '2026-10-19T07:15:00.000Z');
  assert.equal(after.find((e) => e.uid === 'standup').start, '2026-10-26T08:15:00.000Z');
  assert.equal(after.find((e) => e.uid === 'standup').url, 'https://meet.google.com/abc-defg-hij');

  const friday = eventsBetween(ics, day('2026-10-29T23:00:00Z'), day('2026-10-30T23:00:00Z'));
  assert.ok(!friday.some((e) => e.uid === 'standup'), 'excluded by EXDATE');
  const weekend = eventsBetween(ics, day('2026-10-30T23:00:00Z'), day('2026-11-01T23:00:00Z'));
  assert.ok(!weekend.some((e) => e.uid === 'standup'));
});

test('COUNT stops a series', () => {
  // 20 monthly occurrences from Jan 2026 run out in Aug 2027.
  const late = eventsBetween(ics, day('2027-09-01T00:00:00Z'), day('2027-10-01T00:00:00Z'));
  assert.ok(!late.some((e) => e.uid === 'monthly'));
  const aug = eventsBetween(ics, day('2027-08-01T00:00:00Z'), day('2027-09-01T00:00:00Z'));
  assert.equal(aug.filter((e) => e.uid === 'monthly').length, 1);
});
