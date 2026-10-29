// Minimal iCalendar (RFC 5545) reader: enough for a Google Calendar "secret address"
// feed. Expands recurring events (DAILY/WEEKLY/MONTHLY/YEARLY with INTERVAL, COUNT,
// UNTIL, BYDAY, BYMONTHDAY), applies EXDATE and RECURRENCE-ID overrides, and
// converts TZID local times to real instants. No dependencies.

const DAY = 864e5;
const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

// ---------------------------------------------------------------- parsing

function unfold(text) {
  return text.replace(/\r?\n[ \t]/g, '');
}

function unescapeText(v) {
  return v.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');
}

function parseLine(line) {
  // NAME;PARAM=a;PARAM2="b:c":value
  let i = 0, inQuote = false;
  for (; i < line.length; i++) {
    if (line[i] === '"') inQuote = !inQuote;
    else if (line[i] === ':' && !inQuote) break;
  }
  const head = line.slice(0, i), value = line.slice(i + 1);
  const [name, ...rawParams] = head.split(';');
  const params = {};
  for (const p of rawParams) {
    const eq = p.indexOf('=');
    params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name: name.toUpperCase(), params, value };
}

export function parseEvents(text) {
  const events = [];
  let cur = null;
  for (const line of unfold(text).split(/\r?\n/)) {
    if (line === 'BEGIN:VEVENT') { cur = { props: {} }; continue; }
    if (line === 'END:VEVENT') { if (cur) events.push(cur); cur = null; continue; }
    if (!cur || !line) continue;
    if (line.startsWith('BEGIN:')) { cur.nested = (cur.nested || 0) + 1; continue; } // VALARM etc.
    if (line.startsWith('END:')) { cur.nested--; continue; }
    if (cur.nested) continue;
    const p = parseLine(line);
    (cur.props[p.name] ||= []).push(p);
  }
  return events;
}

// ---------------------------------------------------------------- time

// Offset (ms) of a time zone from UTC at a given instant.
const fmtCache = new Map();
function tzOffset(ms, tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    fmtCache.set(tz, f);
  }
  const parts = Object.fromEntries(f.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

const localZone = () => process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

// Wall-clock time in a zone -> instant.
export function zonedToUtc(y, mo, d, h, mi, s, tz) {
  const guess = Date.UTC(y, mo, d, h, mi, s);
  let t = guess - tzOffset(guess, tz);
  t = guess - tzOffset(t, tz); // second pass settles DST transitions
  return t;
}

function validZone(tz) {
  if (!tz) return null;
  // Evolution writes zones like "/freeassociation.sourceforge.net/Europe/Oslo"; try the tail too.
  const parts = tz.split('/').filter(Boolean);
  for (const candidate of [tz, parts.slice(-3).join('/'), parts.slice(-2).join('/')]) {
    try { new Intl.DateTimeFormat('en-US', { timeZone: candidate }); return candidate; } catch {}
  }
  return null;
}

// Parse a DATE or DATE-TIME property into { allDay, wall: {y,mo,d,h,mi,s}, tz, utc }.
function parseTime(prop) {
  if (!prop) return null;
  const m = prop.value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?/);
  if (!m) return null;
  const [, y, mo, d, h = '0', mi = '0', s = '0', z] = m;
  const wall = { y: +y, mo: +mo - 1, d: +d, h: +h, mi: +mi, s: +s };
  const allDay = prop.params.VALUE === 'DATE' || m[4] === undefined;
  // Floating times and all-day dates are taken in the local zone.
  const tz = z ? 'UTC' : validZone(prop.params.TZID) || localZone();
  return { allDay, wall, tz, utc: toUtc(wall, tz) };
}

function toUtc(w, tz) {
  return tz === 'UTC' ? Date.UTC(w.y, w.mo, w.d, w.h, w.mi, w.s) : zonedToUtc(w.y, w.mo, w.d, w.h, w.mi, w.s, tz);
}

function parseTimes(props) {
  return (props || []).flatMap((p) => p.value.split(',').map((value) => parseTime({ ...p, value }))).filter(Boolean);
}

// ---------------------------------------------------------------- recurrence

