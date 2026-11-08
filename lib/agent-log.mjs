// What Copilot changed as you (GitHub and Jira writes from its sandbox), kept in a file so its
// changes can be told apart from your own: GitHub and Jira show both as you.
import { appendFileSync, readFileSync, statSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const MAX_BYTES = 5 * 1024 * 1024;

// One write: { where: 'github'|'jira', what, target, chats: [{ id, title }], decided: 'auto'|'allowed'|'declined' }.
export function logWrite(file, entry, now = new Date()) {
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    try { if (statSync(file).size > MAX_BYTES) renameSync(file, `${file}.1`); } catch {}
    appendFileSync(file, `${JSON.stringify({ at: now.toISOString(), ...entry })}\n`, { mode: 0o600 });
  } catch { /* the log never stops the work */ }
}

// Newest first; only one chat's when `chat` is given.
export function readWrites(file, { chat = null, limit = 500 } = {}) {
  let lines = [];
  try { lines = readFileSync(file, 'utf8').split('\n'); } catch { return []; }
  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    let e; try { e = JSON.parse(lines[i]); } catch { continue; }
    if (!chat || (e.chats || []).some((c) => c.id === chat)) out.push(e);
  }
  return out;
}
