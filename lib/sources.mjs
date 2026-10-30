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
//                                                     // view: 'table' shows items as an inbox: needs at, from,
//                                                     // group, files and unread on each; counts what's unread
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
//     // Optional: read an item in full inside Clearsky instead of on the source's site. Items
//     // with `detail: true` open in a reader. `data` is what fetch() returned.
//     async detail(key, ctx, data) { return { title, meta, url, messages: [{ from, at, text, mine,
//       attachments: [{ id, name, type, bytes }] }] } },
//     async attachment(key, id, ctx, data) { return { data: Buffer, type, name } },
//
//     // Optional, shown in Settings → Modules: what it holds and reaches. With `hosts`, ctx.fetch
//     // and ctx.json refuse any other host.
//     manifest: {
//       secrets: [{ key: 'SLACK_TOKEN', kind: 'token' }],  // kind: token | web-session | cli-login | keyring
//       hosts: ['api.example.com', '*.example.net'], clis: ['skolectl'], files: ['~/.config/clearsky/x.json'],
//     },
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
  for (const k of ['secrets', 'hosts', 'clis', 'files']) if (s.manifest?.[k] != null && !Array.isArray(s.manifest[k])) throw bad(`manifest.${k} must be a list`);
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

// Whether a URL's host is one of the patterns (exact, or *.example.com for its subdomains).
export function hostAllowed(url, hosts) {
  let h;
  try { h = new URL(url).hostname.toLowerCase(); } catch { return false; }
  return hosts.some((p) => (p.startsWith('*.') ? h.endsWith(p.slice(1).toLowerCase()) : h === p.toLowerCase()));
}

// What a source's fetch() gets: its own settings only (not the other sources' tokens), plus
// small helpers so most sources need no imports. With manifest.hosts, the helpers reach only those.
export function makeContext(source, env = process.env) {
  const settings = Object.fromEntries(Object.keys(source.settings || {}).map((k) => [k, env[k] || '']));
  const hosts = source.manifest?.hosts;
  const guarded = (url, opts) => {
    if (hosts && !hostAllowed(url, hosts)) return Promise.reject(new Error(`${source.label}: ${new URL(url).host} is not in its manifest`));
    return fetch(url, opts);
  };
  return {
    env: settings,
    fetch: guarded,
    async json(url, opts = {}) {
      const res = await guarded(url, opts);
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
