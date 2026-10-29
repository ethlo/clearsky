// Sources beyond the built-in ones (GitHub, Jira, Slack, calendars), each one module.
//
// A source module's default export:
//
//   export default {
//     name: 'visma',                       // id: lowercase letters, digits, - (used in URLs)
//     label: 'Visma Flyt Skole',
//     area: 'personal',                    // 'work' or 'personal' (default): which tab its panel is on
//     settings: {                          // optional: fields on the Settings page, saved to .env
//       VISMA_CHILD: { label: 'Child', hint: 'As shown in the app', secret: false },
//     },
//     enabled: (env) => !!env.VISMA_CHILD, // optional: skip fetching until it's set up
//     async fetch(ctx) { return { items: [...] } },   // ctx: see makeContext() below
//
//     // Optional hooks. Each gets what fetch() returned.
//     panel: { title: 'School', zone: 'track' },      // 'needs' (needs you) or 'track' (keeping track)
//     items(data) { return [{ key, stamp, title, url, meta, badge, tone, quote }] },
//     attention(data) { return [{ key, stamp, title, body, url }] },  // notifies when new
//     events(data) { return [{ uid, title, start, end, allDay, fyi }] }, // into Now / Next
//     standup(data, since) { return { yesterday: ['…'], today: ['…'] } },
//
//     // Optional: a login started from Settings, for sources that can't use a token.
//     login: {
//       label: 'Log in with BankID',                 // the button
//       async status(env) { return { loggedIn, detail } },
//       async start(env) { return { settings: { KEY: 'value' } } }, // resolves when done; settings are saved
//     },
//   };
//
// A fetch() that fails with an error that has `auth: true` asks you to log in again.
//
// Clearsky loads lib/sources/*.mjs from the repo and ~/.config/clearsky/sources/*.mjs, which
// is for your own private sources and is never committed anywhere.

import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const RESERVED = new Set(['github', 'jira', 'jiraMentions', 'slack', 'calendar']);

export function checkSource(mod, file) {
  const s = mod?.default;
  const bad = (why) => new Error(`${file}: ${why}`);
  if (!s || typeof s !== 'object') throw bad('needs a default export');
  if (!/^[a-z][a-z0-9-]{1,30}$/.test(s.name || '')) throw bad('name must be lowercase letters, digits and -');
  if (RESERVED.has(s.name)) throw bad(`"${s.name}" is a built-in source`);
  if (typeof s.fetch !== 'function') throw bad('needs a fetch(ctx) function');
  for (const k of Object.keys(s.settings || {})) if (!/^[A-Z][A-Z0-9_]+$/.test(k)) throw bad(`setting ${k} must be UPPER_CASE`);
  if (s.panel && !['needs', 'track'].includes(s.panel.zone || 'track')) throw bad('panel.zone must be "needs" or "track"');
  if (s.area && !['work', 'personal'].includes(s.area)) throw bad('area must be "work" or "personal"');
  if (s.login && typeof s.login.start !== 'function') throw bad('login needs a start(env) function');
  return { label: s.name, ...s, area: s.area || 'personal', panel: s.panel && { zone: 'track', title: s.label || s.name, ...s.panel } };
}

// Only load files you own that nobody else can change.
function safeFile(path) {
  const st = statSync(path);
  return st.isFile() && (st.mode & 0o022) === 0 && (typeof process.getuid !== 'function' || st.uid === process.getuid());
}

// Files in `trusted` folders (the repo's own lib/sources, as trusted as the rest of its code)
// skip the permission check, which is for your private folder.
export async function loadSources(dirs, { trusted = [] } = {}) {
  const out = new Map(), errors = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.mjs')).sort()) {
      const path = join(dir, f);
      try {
        if (!trusted.includes(dir) && !safeFile(path)) throw new Error(`${path}: skipped, it is writable by others or not yours`);
        const s = checkSource(await import(pathToFileURL(path).href), path);
        if (out.has(s.name)) throw new Error(`${path}: a source called "${s.name}" is already loaded`);
        out.set(s.name, { ...s, file: path });
      } catch (e) {
        errors.push(e.message);
      }
    }
  }
  return { sources: out, errors };
}

// What a source's fetch() gets: settings, plus small helpers so most sources need no imports.
export function makeContext(source, env = process.env) {
  const settings = Object.fromEntries(Object.keys(source.settings || {}).map((k) => [k, env[k] || '']));
  return {
    env: settings,
    async json(url, opts = {}) {
      const res = await fetch(url, opts);
      if (!res.ok) throw new Error(`${source.label}: ${res.status} ${res.statusText}`);
      return res.json();
    },
    // Run a CLI (like acli or skolectl) and parse JSON output when it is JSON.
    async run(bin, args, { timeout = 30_000 } = {}) {
      const { stdout } = await execFileP(bin, args, { timeout, maxBuffer: 20 * 1024 * 1024 });
      try { return JSON.parse(stdout); } catch { return stdout; }
    },
  };
}

// A hook that throws or returns junk shouldn't take the page down.
export function hook(source, name, ...args) {
  if (typeof source[name] !== 'function') return null;
  try { return source[name](...args); } catch (e) { return { hookError: `${source.label} ${name}: ${e.message}` }; }
}

export const asList = (v) => (Array.isArray(v) ? v : []);
