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

export function setDismissed(path, { key, stamp, clear }) {
  const state = readState(path);
  const d = clear ? {} : { ...(state.dismissed || {}) };
  if (!clear) {
    if (typeof key !== 'string' || !key || key.length > 500) throw new Error('bad key');
    if (stamp == null) delete d[key];
    else d[key] = String(stamp).slice(0, 200);
  }
  // Keep the file small: drop the oldest entries beyond 2000.
  const keys = Object.keys(d);
  for (const k of keys.slice(0, Math.max(0, keys.length - 2000))) delete d[k];
  writeState(path, { ...state, dismissed: d });
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
