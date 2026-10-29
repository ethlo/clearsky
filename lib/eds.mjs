// Read calendars that GNOME Online Accounts / Evolution already sync on this machine.
// Evolution Data Server keeps each calendar's events as iCal text in a local SQLite
// cache, so Clearsky can read them without its own Google login. Linux only.

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';

function parseIni(text) {
  const out = {};
  let section = null;
  for (const line of text.split(/\r?\n/)) {
    const s = line.match(/^\[(.+)\]$/);
    if (s) { section = out[s[1]] = {}; continue; }
    const kv = line.match(/^([^=#]+?)\s*=\s*(.*)$/);
    if (kv && section) section[kv[1]] = kv[2];
  }
  return out;
}

// Sources the running registry service knows about. Calendars that GNOME Online Accounts
// discovers for an account exist only there, not as .source files. busctl prints JSON.
export function registrySources(run = () => execFileSync('busctl', ['--user', '--json=short', 'call',
  'org.gnome.evolution.dataserver.Sources5', '/org/gnome/evolution/dataserver/SourceManager',
  'org.freedesktop.DBus.ObjectManager', 'GetManagedObjects'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] })) {
  let out;
  try { out = JSON.parse(run()); } catch { return []; } // no busctl, no session bus, or the service isn't running
  const objects = out?.data?.[0] || {};
  return Object.values(objects).map((ifaces) => ifaces['org.gnome.evolution.dataserver.Source'])
    .filter((src) => src?.UID?.data && typeof src.Data?.data === 'string')
    .map((src) => ({ uid: src.UID.data, ini: parseIni(src.Data.data) }));
}

// Calendar sources Evolution knows about, with their local cache database if synced.
export function edsCalendars(home = homedir(), registry = registrySources()) {
  const dir = join(home, '.config', 'evolution', 'sources');
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.source')).map((f) => {
    const ini = parseIni(readFileSync(join(dir, f), 'utf8'));
    return { uid: f.replace(/\.source$/, ''), ini };
  }) : [];
  // The registry is the live view; files cover the case where it isn't reachable.
  const byUid = new Map([...files, ...registry].map((s) => [s.uid, s]));
  const sources = [...byUid.values()];
  return sources.filter((s) => s.ini.Calendar).map(({ uid, ini }) => {
    const ds = ini['Data Source'] || {};
    const parent = byUid.get(ds.Parent)?.ini || {};
    const account = ini.Authentication?.User || parent.Authentication?.User ||
      parent['Data Source']?.DisplayName || ds.DisplayName || '';
    const cacheDb = join(home, '.cache', 'evolution', 'calendar', uid, 'cache.db');
    return {
      uid,
      name: ds.DisplayName || uid,
      account,
      enabled: ds.Enabled !== 'false' && ini.Calendar.Selected !== 'false',
      backend: ini.Calendar.BackendName || null,
      cacheDb: existsSync(cacheDb) ? cacheDb : null,
    };
  });
}

// Pick the calendars to read: those named in `wanted` (uids or names, comma-separated),
// else your own calendar on the `email` account.
export function pickCalendars(all, { wanted, email }) {
  const want = (wanted || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (want.length) return all.filter((c) => want.includes(c.uid.toLowerCase()) || want.includes(c.name.toLowerCase()));
  if (!email) return [];
  const e = email.toLowerCase();
  // Google names your own calendar after your address; other calendars on the account
  // (holidays, colleagues, birthdays) are only used if there is no such calendar.
  const own = all.filter((c) => c.enabled && c.name.toLowerCase() === e);
  return own.length ? own : all.filter((c) => c.enabled && c.account.toLowerCase() === e);
}

// All events (as iCal text) from one Evolution calendar cache.
export async function edsCalendarText(cacheDb) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(cacheDb, { readOnly: true });
  try {
    const cols = db.prepare('PRAGMA table_info(ECacheObjects)').all().map((c) => c.name);
    const col = cols.find((c) => /^ECacheOBJ$/i.test(c)) || cols.find((c) => /obj/i.test(c));
    if (!col) throw new Error(`unexpected Evolution cache layout in ${cacheDb}`);
    const rows = db.prepare(`SELECT "${col}" AS obj FROM ECacheObjects`).all();
    return `BEGIN:VCALENDAR\n${rows.map((r) => String(r.obj).trim()).join('\n')}\nEND:VCALENDAR\n`;
  } finally {
    db.close();
  }
}
