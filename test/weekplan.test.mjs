import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { weekPlanEvents, planMonday } from '../lib/weekplan.mjs';
import { documentText, docxText } from '../lib/doctext.mjs';
import { schoolEvents } from '../lib/school-events.mjs';

// The text of real plans as pdftotext -layout gives it (the school's name and phone changed,
// parents' names removed).
const fixture = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url));
const grade = fixture('ukeplan-3trinn.txt').toString();
const sfo = fixture('ukeplan-sfo.txt').toString();
const pick = (evs, kind) => evs.filter((e) => e.kind === kind).map(({ day, title, start, end }) => [day, title, start, end].filter(Boolean).join(' '));

test('the week a plan is for: "uke N", or the coming week when sent at the weekend', () => {
  assert.equal(planMonday('Uke 45', { sentAt: '2026-10-30T10:00:00Z' }).toISOString().slice(0, 10), '2026-11-02');
  assert.equal(planMonday('', { sentAt: '2026-10-25T10:00:00Z' }).toISOString().slice(0, 10), '2026-10-26');
  assert.equal(planMonday('', { sentAt: '2026-10-28T10:00:00Z' }).toISOString().slice(0, 10), '2026-10-26');
  assert.equal(planMonday('uke 2', { sentAt: '2026-12-30T10:00:00Z' }).toISOString().slice(0, 10), '2027-01-11');
});

test('a class plan: the trip, when each day ends and the homework, without the routine', () => {
  const evs = weekPlanEvents(grade, { sentAt: '2026-10-30T10:00:00Z' });
  assert.deepEqual(pick(evs, 'activity'), ['2026-11-05 Turdag, «ut på tur, ALDRI sur/ALLTID blid»😊 10:15 12:15']);
  assert.deepEqual(pick(evs, 'ends'), ['2026-11-02 Skolen slutter 13.15 13:15 13:15', '2026-11-03 Skolen slutter 13.15 13:15 13:15',
    '2026-11-04 Skolen slutter 13.45 13:45 13:45', '2026-11-05 Skolen slutter 13.45 13:45 13:45', '2026-11-06 Skolen slutter 13.15 13:15 13:15']);
  assert.deepEqual(pick(evs, 'homework'), ['2026-11-03 Lekse norsk: Salto lesebok: sidene 128-131', '2026-11-04 Lekse norsk: Salto lesebok: sidene 128-131',
    '2026-11-05 Lekse norsk: Salto lesebok: sidene 134-137', '2026-11-06 Lekse norsk: Salto lesebok: sidene 134-137']);
  assert.ok(!evs.some((e) => /frilek|lunsj|storefri|ukeplan/i.test(e.title)));
});

test('an SFO plan: each group\'s activities, the side column and meals left out', () => {
  const evs = weekPlanEvents(sfo, { sentAt: '2026-10-25T10:00:00Z' });
  assert.deepEqual(evs.map((e) => `${e.day} ${e.group} ${e.title}`), [
    '2026-10-26 1 Just dance', '2026-10-26 2 Gymsalen', '2026-10-27 1 Gymsalen', '2026-10-27 2 2. trinn: Just dance 3. og 4. trinn: Leseglede',
    '2026-10-28 1 Forming', '2026-10-28 2 Gymsalen', '2026-10-29 1 Gymsalen', '2026-10-29 2 Halloween BINGO',
    '2026-10-30 1 Halloween BINGO', '2026-10-30 2 Gymsalen']);
  assert.ok(evs.every((e) => e.allDay));
});

test('a plan whose homework table runs onto the next page, further left', () => {
  const evs = weekPlanEvents(fixture('ukeplan-3trinn-uke44.txt').toString(), { sentAt: '2026-10-23T06:57:45Z', title: 'Ukeplan for 3. trinn uke 44' });
  assert.deepEqual(pick(evs, 'homework'), ['2026-10-27 Lekse norsk: Salto lesebok: sidene 118-121', '2026-10-28 Lekse norsk: Salto lesebok: sidene 118-121',
    '2026-10-29 Lekse norsk: Salto lesebok: sidene 124-127', '2026-10-30 Lekse norsk: Salto lesebok: sidene 124-127']);
  assert.deepEqual(pick(evs, 'activity'), ['2026-10-29 Turdag, «ut på tur, ALDRI sur/ALLTID blid»😊 10:15 12:15']);
});

