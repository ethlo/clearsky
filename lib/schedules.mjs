// Scheduled chats: a message Clearsky sends to a new sandboxed chat at set times ("every
// weekday at 08:30, check CI on my PRs"), like Claude Code's scheduled tasks. Each run is an
// ordinary chat (lib/app/schedules.mjs starts it the way hand-offs start theirs), so it gets the
// same folders, sandbox and doors: anything that leaves the sandbox still waits for your OK.
// The list lives in ~/.config/clearsky/schedules.json.

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

export const MAX = 30;
export const CATCH_UP_HOURS = 6; // a run missed while Clearsky was off still happens if it's this recent
export const DAYS = { daily: [0, 1, 2, 3, 4, 5, 6], weekdays: [1, 2, 3, 4, 5], weekends: [0, 6] };
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export function readSchedules(file) {
  try { const d = JSON.parse(readFileSync(file, 'utf8')); return Array.isArray(d) ? d.filter((s) => s && typeof s === 'object' && s.id) : []; } catch { return []; }
}
export function saveSchedules(file, list) {
  writeFileSync(`${file}.tmp`, `${JSON.stringify(list, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

// "weekdays 08:30", "daily 7:00", "mon,thu 16:15", "every 2h" (on the hour, from midnight).
export function parseWhen(text) {
  const t = String(text || '').trim().toLowerCase();
  const every = t.match(/^every\s+(\d{1,2})\s*h(ours?)?$/);
  if (every) { const n = Number(every[1]); return n >= 1 && n <= 24 ? { everyHours: n } : null; }
  const m = t.match(/^([a-z,\s]+?)\s+(?:at\s+)?(\d{1,2})[:.](\d{2})$/);
  if (!m) return null;
  const h = Number(m[2]), min = Number(m[3]);
  if (h > 23 || min > 59) return null;
  const word = m[1].trim();
  const days = DAYS[word] || word.split(/[\s,]+/).filter(Boolean).map((d) => DAY_NAMES.indexOf(d.slice(0, 3)));
  if (!days.length || days.some((d) => d < 0)) return null;
  return { days: [...new Set(days)].sort(), time: `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}` };
}
export function whenText(w) {
  if (!w) return '';
  if (w.everyHours) return `every ${w.everyHours}h`;
  const name = Object.entries(DAYS).find(([, d]) => d.join() === w.days.join())?.[0] || w.days.map((d) => DAY_NAMES[d]).join(',');
  return `${name} ${w.time}`;
}

// The first time after `after` (ms) it should run, in local time.
export function nextRun(w, after) {
  const d = new Date(after);
  if (w?.everyHours) {
    d.setMinutes(0, 0, 0);
    do d.setHours(d.getHours() + 1); while (d.getHours() % w.everyHours !== 0);
    return d.getTime();
  }
  if (!w?.days?.length) return null;
  const [h, m] = w.time.split(':').map(Number);
  for (let i = 0; i < 8; i++) {
    const c = new Date(after);
    c.setDate(c.getDate() + i);
    c.setHours(h, m, 0, 0);
    if (c.getTime() > after && w.days.includes(c.getDay())) return c.getTime();
  }
  return null;
}

// What to do with each schedule now: 'run' (due), 'skip' (missed too long ago, while Clearsky
// was off: move on to the next time), or nothing.
export function dueNow(s, now = Date.now()) {
  if (s.paused || !s.when) return null;
  const from = Date.parse(s.lastRun || s.createdAt) || now;
  const at = nextRun(s.when, from);
  if (at == null || at > now) return null;
  return now - at > CATCH_UP_HOURS * 3600e3 ? 'skip' : 'run';
}

// A schedule from the page: checked, with only the fields it may have.
export function cleanSchedule(x, { isDir = () => true } = {}) {
  const name = String(x?.name || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const prompt = String(x?.prompt || '').trim().slice(0, 8000);
  const when = parseWhen(x?.when);
  const cwd = String(x?.cwd || '').trim();
  if (!name) return { error: 'Give it a name.' };
  if (!prompt) return { error: 'Say what the chat should do.' };
  if (!when) return { error: 'When: like "weekdays 08:30", "daily 7:00", "mon,thu 16:15" or "every 2h".' };
  if (cwd && (!cwd.startsWith('/') || !isDir(cwd))) return { error: `${cwd} isn't a folder here.` };
  return { name, prompt, when, cwd: cwd || null, paused: !!x?.paused };
}

export function addSchedule(list, fields, now = new Date()) {
  if (list.length >= MAX) return { error: `At most ${MAX} schedules.` };
  const s = { id: randomBytes(5).toString('hex'), ...fields, createdAt: now.toISOString(), lastRun: null, runs: [] };
  return { list: [...list, s], schedule: s };
}
export const updateSchedule = (list, id, patch) => list.map((s) => (s.id === id ? { ...s, ...patch } : s));

// One run's record: newest first, the last ten.
export function noteRun(s, run) { return { ...s, lastRun: run.at, runs: [run, ...(s.runs || [])].slice(0, 10) }; }

// The message the chat gets: what you wrote, and that nobody is watching it live.
export function schedulePrompt(s, at = new Date()) {
  return `This chat was started by a schedule ("${s.name}", ${whenText(s.when)}) at ${at.toISOString().slice(0, 16).replace('T', ' ')} UTC; I'm not watching it live. `
    + `Do what it asks and end with a short summary of what you found or did. Anything that needs my OK waits for me as usual.\n\n${s.prompt}`;
}