function parseRule(value) {
  const r = Object.fromEntries(value.split(';').map((kv) => kv.split('=')));
  return {
    freq: r.FREQ,
    interval: Number(r.INTERVAL || 1),
    count: r.COUNT ? Number(r.COUNT) : null,
    until: r.UNTIL ? parseTime({ value: r.UNTIL, params: {} }) : null,
    byday: r.BYDAY ? r.BYDAY.split(',').map((x) => {
      const m = x.match(/^([+-]?\d+)?([A-Z]{2})$/);
      return { n: m[1] ? Number(m[1]) : 0, wd: WEEKDAYS.indexOf(m[2]) };
    }) : null,
    bymonthday: r.BYMONTHDAY ? r.BYMONTHDAY.split(',').map(Number) : null,
    bymonth: r.BYMONTH ? r.BYMONTH.split(',').map((x) => Number(x) - 1) : null,
  };
}

// Calendar-date helpers on "floating" dates (UTC midnight ms).
const dateMs = (w) => Date.UTC(w.y, w.mo, w.d);
const mondayOf = (ms) => ms - ((new Date(ms).getUTCDay() + 6) % 7) * DAY;

function matchesNthWeekday(date, n, wd) {
  const dt = new Date(date);
  if (dt.getUTCDay() !== wd) return false;
  if (!n) return true;
  const dom = dt.getUTCDate();
  const daysInMonth = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0)).getUTCDate();
  return n > 0 ? Math.ceil(dom / 7) === n : Math.ceil((daysInMonth - dom + 1) / 7) === -n;
}

function dayMatches(rule, date, start) {
  const dt = new Date(date), st = new Date(start);
  const months = (dt.getUTCFullYear() - st.getUTCFullYear()) * 12 + dt.getUTCMonth() - st.getUTCMonth();
  if (rule.bymonth && !rule.bymonth.includes(dt.getUTCMonth())) return false;
  switch (rule.freq) {
    case 'DAILY':
      if (Math.round((date - start) / DAY) % rule.interval) return false;
      return !rule.byday || rule.byday.some((b) => b.wd === dt.getUTCDay());
    case 'WEEKLY': {
      if (Math.round((mondayOf(date) - mondayOf(start)) / (7 * DAY)) % rule.interval) return false;
      const days = rule.byday ? rule.byday.map((b) => b.wd) : [st.getUTCDay()];
      return days.includes(dt.getUTCDay());
    }
    case 'MONTHLY':
      if (months % rule.interval) return false;
      if (rule.byday) return rule.byday.some((b) => matchesNthWeekday(date, b.n, b.wd));
      if (rule.bymonthday) {
        const dim = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0)).getUTCDate();
        return rule.bymonthday.some((md) => (md > 0 ? md : dim + md + 1) === dt.getUTCDate());
      }
      return dt.getUTCDate() === st.getUTCDate();
    case 'YEARLY':
      if ((dt.getUTCFullYear() - st.getUTCFullYear()) % rule.interval) return false;
      if (rule.byday && rule.bymonth) return rule.byday.some((b) => matchesNthWeekday(date, b.n, b.wd));
      return dt.getUTCMonth() === (rule.bymonth?.[0] ?? st.getUTCMonth()) && dt.getUTCDate() === st.getUTCDate();
    default:
      return false;
  }
}

// Start instants of a recurring event between from and to (ms).
function occurrences(start, rule, from, to) {
  const out = [];
  const first = dateMs(start.wall);
  const until = rule.until ? rule.until.utc : Infinity;
  let count = 0;
  // Walk day by day from the first occurrence: COUNT has to be counted from the start.
  // Capped at ~10 years of days so a malformed rule can't spin.
  for (let date = first, i = 0; i < 3700 * 2; date += DAY, i++) {
    if (!dayMatches(rule, date, first)) continue;
    if (date < from - 2 * DAY) {
      // Long before the window: only count, skip the time zone maths.
      if (date > until) break;
      if (rule.count && ++count >= rule.count) break;
      continue;
    }
    const d = new Date(date);
    const wall = { ...start.wall, y: d.getUTCFullYear(), mo: d.getUTCMonth(), d: d.getUTCDate() };
    const at = toUtc(wall, start.tz);
    if (at > until || at > to) break;
    count++;
    if (at >= from) out.push(at);
    if (rule.count && count >= rule.count) break;
  }
  return out;
}

