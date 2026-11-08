// Files you point a chat at with @: Copilot gets their path, not their contents, and reads what
// it needs when it needs it, so a big log or a whole folder costs no context until it's opened.
// Only files and folders the chat can already read (its folder, Settings → Copilot's folders, the
// read-only ones and the chat's own), never a secret the sandbox hides.

import { resolve, sep, join, basename, dirname } from 'node:path';
import { statSync, realpathSync, readdirSync } from 'node:fs';
import { SECRETS } from './sandbox.mjs';

const real = (p) => { try { return realpathSync(p); } catch { return null; } };
const expand = (p, home) => resolve(String(p).replace(/^~(?=\/|$)/, home));
export const tilde = (p, home) => (p === home || p.startsWith(`${home}${sep}`) ? `~${p.slice(home.length)}` : p);
const inside = (p, root) => p === root || p.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
// Folders a search walks past: builds, dependencies and VCS data are noise when you look for a file.
const SKIP = new Set(['node_modules', '.git', 'target', 'build', 'dist', 'out', '.gradle', '.idea', '.venv', 'venv', '__pycache__', '.next', '.cache', 'coverage']);

// The folders a chat can read, real paths, most specific first, without duplicates.
export function fileRoots(dirs, home) {
  const out = [];
  for (const d of dirs) {
    if (!d) continue;
    const r = real(expand(d, home));
    try { if (!r || !statSync(r).isDirectory()) continue; } catch { continue; }
    if (!out.includes(r)) out.push(r);
  }
  return out;
}

function hidden(path, home) {
  const h = real(home) || home;
  return SECRETS.map((s) => expand(s, h)).some((s) => inside(path, s));
}

// One path you typed or picked: a file or folder inside the chat's folders, or why not.
export function checkFileRef(input, { roots, home, cwd }) {
  const raw = String(input || '').trim();
  if (!raw) return { error: 'Say which file.' };
  const abs = /^(~|\/)/.test(raw) ? expand(raw, home) : resolve(cwd || roots[0] || home, raw);
  const path = real(abs);
  if (!path) return { error: `${raw} isn't on this machine.` };
  let st;
  try { st = statSync(path); } catch { return { error: `${raw} isn't on this machine.` }; }
  if (!st.isFile() && !st.isDirectory()) return { error: `${raw} isn't a file or folder.` };
  if (hidden(path, home)) return { error: `${raw} is something the sandbox keeps hidden.` };
  if (!roots.some((r) => inside(path, r))) return { error: `${raw} is outside this chat's folders (add the folder in the chat's side panel first).` };
  return { path, dir: st.isDirectory(), size: st.isFile() ? st.size : null };
}

// Suggestions for the @ picker. A query that looks like a path lists that folder's entries
// starting with what you typed; anything else matches file names under the chat's folders.
export function findFiles(q, { roots, home, cwd, max = 30, budget = 20_000 }) {
  q = String(q || '').trim();
  const out = [];
  const add = (p, dir) => { if (out.length < max && !hidden(p, home) && roots.some((r) => inside(p, r))) out.push({ path: p, shown: tilde(p, home), name: basename(p), dir }); };
  const entries = (d) => { try { return readdirSync(d, { withFileTypes: true }); } catch { return []; } };
  if (/^(~|\/|\.\.?\/)/.test(q) || q.includes('/')) {
    const abs = /^(~|\/)/.test(q) ? expand(q, home) : resolve(cwd || roots[0] || home, q);
    const [dir, start] = q.endsWith('/') ? [abs, ''] : [dirname(abs), basename(abs).toLowerCase()];
    const d = real(dir);
    if (!d) return out;
    for (const e of entries(d).sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name))) {
      if (!e.name.toLowerCase().startsWith(start) || (e.name.startsWith('.') && !start.startsWith('.'))) continue;
      if (e.isDirectory() || e.isFile()) add(join(d, e.name), e.isDirectory());
    }
    return out;
  }
  if (q.length < 2) return out;
  const needle = q.toLowerCase();
  // Breadth first, the chat's own folder before the others, so near files come first.
  const queue = roots.map((r) => [r, 0]);
  const seen = new Set();
  let looked = 0;
  while (queue.length && out.length < max && looked < budget) {
    const [d, depth] = queue.shift();
    if (seen.has(d)) continue;
    seen.add(d);
    for (const e of entries(d)) {
      looked++;
      if (e.name.startsWith('.') && !needle.startsWith('.')) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (SKIP.has(e.name)) continue;
        if (e.name.toLowerCase().includes(needle)) add(p, true);
        if (depth < 6) queue.push([p, depth + 1]);
      } else if (e.isFile() && e.name.toLowerCase().includes(needle)) add(p, false);
    }
  }
  return out;
}

// The line that goes at the end of your message: paths only, and how to use them.
export function fileRefLine(refs, home) {
  if (!refs.length) return '';
  const shown = refs.map((r) => `${tilde(r.path, home)}${r.dir ? '/' : ''}`);
  return `Files I'm pointing you at (read them from disk, and only the parts you need): ${shown.join(', ')}`;
}
