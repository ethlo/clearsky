// Your SSH servers, read from ~/.ssh/config and the files it Includes: every named Host (not the
// wildcard patterns), with where it points, the user, the port, and the jump host it goes
// through. Only reads the config; Clearsky never connects to them. Shown on the Servers page.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, basename, isAbsolute } from 'node:path';
import { homedir } from 'node:os';

const KEEP = new Set(['hostname', 'user', 'port', 'proxyjump', 'proxycommand', 'localforward', 'dynamicforward']);

const glob = (pattern) => {
  // Include allows wildcards; we follow them in the last part of the path, as people use them.
  const dir = dirname(pattern), base = basename(pattern);
  if (!/[*?]/.test(base)) return [pattern];
  const re = new RegExp(`^${base.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
  try { return readdirSync(dir).filter((f) => re.test(f) && !f.startsWith('.')).sort().map((f) => join(dir, f)); } catch { return []; }
};

const words = (s) => (s.match(/"[^"]*"|\S+/g) || []).map((w) => w.replace(/^"|"$/g, ''));

// The config as blocks in the order ssh reads them: { patterns, opts, note, file }.
export function readBlocks(file, { home = homedir(), read = (f) => readFileSync(f, 'utf8'), depth = 0, blocks = [], top = { patterns: ['*'], opts: [], file } } = {}) {
  if (depth > 8) return blocks;
  let text;
  try { if (!statSync(file).isFile()) return blocks; text = read(file); } catch { return blocks; }
  let cur = top, note = [];
  if (!blocks.includes(top)) blocks.push(top);
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) { note = []; continue; }
    if (line.startsWith('#')) { note.push(line.replace(/^#+\s?/, '')); continue; }
    const m = line.match(/^(\S+?)(?:\s*=\s*|\s+)(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase(), val = m[2].trim();
    if (key === 'host') { cur = { patterns: words(val), opts: [], note: note.join(' ').trim() || null, file }; blocks.push(cur); }
    else if (key === 'match') { cur = { patterns: [], match: true, opts: [], file }; blocks.push(cur); }
    else if (key === 'include') {
      for (const w of words(val)) {
        const p = w.replace(/^~(?=\/)/, home);
        for (const f of glob(isAbsolute(p) ? p : join(home, '.ssh', p))) readBlocks(f, { home, read, depth: depth + 1, blocks, top: cur });
      }
    } else if (KEEP.has(key)) cur.opts.push([key, val]);
    note = [];
  }
  return blocks;
}

const wild = (p) => new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
const matches = (patterns, name) => {
  let hit = false;
  for (const p of patterns) {
    if (p.startsWith('!')) { if (wild(p.slice(1)).test(name)) return false; } else if (wild(p).test(name)) hit = true;
  }
  return hit;
};

// Group by the start of the name: mig-dr-core and mig-jump are both in "mig".
export const groupOf = (name) => (name.match(/^([^-.]+)[-.]/)?.[1] || 'other').toLowerCase();

// Every named host, with its settings as ssh would work them out: the first value wins.
export function sshHosts(file = join(homedir(), '.ssh', 'config'), opts = {}) {
  const blocks = readBlocks(file, opts);
  const names = [], seen = new Set();
  for (const b of blocks) for (const p of b.patterns) if (!/[*?!]/.test(p) && !seen.has(p.toLowerCase())) { seen.add(p.toLowerCase()); names.push({ name: p, block: b }); }
  const hosts = names.map(({ name, block }) => {
    const got = {};
    for (const b of blocks) {
      if (b.match || !matches(b.patterns, name)) continue;
      for (const [k, v] of b.opts) {
        if (k === 'localforward' || k === 'dynamicforward') (got.forwards ||= []).push(v);
        else if (!(k in got)) got[k] = v;
      }
    }
    const jump = got.proxyjump && got.proxyjump.toLowerCase() !== 'none' ? got.proxyjump : null;
    return {
      name, group: groupOf(name), note: block.note || null,
      host: got.hostname ? got.hostname.replace(/%h/g, name) : null,
      user: got.user || null, port: got.port && got.port !== '22' ? Number(got.port) || got.port : null,
      jump, proxyCommand: !jump && got.proxycommand && got.proxycommand.toLowerCase() !== 'none' ? true : undefined,
      forwards: got.forwards?.length || undefined,
      file: block.file === file ? null : basename(block.file),
    };
  });
  // Jump servers: the ones others go through.
  const jumps = new Set(hosts.flatMap((h) => (h.jump || '').split(',').map((j) => j.replace(/^[^@]*@/, '').replace(/:\d+$/, '').toLowerCase())));
  for (const h of hosts) if (jumps.has(h.name.toLowerCase())) h.isJump = true;
  return hosts;
}