// ---------------------------------------------------------------- public

/**
 * Events overlapping [from, to), as { uid, title, start, end, allDay, location, url, declined }.
 * `me` (an email) marks events where you declined.
 */
export function eventsBetween(text, from, to, me) {
  const raw = parseEvents(text);
  const val = (e, k) => e.props[k]?.[0];
  const overrides = new Map(); // uid -> Map(recurrence instant -> event)
  for (const e of raw) {
    const rid = parseTime(val(e, 'RECURRENCE-ID'));
    if (!rid) continue;
    const uid = val(e, 'UID')?.value;
    if (!overrides.has(uid)) overrides.set(uid, new Map());
    overrides.get(uid).set(rid.utc, e);
  }

  const shape = (e, start, end, allDay) => {
    const attendees = e.props.ATTENDEE || [];
    const mine = me && attendees.find((a) => a.value.toLowerCase() === `mailto:${me.toLowerCase()}`);
    const text = (k) => (val(e, k) ? unescapeText(val(e, k).value) : null);
    const desc = text('DESCRIPTION') || '';
    const url = text('X-GOOGLE-CONFERENCE') || desc.match(/https:\/\/meet\.google\.com\/[\w-]+/)?.[0] ||
      desc.match(/https:\/\/[\w.-]*zoom\.us\/j\/\S+/)?.[0] || text('URL') || null;
    return {
      uid: val(e, 'UID')?.value,
      title: text('SUMMARY') || '(no title)',
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
      allDay,
      location: text('LOCATION'),
      url,
      attendees: attendees.length,
      declined: mine?.params.PARTSTAT === 'DECLINED',
      transparent: val(e, 'TRANSP')?.value === 'TRANSPARENT',
    };
  };

  const out = [];
  const usedOverrides = new Set();
  for (const e of raw) {
    if (val(e, 'RECURRENCE-ID') || val(e, 'STATUS')?.value === 'CANCELLED') continue;
    const start = parseTime(val(e, 'DTSTART'));
    if (!start) continue;
    const endProp = parseTime(val(e, 'DTEND'));
    const duration = endProp ? endProp.utc - start.utc : start.allDay ? DAY : 0;
    const uid = val(e, 'UID')?.value;
    const rrule = val(e, 'RRULE');

    if (!rrule) {
      if (start.utc < to && start.utc + duration > from) out.push(shape(e, start.utc, start.utc + duration, start.allDay));
      continue;
    }
    const exdates = new Set(parseTimes(e.props.EXDATE).map((t) => t.utc));
    const ov = overrides.get(uid) || new Map();
    for (const at of occurrences(start, parseRule(rrule.value), from - duration, to)) {
      if (exdates.has(at)) continue;
      const moved = ov.get(at);
      if (moved) {
        usedOverrides.add(moved);
        if (val(moved, 'STATUS')?.value === 'CANCELLED') continue;
        const ms = parseTime(val(moved, 'DTSTART')), me2 = parseTime(val(moved, 'DTEND'));
        if (ms && ms.utc < to && (me2?.utc ?? ms.utc + duration) > from) out.push(shape(moved, ms.utc, me2?.utc ?? ms.utc + duration, ms.allDay));
        continue;
      }
      if (at < to && at + duration > from) out.push(shape(e, at, at + duration, start.allDay));
    }
  }
  // Overrides whose original instance falls outside the window but which moved into it.
  for (const byInstant of overrides.values()) {
    for (const moved of byInstant.values()) {
      if (usedOverrides.has(moved) || val(moved, 'STATUS')?.value === 'CANCELLED') continue;
      const ms = parseTime(val(moved, 'DTSTART')), me2 = parseTime(val(moved, 'DTEND'));
      if (ms && ms.utc < to && (me2?.utc ?? ms.utc) > from) out.push(shape(moved, ms.utc, me2?.utc ?? ms.utc, ms.allDay));
    }
  }
  return out.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
}
