// The GitHub repos a chat works on: writes to those go through without asking (lib/github-gate.mjs,
// githubScope in lib/app/chat-gate.mjs). They come from the git remotes in the chat's folder, and the
// chat can write in that folder. So the remotes are read once, when the chat starts, and kept:
// a remote the chat adds later, or a clone it makes, doesn't widen what goes through. Writes to
// such a repo ask, and your Allow adds it to the chat's list.
//
// Kept in a file of its own next to the state (a chat's agent is stopped when idle and started
// again, and Clearsky restarts): { sessionId: { '.': [repos], 'sub/dir': [repos], '+': [repos] } }.
// '.' is the chat's folder when it is a clone; the other paths are the clones in a folder of
// clones; '+' holds the repos you allowed in the chat.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const sub = (d) => { try { return readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => join(d, e.name)); } catch { return []; } };
const isClone = (d) => existsSync(join(d, '.git'));

// The clones in a folder: the folder itself, or the clones one and two levels down.
export function clonesIn(root, { max = 300 } = {}) {
  if (isClone(root)) return [root];
  return sub(root).flatMap((d) => (isClone(d) ? [d] : sub(d).slice(0, 50).filter(isClone))).slice(0, max);
}

// The branch a clone (or worktree) is on, in capitals, read from its HEAD file: no git is run.
export function headBranch(dir) {
  try {
    // A worktree's .git is a file pointing at its own folder in the main clone.
    const git = statSync(join(dir, '.git')).isFile() ? resolve(dir, readFileSync(join(dir, '.git'), 'utf8').match(/^gitdir: (.+)$/m)[1].trim()) : join(dir, '.git');
    return (readFileSync(join(git, 'HEAD'), 'utf8').match(/^ref: refs\/heads\/(.+)/) || [])[1]?.toUpperCase() || '';
  } catch { return ''; }
}

// What the chat's folder holds right now. `remotes(dir)`: the GitHub repos of a folder's git
// remotes (null when it isn't in a repo).
export async function scopeSnapshot(cwd, remotes) {
  const out = { '.': [...new Set(await remotes(cwd) || [])] };
  if (isClone(cwd)) return out;
  const dirs = clonesIn(cwd);
  for (let i = 0; i < dirs.length; i += 16) {
    await Promise.all(dirs.slice(i, i + 16).map(async (d) => {
      const r = await remotes(d).catch(() => null);
      if (r?.length) out[relative(cwd, d)] = [...new Set(r)];
    }));
  }
  return out;
}

// The repos a chat's list gives it now: its own folder's, the ones you allowed, and, in a folder
// of clones, those of the clones whose branch is named after one of the chat's tickets.
// `branch(path)`: the branch of the clone at that path under the chat's folder.
export function scopeRepos(scope = {}, { tickets = new Set(), branch = () => '' } = {}) {
  const set = new Set([...(scope['.'] || []), ...(scope['+'] || [])]);
  const named = (b) => [...tickets].some((t) => new RegExp(`(^|[^A-Z0-9])${t}([^0-9]|$)`).test(b));
  if (tickets.size) {
    for (const [path, repos] of Object.entries(scope)) {
      if (path !== '.' && path !== '+' && named(branch(path))) for (const r of repos) set.add(r);
    }
  }
  return set;
}

const read = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; } };
function write(file, all) {
  const ids = Object.keys(all);
  for (const k of ids.slice(0, Math.max(0, ids.length - 200))) delete all[k];
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(all)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

export const scopeOf = (file, id) => (id && Object.hasOwn(read(file), id) ? read(file)[id] : null);

export function saveScope(file, id, scope) {
  if (id) write(file, { ...read(file), [id]: scope });
  return scope;
}

// A repo you allowed in a chat: part of its list from now on.
export function addScopeRepo(file, id, repo) {
  const all = read(file);
  if (!id || !repo || !all[id]) return;
  all[id] = { ...all[id], '+': [...new Set([...(all[id]['+'] || []), repo.toLowerCase()])].slice(-50) };
  write(file, all);
}