test('a plan with times over two lines, cells that touch and prose that names weekdays', () => {
  const evs = weekPlanEvents(fixture('ukeplan-7trinn.txt').toString(), { sentAt: '2026-10-23T06:16:37Z', title: 'Uke 44' });
  assert.deepEqual(pick(evs, 'activity'), [
    '2026-10-26 Oppstart strikking 08:30 09:15', '2026-10-26 Futsalturnering for hele trinnet 12:05 13:15',
    '2026-10-28 Vi strikker 08:30 09:15', '2026-10-28 Futsalturnering for hele trinnet 12:05 13:15',
    '2026-10-29 Delingstime matematikk Delingstime norsk 08:30 10:00', '2026-10-29 Fysak 10:15 11:15', '2026-10-29 Futsalturnering for hele trinnet 12:05 13:15',
    '2026-10-30 Halloween i hallen. Vi har ulike halloween aktiviteter 08:30 10:00']);
  assert.deepEqual(pick(evs, 'ends').map((e) => e.slice(0, 31)), ['2026-10-26 Skolen slutter 14.15', '2026-10-27 Skolen slutter 13.15',
    '2026-10-28 Skolen slutter 14.10', '2026-10-29 Skolen slutter 14.10', '2026-10-30 Skolen slutter 14.00']);
});

test('a Word plan reads the same way: cells in columns, the table ends with its last row', async () => {
  const text = await documentText(fixture('ukeplan.docx'), { name: 'Ukeplan.docx' });
  assert.equal(text, docxText(fixture('ukeplan.docx')));
  const evs = weekPlanEvents(text, { sentAt: '2026-10-30T10:00:00Z' });
  assert.deepEqual(pick(evs, 'activity'), ['2026-11-03 Gym & ballspill / Ta med gymtøy 09:00 10:00', '2026-11-05 Turdag kl. 09.00 09:00 10:00']);
  assert.equal(pick(evs, 'ends').length, 5);
});

test('text with no weekday table gives nothing', () => {
  assert.deepEqual(weekPlanEvents('Hei! Husk foreldremøte på torsdag.', { sentAt: '2026-10-30T10:00:00Z' }), []);
});

test('school events: each file read once, kept privately, sent twice shown once, linked to its message', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cs-school-'));
  const file = join(dir, 'school-events.json');
  let reads = 0;
  const readFile = async (key, id) => { reads++; return { data: fixture('ukeplan.docx'), type: null, name: `${id}.docx` }; };
  const now = Date.parse('2026-10-31T10:00:00Z');
  const msgs = [
    { key: 'flyt:group:1:a:m2', title: 'Ukeplan uke 45', at: '2026-10-30T12:00:00', docs: [{ id: '7', name: 'Ukeplan.docx' }, { id: '8', name: 'bilde.jpg', type: 'image/jpeg' }] },
    { key: 'flyt:group:1:b:m1', title: 'Ukeplan uke 45', at: '2026-10-30T11:00:00', docs: [{ id: '9', name: 'Ukeplan.docx' }] },
    { key: 'flyt:group:1:a:m0', title: 'Gammel plan', at: '2026-09-01T11:00:00', docs: [{ id: '3', name: 'Ukeplan.docx' }] },
  ];
  const evs = await schoolEvents(msgs, { readFile, file, now });
  assert.equal(reads, 2); // not the picture, not the old plan
  assert.equal(evs.filter((e) => /Turdag/.test(e.title)).length, 1);
  const trip = evs.find((e) => /Turdag/.test(e.title));
  assert.equal(new Date(trip.start).getHours(), 9);
  assert.deepEqual(trip.read, { src: 'flyt', key: 'flyt:group:1:a:m2' });
  assert.ok(trip.fyi && !trip.allDay);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const ends = evs.find((e) => e.kind === 'ends');
  assert.equal(Date.parse(ends.end) - Date.parse(ends.start), 15 * 6e4);
  await schoolEvents(msgs, { readFile, file, now });
  assert.equal(reads, 2); // from the file
  const failing = await schoolEvents([{ ...msgs[0], key: 'flyt:group:1:c:m3' }], { readFile: async () => { throw new Error('gone'); }, file, now });
  assert.deepEqual(failing, []);
  assert.ok(existsSync(file));
});
