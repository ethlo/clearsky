// Rewind: a snapshot of a chat's working folder before each of your messages, so its files can
// be put back to how they were before any of them (Claude Code's /rewind, for Clearsky chats).
//
// The snapshots live in a git repo of their own under ~/.cache/clearsky/checkpoints/<chat>/,
// outside every folder a chat can write, so the agent can neither see nor change them. Clearsky
// runs it here, as you, with no config of yours or the repo's: no hooks, filters or monitors.
// The folder's own .git (its commits, branches, settings) is never touched; only files are put
// back, and what .gitignore leaves out (target/, node_modules/) is neither saved nor changed.
// Putting files back first saves how they are now, so a rewind can be undone the same way.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync, existsSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

const execFileP = promisify(execFile);
// How the note to the agent after a rewind starts (lib/app/chat-hints.mjs leaves it out of what you see).
export const REWIND_INTRO = '[Clearsky] The user rewound the files';
export const KEEP = 60; // checkpoints per chat
export const MAX_AGE_DAYS = 30; // a chat not used for this long loses its checkpoints

export const baseDir = () => process.env.CLEARSKY_CHECKPOINTS || join(homedir(), '.cache', 'clearsky', 'checkpoints');
const okId = (id) => /^[\w-]{8,64}$/.test(String(id || ''));
const chatDir = (chat) => join(baseDir(), chat);

// git with nothing but what's given here: no system or global config (so no filters, hooks or
// programs of anyone's), our own repo and index, the chat's folder as the work tree.
function git(chat, root, args, { timeout = 60_000 } = {}) {
  const dir = chatDir(chat);
  const env = { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_DIR: join(dir, 'git'), GIT_WORK_TREE: root, GIT_INDEX_FILE: join(dir, 'index'),
    GIT_AUTHOR_NAME: 'Clearsky', GIT_AUTHOR_EMAIL: 'clearsky@localhost', GIT_COMMITTER_NAME: 'Clearsky', GIT_COMMITTER_EMAIL: 'clearsky@localhost' };
  const safe = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false',
    '-c', 'advice.addEmbeddedRepo=false', '-c', 'core.excludesFile=' + join(root, '.git', 'info', 'exclude'), '-c', 'gc.auto=0'];
  return execFileP('git', [...safe, ...args], { cwd: root, env, timeout, maxBuffer: 32 * 1024 * 1024 }).then((r) => String(r.stdout));
}

// The top of the git repo a chat works in, or null: only a repo is snapshotted, never a plain
// folder (your home folder, say), and never the home folder itself.
export async function rootOf(cwd) {
  if (!cwd) return null;
  try {
    const top = String((await execFileP('git', ['-c', 'core.fsmonitor=false', '-C', cwd, 'rev-parse', '--show-toplevel'], { timeout: 5000, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } })).stdout).trim();
    return top && resolve(top) !== resolve(homedir()) && resolve(top) !== '/' ? top : null;
  } catch { return null; }
}

function readIndex(chat) {
  try { const d = JSON.parse(readFileSync(join(chatDir(chat), 'checkpoints.json'), 'utf8')); return { list: Array.isArray(d.list) ? d.list : [], note: d.note || null }; } catch { return { list: [], note: null }; }
}
function writeIndex(chat, d) {
  const f = join(chatDir(chat), 'checkpoints.json');
  writeFileSync(`${f}.tmp`, JSON.stringify(d));
  renameSync(`${f}.tmp`, f);
}

