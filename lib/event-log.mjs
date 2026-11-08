// Clearsky's own log of what happens to the server (starts, restarts, unexpected errors), kept
// in a file because a server started from the app window or restarted by itself has no
// terminal. ~/.cache/clearsky/clearsky.log (CLEARSKY_LOG for another), one line per event,
// with the previous file kept as clearsky.log.1 once it passes 512 KB.
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const MAX = 512 * 1024;
export const logFile = (env = process.env) => env.CLEARSKY_LOG || join(homedir(), '.cache', 'clearsky', 'clearsky.log');

export function logEvent(msg, { file = logFile(), now = new Date(), echo = true } = {}) {
  if (echo) console.log(`clearsky: ${msg}`);
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    try { if (statSync(file).size > MAX) renameSync(file, `${file}.1`); } catch { /* no file yet */ }
    appendFileSync(file, `${now.toISOString()} ${msg}\n`, { mode: 0o600 });
  } catch { /* logging must never break the server */ }
}
