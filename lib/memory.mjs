// Copilot's long-term memory: one short Markdown file of notes that every new chat reads,
// so you don't tell each chat the same things again. It stays on this machine, outside any repo.
// Copilot reads it from disk by its path (like a file you point at with @) and never writes it:
// it suggests a note as a ```remember block, and the note is saved only when you press Save
// on its card (web/js/50-chat.js). You edit the whole file in Settings → Copilot.
//
// Notes go under "## All chats", or under "## owner/name" for one repo; Copilot is asked to
// use only the part for the repo it works in.

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

// Short on purpose: you can read it all, and it costs little to read in every chat.
export const MAX_BYTES = 4096;
export const ALL = 'All chats';
const HEAD = '# Copilot\'s memory\n\nNotes every new Copilot chat reads. Edit freely.\n';

// Its own folder, so it can be readable to a sandboxed Copilot without anything else of Clearsky's.
export const memoryDir = (env = process.env, home = homedir()) => env.CLEARSKY_MEMORY_DIR || join(home, '.local', 'share', 'clearsky', 'memory');
export const memoryFile = (env, home) => join(memoryDir(env, home), 'memory.md');

export function readMemory(file) {
  try { return readFileSync(file, 'utf8'); } catch { return ''; }
}

const size = (text) => Buffer.byteLength(text, 'utf8');
const full = (n) => `Memory is full (${n} of ${MAX_BYTES} bytes). Tidy it in Settings → Copilot, then save again.`;

// The whole file, as you edited it. Returns { text } or { error }.
export function writeMemory(file, text) {
  text = String(text ?? '').replace(/\r\n/g, '\n');
  if (size(text) > MAX_BYTES) return { error: full(size(text)) };
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, file);
  return { text };
}

// A repo name as GitHub writes it, or null for "all chats".
const validRepo = (r) => (/^[\w.-]+\/[\w.-]+$/.test(String(r || '').trim()) ? String(r).trim() : null);
const clean = (l) => String(l).replace(/\s+/g, ' ').trim().replace(/^[-*]\s+/, '').slice(0, 300);

// A ```remember block: an optional "repo: owner/name" line, then one note per line.
export function parseRemember(body) {
  let repo = null;
  const lines = [];
  for (const raw of String(body || '').split('\n')) {
    const m = raw.match(/^\s*repo:\s*(\S+)\s*$/i);
    if (m && !lines.length && !repo) { repo = validRepo(m[1]); continue; }
    const l = clean(raw);
    if (l) lines.push(l);
  }
  return { repo, lines: lines.slice(0, 10) };
}

const has = (text, line) => text.split('\n').some((l) => clean(l) === line);

// Notes added under their heading (made if missing), skipping ones already there.
// Returns { text, added } or { error }.
export function addNotes(text, { lines, repo }) {
  const heading = `## ${validRepo(repo) || ALL}`;
  const notes = (lines || []).map(clean).filter(Boolean).filter((l, i, a) => a.indexOf(l) === i && !has(text, l));
  if (!notes.length) return { text, added: 0 };
  let out = text.trim() ? text.replace(/\n*$/, '\n') : HEAD;
  const all = out.split('\n');
  const at = all.findIndex((l) => l.trim() === heading);
  const bullets = notes.map((l) => `- ${l}`);
  if (at < 0) out = `${out}\n${heading}\n${bullets.join('\n')}\n`;
  else {
    // After the section's last line that isn't blank, before the next heading.
    let end = at + 1;
    while (end < all.length && !/^#{1,2}\s/.test(all[end])) end++;
    while (end > at + 1 && !all[end - 1].trim()) end--;
    all.splice(end, 0, ...bullets);
    out = all.join('\n');
  }
  if (size(out) > MAX_BYTES) return { error: full(size(out)) };
  return { text: out, added: notes.length };
}

// What a new chat is told: where the memory is and how to suggest a note.
export function memoryHint(file, text, home = homedir()) {
  const shown = file.startsWith(home) ? `~${file.slice(home.length)}` : file;
  const read = text.trim()
    ? `My long-term memory is in ${shown}: notes I keep across chats. Read it from disk before you start, and use the part under "${ALL}" and the part for the repo you work in (a "## owner/name" heading); skip other repos' parts. `
    : `My long-term memory (${shown}) is empty so far. `;
  return `${read}Never change that file yourself. When you learn something worth keeping for later chats (how I like things done, how a repo builds or tests, a decision we made that will hold), and not just a fact about this task, suggest it once, at the end of your answer, as a block I can save:\n`
    + '```remember\nrepo: owner/name (leave this line out for a note for all chats)\nOne short note per line\n```\n'
    + 'At most one block per answer, and only notes I would want in every later chat. Never put secrets, tokens or passwords in one.';
}
