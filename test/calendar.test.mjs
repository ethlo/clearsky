import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ics = (uid, title, hour) => `BEGIN:VEVENT\r\nUID:${uid}\r\nDTSTART:${today(hour)}\r\nDTEND:${today(hour + 1)}\r\nSUMMARY:${title}\r\nEND:VEVENT`;
const today = (h) => { const d = new Date(); return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}T${String(h).padStart(2, '0')}0000`; };

function gnomeHome() {
  const home = mkdtempSync(join(tmpdir(), 'clearsky-cal-'));
  const sources = join(home, '.config', 'evolution', 'sources');
  mkdirSync(sources, { recursive: true });
  writeFileSync(join(sources, 'cal-work.source'), '[Data Source]\nDisplayName=me@work.test\nEnabled=true\n\n[Calendar]\nBackendName=caldav\n');
  const dir = join(home, '.cache', 'evolution', 'calendar', 'cal-work');
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, 'cache.db'));
  db.exec('CREATE TABLE ECacheObjects (ECacheUID TEXT, ECacheOBJ TEXT)');
  db.prepare('INSERT INTO ECacheObjects VALUES (?, ?)').run('a', ics('a', 'Planning', 13));
  db.prepare('INSERT INTO ECacheObjects VALUES (?, ?)').run('b', ics('b', 'Retro', 15));
  db.close();
  return home;
}

// Loads the calendar in a fresh process so config is built from this environment.
function calendar(env) {
  const script = `const m = await import(${JSON.stringify(new URL('../bin/clearsky.mjs', import.meta.url).href)}); console.log(JSON.stringify(await m.source('calendar')));`;
  return new Promise((resolve, reject) => execFile(process.execPath, ['--no-warnings', '--input-type=module', '-e', script],
    { cwd: tmpdir(), env: { PATH: process.env.PATH, TZ: 'Europe/Oslo', ...env } },
    (err, out) => (err ? reject(err) : resolve(JSON.parse(out)))));
}

test('merges the iCal link and GNOME Online Accounts, and survives one of them failing', async () => {
  let feed = null;
  const server = createServer((req, res) => (feed ? res.end(feed) : (res.statusCode = 404, res.end('nope'))));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/basic.ics`;
  const home = gnomeHome();
  try {
    const broken = await calendar({ HOME: home, CALENDAR_EMAIL: 'me@work.test', CALENDAR_ICS_URL: url });
    assert.deepEqual(broken.sources, ['GNOME Online Accounts']);
    assert.match(broken.errors['iCal link'], /404/);
    assert.deepEqual(broken.events.map((e) => e.title), ['Planning', 'Retro']);

    feed = `BEGIN:VCALENDAR\r\n${ics('a', 'Planning', 13)}\r\n${ics('c', 'Lunch talk', 11)}\r\nEND:VCALENDAR\r\n`;
    const both = await calendar({ HOME: home, CALENDAR_EMAIL: 'me@work.test', CALENDAR_ICS_URL: url });
    assert.deepEqual(both.sources, ['iCal link', 'GNOME Online Accounts']);
    assert.equal(both.errors, undefined);
    assert.deepEqual(both.events.map((e) => e.title), ['Lunch talk', 'Planning', 'Retro'], 'deduped by uid and start');

    feed = null;
    const none = await calendar({ HOME: mkdtempSync(join(tmpdir(), 'clearsky-empty-')), CALENDAR_ICS_URL: url });
    assert.match(none.error, /404/);
  } finally {
    server.close();
  }
});

test("a shared family calendar shows others' events without taking your time", async () => {
  const home = gnomeHome();
  const sources = join(home, '.config', 'evolution', 'sources');
  writeFileSync(join(sources, 'goa-home.source'), '[Data Source]\nDisplayName=me@home.test\nEnabled=true\n\n[Authentication]\nUser=me@home.test\n');
  writeFileSync(join(sources, 'cal-family.source'), '[Data Source]\nDisplayName=Family\nEnabled=true\nParent=goa-home\n\n[Calendar]\nBackendName=caldav\n');
  const dir = join(home, '.cache', 'evolution', 'calendar', 'cal-family');
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, 'cache.db'));
  db.exec('CREATE TABLE ECacheObjects (ECacheUID TEXT, ECacheOBJ TEXT)');
  db.prepare('INSERT INTO ECacheObjects VALUES (?, ?)').run('f1', ics('f1', 'Football practice', 9));
  db.prepare('INSERT INTO ECacheObjects VALUES (?, ?)').run('f2', ics('f2', 'Dentist (Morten)', 10));
  db.prepare('INSERT INTO ECacheObjects VALUES (?, ?)').run('f3', ics('f3', 'Parents meeting', 17)
    .replace('END:VEVENT', 'ORGANIZER:mailto:me@home.test\r\nEND:VEVENT'));
  db.close();
  const cal = await calendar({ HOME: home, CALENDAR_EMAIL: 'me@work.test', EVOLUTION_CALENDARS: 'cal-family', CALENDAR_MY_NAMES: 'Morten' });
  const fyi = Object.fromEntries(cal.events.map((e) => [e.title, e.fyi]));
  assert.deepEqual(fyi, { 'Football practice': true, 'Dentist (Morten)': false, Planning: false, Retro: false, 'Parents meeting': false });
  assert.equal(cal.events.find((e) => e.title === 'Football practice').calendar, 'Family');

  const { planNow } = await import('../bin/clearsky.mjs');
  const at = (h) => { const d = new Date(); d.setHours(h, 0, 0, 0); return d.toISOString(); };
  const plan = planNow({ calendar: { events: [
    { title: 'Football practice', start: at(11), end: at(12), fyi: true, calendar: 'Family' },
    { title: 'Planning', start: at(13), end: at(14) },
  ] } }, Date.parse(at(10)) + 30 * 6e4, {}, {}, {});
  assert.equal(plan.next.title, 'Planning', 'the family event does not end your free time');
  assert.deepEqual(plan.agenda.map((e) => e.title).slice(0, 1), ['Football practice'], 'but it is in the agenda');
});
