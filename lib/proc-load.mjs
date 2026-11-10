// How hard each chat's sandbox works on this machine (Linux /proc): CPU and memory of a process
// and everything under it, for the VMs view. The sandbox fences files and network, not CPU, so a
// build run in it (instead of in the chat's VM) shows here as sandbox load.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const TICKS = 100; // USER_HZ: 100 on every Linux Clearsky runs on
const PAGE_KB = 4;

// One line of /proc/<pid>/stat: the name is in parentheses and may hold spaces or ')'.
export function parseStat(line) {
  const open = line.indexOf('('), close = line.lastIndexOf(')');
  if (open < 0 || close < open) return null;
  const f = line.slice(close + 2).split(' ');
  return { pid: Number(line.slice(0, open)), name: line.slice(open + 1, close), ppid: Number(f[1]), ticks: Number(f[11]) + Number(f[12]), rssKb: Number(f[21]) * PAGE_KB };
}

// What a Java process is, from its command line: Maven, Surefire's test fork, Gradle.
export function label(name, cmdline = '') {
  if (name !== 'java') return name;
  if (/surefire|failsafe/.test(cmdline)) return 'java (tests)';
  if (/plexus-classworlds|org\.codehaus\.plexus\.classworlds|maven/.test(cmdline)) return 'java (Maven)';
  if (/gradle/i.test(cmdline)) return 'java (Gradle)';
  return name;
}

export function readProcs(root = '/proc') {
  const procs = new Map();
  let names;
  try { names = readdirSync(root); } catch { return procs; }
  for (const d of names) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const p = parseStat(readFileSync(join(root, d, 'stat'), 'utf8'));
      if (p) procs.set(p.pid, p);
    } catch { /* gone already */ }
  }
  return procs;
}

// Each look compares CPU ticks with the one before, per process. `sample(roots)` takes
// key → root pid (a chat's sandbox) and gives key → { cpuPct (of one core, like top), memMb,
// procs, top: { pid, name, cpuPct } } for the roots still running. The first look has no CPU yet.
export class TreeLoad {
  constructor({ read = readProcs, cmdline = (pid) => { try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' '); } catch { return ''; } }, now = Date.now } = {}) {
    Object.assign(this, { read, cmdline, now, last: new Map(), at: null });
  }
  sample(roots) {
    const procs = this.read(), t = this.now(), secs = this.at != null ? (t - this.at) / 1000 : 0;
    const kids = new Map();
    for (const p of procs.values()) { if (!kids.has(p.ppid)) kids.set(p.ppid, []); kids.get(p.ppid).push(p); }
    const out = new Map();
    for (const [key, pid] of roots) {
      const top = procs.get(pid);
      if (!top) continue;
      let cpu = 0, rss = 0, n = 0, busiest = null;
      const stack = [top];
      while (stack.length) {
        const p = stack.pop();
        n++; rss += p.rssKb;
        const prev = this.last.get(p.pid);
        const pct = secs > 0 && prev != null && p.ticks >= prev ? ((p.ticks - prev) / TICKS / secs) * 100 : null;
        if (pct != null) { cpu += pct; if (!busiest || pct > busiest.cpuPct) busiest = { pid: p.pid, name: p.name, cpuPct: pct }; }
        stack.push(...(kids.get(p.pid) || []));
      }
      if (busiest) busiest = { ...busiest, name: label(busiest.name, this.cmdline(busiest.pid)), cpuPct: Math.round(busiest.cpuPct) };
      out.set(key, { cpuPct: secs > 0 ? Math.round(cpu) : null, memMb: Math.round(rss / 1024), procs: n, top: busiest });
    }
    this.last = new Map([...procs.values()].map((p) => [p.pid, p.ticks]));
    this.at = t;
    return out;
  }
}
