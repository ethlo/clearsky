process.env.TZ = 'Europe/Oslo';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { edsCalendars, pickCalendars, edsCalendarText } from '../lib/eds.mjs';
import { eventsBetween } from '../lib/ics.mjs';

test('reads a calendar synced by GNOME Online Accounts / Evolution', async () => {
  const home = mkdtempSync(join(tmpdir(), 'clearsky-eds-'));
  const sources = join(home, '.config', 'evolution', 'sources');
  mkdirSync(sources, { recursive: true });
  writeFileSync(join(sources, 'goa-work.source'), '[Data Source]\nDisplayName=me@work.test\nEnabled=true\n\n[Authentication]\nUser=me@work.test\n');
  writeFileSync(join(sources, 'cal-work.source'), '[Data Source]\nDisplayName=me@work.test\nEnabled=true\nParent=goa-work\n\n[Calendar]\nBackendName=caldav\nSelected=true\n');
  writeFileSync(join(sources, 'cal-holidays.source'), '[Data Source]\nDisplayName=Holidays\nEnabled=true\nParent=goa-work\n\n[Calendar]\nBackendName=caldav\n');
  writeFileSync(join(sources, 'mail.source'), '[Data Source]\nDisplayName=IMAP\n\n[Mail Account]\nBackendName=imapx\n');

  const cacheDir = join(home, '.cache', 'evolution', 'calendar', 'cal-work');
  mkdirSync(cacheDir, { recursive: true });
  const db = new DatabaseSync(join(cacheDir, 'cache.db'));
  db.exec('CREATE TABLE ECacheObjects (ECacheUID TEXT, ECacheREV TEXT, ECacheOBJ TEXT, ECacheState INTEGER)');
  db.prepare('INSERT INTO ECacheObjects VALUES (?, ?, ?, 0)').run('a', '1',
    'BEGIN:VEVENT\r\nUID:a\r\nDTSTART;TZID=/freeassociation.sourceforge.net/Europe/Oslo:20261029T130000\r\nDTEND;TZID=/freeassociation.sourceforge.net/Europe/Oslo:20261029T140000\r\nSUMMARY:Planning\r\nEND:VEVENT');
  db.close();

  const all = edsCalendars(home);
  assert.deepEqual(all.map((c) => [c.uid, c.account, !!c.cacheDb]).sort(), [['cal-holidays', 'me@work.test', false], ['cal-work', 'me@work.test', true]]);
  const picked = pickCalendars(all, { email: 'me@work.test' });
  assert.deepEqual(picked.map((c) => c.uid), ['cal-work'], 'the calendar named after the account');
  assert.deepEqual(pickCalendars(all, { wanted: 'Holidays', email: 'x' }).map((c) => c.uid), ['cal-holidays']);

  const events = eventsBetween(await edsCalendarText(picked[0].cacheDb), Date.parse('2026-10-28T23:00:00Z'), Date.parse('2026-10-29T23:00:00Z'));
  assert.deepEqual(events.map((e) => [e.title, e.start]), [['Planning', '2026-10-29T12:00:00.000Z']]);
});
