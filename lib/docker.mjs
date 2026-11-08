// Clearsky in Docker, from the same settings as on your machine: `clearsky docker up` mounts
// the folders Copilot may use (Settings → Copilot) at the same paths, plus the tool folders
// that exist here (JDKs, Maven, Evolution's calendars), and starts the container. Change the
// folders in Settings and run `clearsky docker up` again to mount them.

import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';

// What the container needs besides your code, mounted only if it exists (Docker would create
// a missing one, owned by root). ro: read-only inside.
const TOOL_MOUNTS = [
  ['.config/clearsky'], // settings and state, the container's logins
  ['.copilot'], // Copilot's sessions and skills
  ['.local/share/clearsky/memory'], // Copilot's memory (lib/memory.mjs)
  ['.gitconfig', 'ro'],
  ['.m2'], ['.gradle'], ['.sdkman', 'ro'], ['.jdks', 'ro'], ['/usr/lib/jvm', 'ro'],
  // Calendars that GNOME Online Accounts syncs: Clearsky reads Evolution's caches. Writable,
  // because SQLite shares the cache with Evolution while reading.
  ['.cache/evolution/calendar'], ['.config/evolution/sources', 'ro'],
];

const expand = (p, home) => resolve(p.startsWith('~') ? join(home, p.slice(1)) : p.startsWith('/') ? p : join(home, p));
const inside = (p, parent) => p === parent || p.startsWith(parent.endsWith(sep) ? parent : parent + sep);

// [{ path, ro }]: your folders (a folder inside another one is covered by it), then the tools'.
export function dockerMounts({ folders, cwd, home, exists = existsSync }) {
  const code = [...folders, cwd].filter(Boolean).map((f) => expand(f.trim(), home)).filter((p) => exists(p));
  const mine = [...new Set(code)].filter((p, _, all) => !all.some((q) => q !== p && inside(p, q)));
  const tools = TOOL_MOUNTS.map(([p, mode]) => ({ path: expand(p, home), ro: mode === 'ro' }))
    .filter((m) => exists(m.path) && !mine.some((p) => inside(m.path, p)));
  return [...mine.map((path) => ({ path, ro: false })), ...tools];
}

// The compose file that adds them, next to docker-compose.yml when it starts.
export function mountsYaml(mounts) {
  const q = (s) => JSON.stringify(s);
  return `# Written by \`clearsky docker up\` from Settings → Copilot → folders; changes are overwritten.
services:
  clearsky:
    volumes:
${mounts.map((m) => `      - ${q(`${m.path}:${m.path}${m.ro ? ':ro' : ''}`)}`).join('\n')}
`;
}

export function writeMountsFile(file, mounts) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, mountsYaml(mounts), { mode: 0o600 });
  return file;
}
