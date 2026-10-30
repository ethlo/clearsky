// Branches in your local clones (under ~/dev, or CLEARSKY_CODE_DIRS) that carry a ticket key,
// local or remote, so a ticket can show "ABC-6475 on abc" before there's a PR for it.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const execFileP = promisify(execFile);

// Clones (not worktrees: their branches live in the main clone) two levels down from each root.
export function findClones(roots) {
  const out = [];
  const walk = (dir, depth) => {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules'); } catch { return; }
    for (const e of entries) {
      const d = join(dir, e.name);
      let git = null;
      try { git = statSync(join(d, '.git')); } catch { /* not a clone */ }
      if (git?.isDirectory()) out.push(d);
      else if (!git && depth > 0) walk(d, depth - 1);
    }
  };
  for (const r of roots) walk(r, 2);
  return out;
}

// owner/name of a clone's origin, from its git config.
export function originRepo(clone) {
  try {
    const cfg = readFileSync(join(clone, '.git', 'config'), 'utf8');
    const m = cfg.match(/\[remote "origin"\][^[]*?url\s*=\s*\S*?[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\s*$/m);
    return m ? m[1] : null;
  } catch { return null; }
}

const refCache = new Map();
async function refsOf(clone, maxAgeMs) {
  const hit = refCache.get(clone);
  if (hit && Date.now() - hit.at < maxAgeMs) return hit.refs;
  let refs = [];
  try {
    const { stdout } = await execFileP('git', ['-C', clone, 'for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes'], { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 });
    refs = stdout.split('\n').filter(Boolean);
  } catch { /* not readable; try again next time */ }
  refCache.set(clone, { at: Date.now(), refs });
  return refs;
}

// The branch name of a ref, and whether it is local or on a remote.
export function parseRef(ref) {
  if (ref.startsWith('refs/heads/')) return { branch: ref.slice(11), local: true };
  const m = ref.match(/^refs\/remotes\/[^/]+\/(.+)$/);
  return m && m[1] !== 'HEAD' ? { branch: m[1], remote: true } : null;
}

export const keyPattern = (key) => new RegExp(`(^|[^A-Za-z0-9])${key.replace(/[^\w-]/g, '')}(?![0-9])`, 'i');

// { KEY: [{ repo, clone, branch, local, remote }] } for the keys that have any.
export async function branchesFor(keys, roots, { maxAgeMs = 60_000 } = {}) {
  const out = {};
  if (!keys.length) return out;
  const pats = keys.map((k) => [k, keyPattern(k)]);
  for (const clone of findClones(roots)) {
    const repo = originRepo(clone);
    const found = new Map();
    for (const ref of await refsOf(clone, maxAgeMs)) {
      const r = parseRef(ref);
      if (!r) continue;
      for (const [k, re] of pats) {
        if (!re.test(r.branch)) continue;
        const id = `${k}\0${r.branch}`;
        const b = found.get(id) || { key: k, repo, clone, branch: r.branch, local: false, remote: false };
        Object.assign(b, r.local ? { local: true } : { remote: true });
        found.set(id, b);
      }
    }
    for (const { key, ...b } of found.values()) (out[key] ||= []).push(b);
  }
  return out;
}
