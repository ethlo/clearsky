// Small local state that should survive restarts, such as dismissed items.
// Kept next to the config in ~/.config/clearsky/state.json, readable only by you.

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';

export function readState(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return {}; }
}

export function writeState(path, state) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 1)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

// Dismissed items are { key: stamp }. An item stays hidden while its stamp is unchanged,
// so anything new on it (a commit, review, comment or status change) brings it back.
export function dismissed(path) {
  return readState(path).dismissed || {};
}

export const isDismissed = (d, key, stamp) => key != null && Object.hasOwn(d, key) && d[key] === String(stamp ?? '');

// When each "Do next" task was marked done, for showing it back to you.
export function doneAt(path) {
  return readState(path).doneAt || {};
}

// `done: true` also records the time, for tasks marked done in the "Do next" list.
export function setDismissed(path, { key, stamp, clear, done }) {
  const state = readState(path);
  const d = clear ? {} : { ...(state.dismissed || {}) };
  const at = clear ? {} : { ...(state.doneAt || {}) };
  if (!clear) {
    if (typeof key !== 'string' || !key || key.length > 500) throw new Error('bad key');
    if (stamp == null) { delete d[key]; delete at[key]; }
    else d[key] = String(stamp).slice(0, 200);
    if (stamp != null && done) at[key] = new Date().toISOString();
  }
  for (const k of Object.keys(at)) if (!Object.hasOwn(d, k)) delete at[k];
  // Keep the file small: drop the oldest entries beyond 2000.
  const keys = Object.keys(d);
  for (const k of keys.slice(0, Math.max(0, keys.length - 2000))) delete d[k];
  writeState(path, { ...state, dismissed: d, doneAt: at });
  return d;
}

// Muted items are { key: untilIso }. Unlike a dismissal, new activity doesn't bring a muted
// item back; it stays out of the plan until the time passes.
export function muted(path, now = Date.now()) {
  const m = readState(path).muted || {};
  return Object.fromEntries(Object.entries(m).filter(([, until]) => Date.parse(until) > now));
}

export function setMuted(path, { key, until }) {
  if (typeof key !== 'string' || !key || key.length > 500) throw new Error('bad key');
  const state = readState(path);
  const m = muted(path); // drops expired entries
  if (until == null) delete m[key];
  else if (Number.isNaN(Date.parse(until))) throw new Error('bad time');
  else m[key] = new Date(until).toISOString();
  writeState(path, { ...state, muted: m });
  return m;
}

// What Clearsky has already told you about: { key: { stamp, at } }, where `at` is when it
// first showed up. Kept so a restart doesn't notify you again.
export function seen(path) {
  return readState(path).seen || {};
}

export function setSeen(path, map) {
  const keys = Object.keys(map);
  for (const k of keys.slice(0, Math.max(0, keys.length - 2000))) delete map[k];
  writeState(path, { ...readState(path), seen: map });
}

// Copilot sessions you started about a PR or ticket: { sessionId: ['pr:org/repo#1', 'issue:KEY-1'] }.
export function sessionRefs(path) {
  return readState(path).sessionRefs || {};
}

export function addSessionRefs(path, id, keys) {
  if (!id || !keys.length) return;
  const state = readState(path);
  const all = { ...(state.sessionRefs || {}) };
  all[id] = [...new Set([...(all[id] || []), ...keys])].slice(0, 20);
  const ids = Object.keys(all);
  for (const k of ids.slice(0, Math.max(0, ids.length - 500))) delete all[k];
  writeState(path, { ...state, sessionRefs: all });
}

// What you typed to start a Copilot session here, as its title: Copilot names a session
// after its first prompt, which for these starts with the dashboard Clearsky added.
export function sessionTitles(path) {
  return readState(path).sessionTitles || {};
}

export function setSessionTitle(path, id, title) {
  if (!id || !title) return;
  const state = readState(path);
  const all = { ...(state.sessionTitles || {}), [id]: String(title).slice(0, 120) };
  const ids = Object.keys(all);
  for (const k of ids.slice(0, Math.max(0, ids.length - 500))) delete all[k];
  writeState(path, { ...state, sessionTitles: all });
}

// Names you gave Copilot sessions in Clearsky; they win over any title.
export function sessionNames(path) {
  return readState(path).sessionNames || {};
}

export function setSessionName(path, id, name) {
  if (!id || !name) return;
  const state = readState(path);
  const all = { ...(state.sessionNames || {}), [id]: String(name).slice(0, 120) };
  const ids = Object.keys(all);
  for (const k of ids.slice(0, Math.max(0, ids.length - 500))) delete all[k];
  writeState(path, { ...state, sessionNames: all });
}

// The last notifications sent: { key, kind, stamp, at, via, quiet }, newest last.
export function notifiedLog(path) {
  return readState(path).notified || [];
}

export function logNotified(path, entries) {
  const state = readState(path);
  writeState(path, { ...state, notified: [...(state.notified || []), ...entries].slice(-100) });
}
