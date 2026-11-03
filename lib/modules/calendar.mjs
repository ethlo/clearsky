// Calendar: today's and tomorrow's meetings from Google Calendar's secret iCal link and/or the
// calendars GNOME Online Accounts syncs into Evolution, merged into one list.

import { eventsBetween } from '../ics.mjs';
import { edsCalendars, pickCalendars, ownCalendars, edsCalendarText } from '../eds.mjs';

// What this module holds and reaches (shown in Settings → Modules).
export const manifest = {
  name: 'calendar', label: 'Calendar', area: 'work',
  secrets: [{ key: 'GOOGLE_CALENDAR_ICS', kind: 'token', note: 'the secret iCal address' },
    { kind: 'keyring', note: 'or GNOME Online Accounts, read from Evolution\'s local cache' }],
  hosts: ['calendar.google.com'], clis: [], files: ['~/.cache/evolution/calendar', '~/.config/evolution/sources'], dbus: true,
};

// A Meet link that opens in the Google account the event came from (?authuser=<email>), so you
// don't have to switch accounts in the browser. The email is the calendar's own account.
export function meetLink(url, email) {
  if (!url || !/@/.test(email || '')) return url;
  try {
    const u = new URL(url);
    if (u.hostname !== 'meet.google.com') return url;
    u.searchParams.set('authuser', email);
    return u.toString();
  } catch { return url; }
}

// `config.calendar` holds the iCal links, your work address and the Evolution calendars you picked.
export function createCalendar({ config, env = process.env }) {
  async function icsText(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`calendar feed returned ${res.status} ${res.statusText}`);
    const text = await res.text();
    if (!text.includes('BEGIN:VCALENDAR')) {
      throw new Error('the calendar link returned a web page, not an iCal feed; in Settings, paste the "Secret address in iCal format" (ends in basic.ics)');
    }
    return text;
  }

  // Calendars synced by GNOME Online Accounts / Evolution, matched by CALENDAR_EMAIL
  // or named in EVOLUTION_CALENDARS.
  async function evolutionTexts() {
    const { email, evolution } = config.calendar;
    const all = edsCalendars();
    const picked = pickCalendars(all, { wanted: evolution, email });
    if (!picked.length) return null;
    const synced = picked.filter((c) => c.cacheDb);
    if (!synced.length) throw new Error(`Evolution has ${picked.map((c) => c.name).join(', ')} but hasn't synced it yet; open GNOME Calendar once`);
    // Your own calendars block your time. A shared one (say the family calendar) only blocks
    // for events you put there or were invited to; the rest just show.
    const own = new Set(ownCalendars(all, email).map((c) => c.uid));
    return Promise.all(synced.map(async (c) => ({
      text: await edsCalendarText(c.cacheDb), name: c.name, work: own.has(c.uid), account: c.account,
      shared: !own.has(c.uid) && c.name.toLowerCase() !== c.account.toLowerCase(),
    })));
  }

  // Reads the iCal link and GNOME Online Accounts side by side and merges them, so one
  // broken source doesn't hide the other. It only fails when every configured source fails.
  async function fetchCalendar() {
    const { icsUrl, email } = config.calendar;
    const tries = [];
    const urls = (icsUrl || '').split(/\s+/).filter(Boolean);
    urls.forEach((url, i) => tries.push([urls.length > 1 ? `iCal link ${i + 1}` : 'iCal link', icsText(url).then((text) => [{ text, name: 'Google Calendar', work: true, account: email }])]));
    tries.push(['GNOME Online Accounts', evolutionTexts()]);
    const results = await Promise.all(tries.map(([name, p]) => p.then((texts) => ({ name, texts }), (e) => ({ name, error: e.message }))));
    const used = results.filter((r) => r.texts);
    const errors = Object.fromEntries(results.filter((r) => r.error).map((r) => [r.name, r.error]));
    if (!used.length) {
      const msgs = Object.entries(errors);
      if (!msgs.length) return { disabled: true };
      return { error: msgs.map(([n, m]) => (msgs.length > 1 ? `${n}: ${m}` : m)).join('; '), errors };
    }
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const seen = new Set();
    // All your addresses: the work one and the accounts of the calendars you picked.
    const me = [email, ...pickCalendars(edsCalendars(), { wanted: config.calendar.evolution, email }).map((c) => c.account),
      ...(env.CALENDAR_MY_EMAILS || '').split(/[\s,]+/)].filter((m) => /@/.test(m || ''));
    // Your name in a shared event's title also makes it yours (say "Dentist (Alex)").
    const names = (env.CALENDAR_MY_NAMES || '').split(',').map((n) => n.trim().toLowerCase()).filter(Boolean);
    const events = used.flatMap((r) => r.texts).flatMap((c) => eventsBetween(c.text, today.getTime(), today.getTime() + 2 * 864e5, me)
      .map((e) => ({ ...e, url: meetLink(e.url, c.account), calendar: c.name || 'Calendar', work: !!c.work, shared: !!c.shared,
        fyi: !!c.shared && !e.withMe && !names.some((n) => e.title.toLowerCase().includes(n)) })))
      // The same event on your own calendar and a shared one: keep your copy, which blocks time.
      .sort((a, b) => a.fyi - b.fyi)
      .filter((e) => !e.declined && !seen.has(`${e.uid}@${e.start}`) && !seen.has(`${e.title}@${e.start}`)
        && seen.add(`${e.uid}@${e.start}`) && seen.add(`${e.title}@${e.start}`))
      .map(({ declined, withMe, ...e }) => e)
      .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
    const sources = used.map((r) => r.name);
    return { source: sources.join(' + '), sources, ...(Object.keys(errors).length && { errors }), events };
  }

  return { fetch: fetchCalendar };
}
