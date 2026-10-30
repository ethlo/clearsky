// The school's weekly plans as a calendar of their own: the PDF and Word files on recent
// messages from school are read (by script, see weekplan.mjs), and what's on each day becomes
// an event on a virtual "School" calendar in Clearsky. Nothing is written to Google.
//
// Each file is read once: what came out of it (also nothing, for a file that isn't a plan) is
// kept in ~/.config/clearsky/school-events.json, readable only by you.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { documentText } from './doctext.mjs';
import { weekPlanEvents, VERSION } from './weekplan.mjs';

export const CACHE = join(homedir(), '.config', 'clearsky', 'school-events.json');
const DOC = /\.(pdf|docx)$/i;
const DOC_TYPE = /pdf|wordprocessingml/i;
const isDoc = (a) => DOC.test(a.name || '') || DOC_TYPE.test(a.type || '');

function load(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; }
}
function save(file, cache) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(cache), { mode: 0o600 });
}

// Wall-clock time on a day, in the server's time zone (yours), as an ISO string.
const at = (day, hm = '00:00') => new Date(`${day}T${hm}:00`).toISOString();
const nextDay = (day) => new Date(Date.parse(`${day}T00:00:00Z`) + 864e5).toISOString().slice(0, 10);

// messages: [{ key, title, at, docs: [{ id, name, type }] }], newest first.
// readFile(key, id) → { data: Buffer, type, name }.
// Returns events for Now / Next: { uid, title, start, end, allDay, fyi, description, read }.
export async function schoolEvents(messages, { readFile, file = CACHE, days = 21, maxNew = 8, now = Date.now(), log = () => {} } = {}) {
  const since = new Date(now - days * 864e5).toISOString();
  const cache = load(file);
  const keep = {};
  let fresh = 0, changed = false;
  const out = [];
  for (const m of messages) {
    if (!m.at || m.at < since) continue;
    for (const doc of (m.docs || []).filter(isDoc)) {
      const id = `${m.key}|${doc.id}`;
      let hit = cache[id]?.v === VERSION ? cache[id] : null;
      if (!hit && fresh < maxNew) {
        fresh++;
        changed = true;
        try {
          const f = await readFile(m.key, doc.id);
          const text = await documentText(f.data, { name: doc.name, type: f.type || doc.type });
          hit = { v: VERSION, events: weekPlanEvents(text, { sentAt: m.at, title: `${m.title || ''} ${doc.name || ''}` }) };
        } catch (e) {
          log(`school plan ${doc.name}: ${e.message}`);
          hit = { v: VERSION, events: [], error: e.message, at: new Date(now).toISOString() };
        }
      }
      if (!hit) continue;
      // A file that failed is tried again a day later.
      if (hit.error && Date.parse(hit.at) < now - 864e5) { changed = true; continue; }
      keep[id] = hit;
      for (const e of hit.events) out.push({ ...e, key: m.key, file: doc.name, sent: m.title });
    }
  }
  if (changed || Object.keys(keep).length !== Object.keys(cache).length) save(file, keep);
  // A plan sent again (corrected, or to both children's classes) gives the same events once.
  const seen = new Set();
  return out.filter((e) => {
    const k = `${e.day}|${e.start || ''}|${e.title.toLowerCase()}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).map((e, i) => {
    const title = e.group ? `${e.title} (gruppe ${e.group})` : e.title;
    const timed = e.start && !e.allDay;
    // When school ends is a moment; a quarter of an hour shows it in the day.
    const end = e.kind === 'ends' ? new Date(Date.parse(at(e.day, e.start)) + 15 * 6e4).toISOString() : timed && at(e.day, e.end);
    return {
      uid: `school:${e.key}:${e.day}:${i}`,
      title,
      start: timed ? at(e.day, e.start) : at(e.day),
      end: timed ? end : at(nextDay(e.day)),
      allDay: !timed,
      fyi: true,
      kind: e.kind,
      description: [e.details, `From ${e.file}${e.sent ? `, in "${e.sent}"` : ''}.`].filter(Boolean).join('\n'),
      read: { src: 'flyt', key: e.key },
    };
  });
}