async function ensureRepo(chat, root) {
  const dir = chatDir(chat);
  if (existsSync(join(dir, 'git', 'HEAD'))) return;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  await execFileP('git', ['init', '-q', '--bare', join(dir, 'git')], { env: { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, timeout: 10_000 });
}

// Save the folder as it is now. One per message; `text` is what you wrote (for the list).
// Returns the checkpoint, or null when there's nothing to snapshot.
const chain = new Map(); // one snapshot or rewind at a time per chat
function serial(chat, fn) {
  const run = (chain.get(chat) || Promise.resolve()).then(fn, fn);
  chain.set(chat, run.catch(() => {}));
  return run;
}
export function snapshot(chat, cwd, text, { kind = 'message' } = {}) {
  if (!okId(chat)) return Promise.resolve(null);
  return serial(chat, () => save(chat, cwd, text, kind));
}
async function save(chat, cwd, text, kind) {
  const root = await rootOf(cwd);
  if (!root) return null;
  await ensureRepo(chat, root);
  await git(chat, root, ['add', '-A', '--ignore-errors', '.']).catch(() => {});
  const tree = (await git(chat, root, ['write-tree'])).trim();
  const d = readIndex(chat);
  const prev = d.list.at(-1)?.commit;
  const commit = (await git(chat, root, ['commit-tree', tree, ...(prev ? ['-p', prev] : []), '-m', kind])).trim();
  await git(chat, root, ['update-ref', 'refs/heads/main', commit]);
  const cp = { id: createHash('sha1').update(`${commit}${Date.now()}${Math.random()}`).digest('hex').slice(0, 12), commit, tree, root, kind,
    at: new Date().toISOString(), text: String(text || '').replace(/\s+/g, ' ').trim().slice(0, 200) };
  d.list = [...d.list, cp].slice(-KEEP);
  writeIndex(chat, d);
  prune();
  return cp;
}

// The chat's checkpoints, newest first, with how many files differ from each now.
export async function list(chat) {
  if (!okId(chat)) return [];
  const d = readIndex(chat);
  if (!d.list.length) return [];
  return serial(chat, async () => {
    const out = [];
    const byRoot = new Map();
    for (const cp of [...d.list].reverse()) {
      if (!byRoot.has(cp.root)) {
        // Bring the index up to now (only ours: the folder's own git isn't touched).
        byRoot.set(cp.root, isDirOk(cp.root) ? git(chat, cp.root, ['add', '-A', '--ignore-errors', '.']).catch(() => {}).then(() => true) : Promise.resolve(false));
      }
      let files = null;
      if (await byRoot.get(cp.root)) {
        try { files = (await git(chat, cp.root, ['diff-index', '--cached', '--name-only', '--no-renames', cp.tree])).split('\n').filter(Boolean).length; } catch { files = null; }
      }
      out.push({ id: cp.id, at: cp.at, text: cp.text, kind: cp.kind, root: cp.root, files });
    }
    return out;
  });
}
const isDirOk = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };

// Put the folder's files back to checkpoint `id`. First saves how they are now ("before
// rewind"), so that can be picked to undo it. Returns what changed.
export function rewind(chat, id) {
  if (!okId(chat)) return Promise.reject(new Error('bad chat'));
  return serial(chat, async () => {
    const d = readIndex(chat);
    const cp = d.list.find((x) => x.id === id);
    if (!cp) throw new Error('That checkpoint is gone (only the last ' + KEEP + ' are kept).');
    if (!isDirOk(cp.root)) throw new Error(`${cp.root} isn't there any more.`);
    const before = await save(chat, cp.root, `Before rewinding to "${cp.text.slice(0, 80)}"`, 'rewind');
    const changed = (await git(chat, cp.root, ['diff', '--name-only', '--no-renames', before.tree, cp.tree])).split('\n').filter(Boolean);
    // The index holds the folder as it is now: --reset -u writes the checkpoint's files and
    // removes the ones it didn't have. Ignored files aren't in either, so they stay.
    await git(chat, cp.root, ['read-tree', '--reset', '-u', cp.tree]);
    const note = `${REWIND_INTRO} in ${cp.root} to how they were before their message "${cp.text.slice(0, 120)}" (${changed.length} file${changed.length === 1 ? '' : 's'} put back${changed.length ? `: ${changed.slice(0, 20).join(', ')}${changed.length > 20 ? ', …' : ''}` : ''}). Git's commits, branches and anything already pushed weren't changed. Read the files again before you go on; don't redo the work after that message unless asked.`;
    const after = readIndex(chat);
    after.note = note;
    writeIndex(chat, after);
    return { root: cp.root, changed, undo: before.id };
  });
}

// The note for the agent's next turn after a rewind (once).
export function takeNote(chat) {
  if (!okId(chat)) return null;
  const d = readIndex(chat);
  if (!d.note) return null;
  const { note } = d;
  d.note = null;
  writeIndex(chat, d);
  return note;
}

// Drop the checkpoints of chats not used for MAX_AGE_DAYS (at most once an hour).
let pruned = 0;
export function prune({ now = Date.now(), force = false } = {}) {
  if (!force && now - pruned < 3600e3) return;
  pruned = now;
  let names = [];
  try { names = readdirSync(baseDir()); } catch { return; }
  for (const n of names) {
    if (!okId(n)) continue;
    try { if (now - statSync(join(baseDir(), n, 'checkpoints.json')).mtimeMs > MAX_AGE_DAYS * 864e5) rmSync(join(baseDir(), n), { recursive: true, force: true }); } catch { /* not ours */ }
  }
}
