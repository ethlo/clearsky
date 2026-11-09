// Plugins: sources that are installed on their own, next to a bare Clearsky.
//
// A plugin is a folder with a clearsky-plugin.json and one ES module. It comes from a git repo,
// an npm package or a folder here, and needs no build step and no npm install (zero
// dependencies, like Clearsky itself):
//
//   clearsky add github:someone/clearsky-weather      (a GitHub repo; #ref and /sub/folder work too)
//   clearsky add https://git.example.com/me/plug.git  (any git repo, fetched with your own git login)
//   clearsky add npm:clearsky-weather@1.2.0           (an npm package, fetched without its scripts)
//   clearsky add ./my-plugin                          (a folder here)
//   clearsky add visma-flyt                               (one from Clearsky's catalog, plugins/catalog.json)
//
// clearsky-plugin.json says everything Clearsky shows you before any of the plugin's code runs:
//
//   {
//     "name": "weather",                 // id: lowercase letters, digits and -
//     "label": "Weather",
//     "version": "1.0.0",
//     "description": "Rain on your bike days.",
//     "clearsky": 1,                     // the plugin API it's written for (PLUGIN_API)
//     "entry": "source.mjs",             // its source module (see lib/sources.mjs for the hooks)
//     "area": "personal",                // 'work' or 'personal': which tab its panel is on
//     "panel": { "title": "Weather", "zone": "track" },
//     "settings": { "WEATHER_PLACE": { "label": "Place", "hint": "…", "secret": false } },
//                                        // "type": "list" or "map" (name=value) gets a row per item;
//                                        // "team": true lets a team pack set it (not a secret)
//     "enabledWhen": ["WEATHER_PLACE"],  // fetch only once these settings are filled in
//     "hosts": ["api.met.no"],           // all it may reach
//     "clis": [],                        // programs it may run
//     "secrets": [], "files": [],        // what it keeps, for Settings → Plugins
//     "outside": "…"                     // only if it can't work in the sandbox: why (see below)
//   }
//
// Installed plugins run in a sandbox of their own (lib/plugin-sandbox.mjs): each fetch is a
// separate process under srt that reaches only the plugin's hosts, reads only its own code and
// writes only its own data folder, and gets only its own settings. Your code folders, your
// logins and Clearsky's settings file are out of its sight. A plugin that can't work like that
// (say it opens a browser for a login) says why in "outside"; it then runs inside Clearsky, and
// only if you said so when adding it (`--trust`, or the box in Settings).
//
// The catalog (plugins/catalog.json) names the plugins that have a repo of their own, each
// pinned to a version: `clearsky add visma-flyt` is `clearsky add github:…/clearsky-visma-flyt#v1.0.0`.
// Their code also sits in plugins/clearsky-<name>/ until it lives only in those repos; a
// plugin added from such a folder before ("bundled") keeps loading from it, runs inside, and
// moves to its repo when you add it by name again.
//
// The code is pinned when it's added: its files are hashed, and a plugin whose files changed
// since then isn't loaded until you add or update it again. Git plugins record the commit.
//
// Versions: `github:o/r` follows the repo's default branch, and Update takes what's new there.
// `github:o/r#v1.2.0` (a tag) or `#<commit>` stays on that version: Update fetches the same
// again, and `checkPlugin` lists newer version tags to move to (`clearsky update name --to
// v1.3.0`). A tag that comes back as other code than before is called out. A new version
// that reaches more than the old one is shown to you before it's taken.
//
// Private repos on github.com are fetched with your gh login (ghCredential), so a team's
// plugin in a private repo needs no token.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, rmSync, cpSync, renameSync, mkdtempSync, lstatSync } from 'node:fs';
import { join, dirname, resolve, relative, sep } from 'node:path';
import { homedir } from 'node:os';
import { execFile, spawn } from 'node:child_process';
import * as mcpOAuth from './mcp-oauth.mjs';
import * as mcpClient from './mcp-client.mjs';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { checkSource } from './sources.mjs';
import { findBrowser } from './browser.mjs';

const execFileP = promisify(execFile);

export const PLUGIN_API = 1;
export const MANIFEST = 'clearsky-plugin.json';
export const BUNDLED = fileURLToPath(new URL('../plugins/', import.meta.url));
const NAME = /^[a-z][a-z0-9-]{1,30}$/;
const KEY = /^[A-Z][A-Z0-9_]+$/;
const HOST = /^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+(:\d{1,5})?$/i;
const CLI = /^[\w.+-]+$/;
const DOOR = /^[a-z][a-z0-9-]{1,20}$/;
// Commands of the sandbox's own, which no plugin's door may take.
export const RESERVED_DOORS = new Set(['acli', 'vm', 'outside', 'review', 'usage', 'bg', 'jobs', 'door', 'git', 'gh', 'node', 'npm', 'sh', 'bash']);

// Where installed plugins live: their code (read only to them) and their data, apart from
// ~/.config/clearsky, which no sandbox sees. The list of what you added is in ~/.config/clearsky.
export function pluginPaths({ home = homedir(), env = process.env } = {}) {
  const root = env.CLEARSKY_PLUGINS_DIR || join(home, '.local', 'share', 'clearsky', 'plugins');
  return { root, registry: env.CLEARSKY_PLUGINS_FILE || join(home, '.config', 'clearsky', 'plugins.json') };
}
export const codeDir = (root, name) => join(root, name, 'code');
export const dataDir = (root, name) => join(root, name, 'data');

// ---------------------------------------------------------------- the manifest

// clearsky-plugin.json, checked. Throws with what's wrong, in words.
export function parseManifest(text, where = MANIFEST) {
  let m;
  try { m = typeof text === 'string' ? JSON.parse(text) : text; } catch { throw new Error(`${where} isn't valid JSON`); }
  const bad = (why) => new Error(`${where}: ${why}`);
  if (!m || typeof m !== 'object' || Array.isArray(m)) throw bad('should be a JSON object');
  if (!NAME.test(m.name || '')) throw bad('name must be 2 to 31 lowercase letters, digits and -');
  if (m.clearsky != null && (!Number.isInteger(m.clearsky) || m.clearsky > PLUGIN_API)) throw bad(`it's for plugin API ${m.clearsky}; this Clearsky has ${PLUGIN_API}. Update Clearsky first.`);
  const entry = m.entry || 'source.mjs';
  if (typeof entry !== 'string' || !/^[\w./-]+\.m?js$/.test(entry) || entry.split('/').includes('..') || entry.startsWith('/')) throw bad('entry must be a .mjs file in the plugin');
  const list = (k, ok) => {
    if (m[k] == null) return [];
    if (!Array.isArray(m[k]) || !m[k].every((x) => ok(x))) throw bad(`${k} must be a list of ${k === 'hosts' ? 'host names (*.example.com for subdomains)' : k === 'clis' ? 'program names' : 'entries'}`);
    return m[k];
  };
  const settings = m.settings ?? {};
  if (typeof settings !== 'object' || Array.isArray(settings)) throw bad('settings must be an object');
  for (const [k, f] of Object.entries(settings)) {
    if (!KEY.test(k)) throw bad(`setting ${k} must be UPPER_CASE`);
    if (!f || typeof f !== 'object') throw bad(`setting ${k} needs { label, hint, secret }`);
    if (f.type && !['text', 'list', 'map'].includes(f.type)) throw bad(`setting ${k}: type must be "text", "list" or "map"`);
  }
  if (m.area && !['work', 'personal'].includes(m.area)) throw bad('area must be "work" or "personal"');
  if (m.panel && !['needs', 'track'].includes(m.panel.zone || 'track')) throw bad('panel.zone must be "needs" or "track"');
  if (m.panel?.page === false && m.panel.zone !== 'needs') throw bad('panel.page can be false only with zone "needs", or its rows would be nowhere');
  const enabledWhen = list('enabledWhen', (x) => KEY.test(x));
  if (m.outside != null && (typeof m.outside !== 'string' || !m.outside.trim())) throw bad('outside must say, in words, why it needs to run outside the sandbox');
  // Doors: commands Copilot chats can call through Clearsky (see lib/broker.mjs). They act for the
  // chat with what the plugin holds, so only a plugin that runs inside Clearsky can have them.
  const doors = list('doors', (d) => d && typeof d === 'object' && DOOR.test(d.name || '') && !RESERVED_DOORS.has(d.name) && typeof d.about === 'string');
  if (doors.length && !m.outside) throw bad('doors act as you for chats, so a plugin with doors runs inside Clearsky: say why in "outside"');
  return {
    name: m.name, label: String(m.label || m.name).slice(0, 60), version: String(m.version || '0.0.0').slice(0, 30),
    description: String(m.description || '').slice(0, 300), api: m.clearsky ?? PLUGIN_API, entry,
    area: m.area || 'personal', ...(m.panel && { panel: m.panel }), settings, enabledWhen,
    hosts: list('hosts', (x) => typeof x === 'string' && HOST.test(x)).map((h) => h.toLowerCase()),
    clis: list('clis', (x) => typeof x === 'string' && CLI.test(x)),
    secrets: list('secrets', (x) => x && typeof x === 'object'), files: list('files', (x) => typeof x === 'string'),
    doors: doors.map((d) => ({ name: d.name, about: d.about.slice(0, 300) })),
    ...(m.note && { note: String(m.note).slice(0, 300) }), ...(m.outside && { outside: m.outside.trim().slice(0, 300) }),
  };
}

export function readManifest(dir) {
  const file = join(dir, MANIFEST);
  if (!existsSync(file)) throw new Error(`there's no ${MANIFEST} in it`);
  const m = parseManifest(readFileSync(file, 'utf8'), file);
  if (!existsSync(join(dir, m.entry))) throw new Error(`${m.name}: its entry ${m.entry} is missing`);
  return m;
}

// ---------------------------------------------------------------- the catalog

// plugins/catalog.json: [{ name, aka?, folder?, from }]. `from` is where the plugin lives, pinned.
export function readCatalog(bundled = BUNDLED) {
  try {
    const c = JSON.parse(readFileSync(join(bundled, 'catalog.json'), 'utf8'));
    return (Array.isArray(c.plugins) ? c.plugins : []).filter((e) => e && NAME.test(e.name || '') && typeof e.from === 'string')
      .map((e) => ({ name: e.name, aka: (Array.isArray(e.aka) ? e.aka : []).filter((a) => NAME.test(a)), folder: /^[\w.-]+$/.test(e.folder || '') ? e.folder : null, from: e.from }));
  } catch { return []; }
}
// Plugins that are gone for good, with what to use instead: [{ name, use, why }].
export function readRetired(bundled = BUNDLED) {
  try {
    const c = JSON.parse(readFileSync(join(bundled, 'catalog.json'), 'utf8'));
    return (Array.isArray(c.retired) ? c.retired : []).filter((e) => e && NAME.test(e.name || '') && NAME.test(e.use || ''));
  } catch { return []; }
}
// What to tell someone who still has a retired plugin added.
export function retiredText(name, bundled = BUNDLED) {
  const r = readRetired(bundled).find((e) => e.name === name);
  return r ? `${r.why || `${name} is retired.`} Add ${r.use} (Settings → Plugins, or \`clearsky add ${r.use} --trust\`), then remove ${name}.` : null;
}
export const catalogEntry = (name, bundled = BUNDLED) => readCatalog(bundled).find((e) => e.name === name || e.aka.includes(name)) || null;

// The folder in plugins/ that holds the plugin called `name`: plugins/<name>, the catalog's
// folder for it, or any folder whose manifest has that name. null if there's none.
export function bundledDir(name, bundled = BUNDLED) {
  if (!NAME.test(name || '') || !existsSync(bundled)) return null;
  const has = (d) => existsSync(join(d, MANIFEST));
  if (has(join(bundled, name))) return join(bundled, name);
  const c = catalogEntry(name, bundled);
  const folder = c?.name === name ? c.folder : null;
  if (folder && has(join(bundled, folder))) return join(bundled, folder);
  for (const n of readdirSync(bundled)) {
    const d = join(bundled, n);
    try { if (has(d) && JSON.parse(readFileSync(join(d, MANIFEST), 'utf8')).name === name) return d; } catch { /* not this one */ }
  }
  return null;
}

// ---------------------------------------------------------------- where a plugin comes from

// "github:owner/repo/sub#ref", a git URL, "npm:pkg@1.2", a folder, or a name: from the catalog
// (its repo, at its pin), else a folder in plugins/.
export function parseSpec(spec, { bundled = BUNDLED } = {}) {
  const s = String(spec || '').trim();
  if (!s) throw new Error('say which plugin: github:owner/repo, a git URL, npm:package or a folder');
  let m;
  if ((m = s.match(/^(github|gitlab|codeberg):([\w.-]+)\/([\w.-]+)((?:\/[\w.-]+)*)(?:#([\w./-]+))?$/))) {
    const host = { github: 'github.com', gitlab: 'gitlab.com', codeberg: 'codeberg.org' }[m[1]];
    return { kind: 'git', url: `https://${host}/${m[2]}/${m[3].replace(/\.git$/, '')}.git`, sub: m[4].slice(1), ref: m[5] || null, from: s };
  }
  if ((m = s.match(/^npm:((?:@[\w.-]+\/)?[\w.-]+)(?:@([\w.^~<>=*-]+))?$/))) return { kind: 'npm', pkg: m[2] ? `${m[1]}@${m[2]}` : m[1], from: s };
  if (/^(git@|ssh:\/\/|git\+https:\/\/)/.test(s) || /^(https|file):\/\/\S+\.git(\/[\w./-]*)?(#[\w./-]+)?$/.test(s)) {
    const [whole, ref = null] = s.replace(/^git\+/, '').split('#');
    // A folder in the repo goes after its .git: https://host/team/tools.git/plugins/deploys
    const at = whole.search(/\.git(\/|$)/);
    const url = at > -1 ? whole.slice(0, at + 4) : whole;
    const sub = at > -1 ? whole.slice(at + 4).replace(/^\/+|\/+$/g, '') : '';
    if (sub.split('/').includes('..')) throw new Error('that folder is outside the repo');
    return { kind: 'git', url, sub, ref, from: s };
  }
  if (/^http:\/\//.test(s)) throw new Error('not over plain http');
  if (/^https:\/\//.test(s)) throw new Error('for a git repo, give the URL ending in .git (or github:owner/repo)');
  if (NAME.test(s)) {
    const c = catalogEntry(s, bundled);
    if (c) return { ...parseSpec(c.from, { bundled }), catalog: c.name };
    const dir = bundledDir(s, bundled);
    if (dir) return { kind: 'bundled', dir, from: s };
  }
  if (/^[./~]/.test(s)) return { kind: 'folder', dir: resolve(s.replace(/^~(?=\/|$)/, homedir())), from: s };
  throw new Error(`no plugin called "${s}" ships with Clearsky; give github:owner/repo, a git URL, npm:package or a folder`);
}

// The same plugin at another version: same repo and folder (or npm package), whatever the ref.
export function sourceKey(from, opts) {
  const s = typeof from === 'string' ? parseSpec(from, opts) : from;
  if (s.kind === 'git') return `git ${s.url.replace(/\.git$/, '').toLowerCase()} ${s.sub}`;
  if (s.kind === 'npm') return `npm ${s.pkg.replace(/(.)@[^@/]*$/, '$1')}`;
  return `${s.kind} ${s.dir}`;
}
// The same source at `ref` (a tag, branch or commit; empty follows the default branch).
export function withRef(from, ref) {
  const s = String(from).trim();
  if (/^npm:/.test(s)) return `${s.replace(/^(npm:(?:@[\w.-]+\/)?[\w.-]+)(?:@.*)?$/, '$1')}${ref ? `@${ref}` : ''}`;
  if (!/^(github|gitlab|codeberg):|^(git@|ssh:\/\/|git\+https:\/\/|https:\/\/|file:\/\/)/.test(s)) throw new Error('only a git or npm plugin has versions to pick from');
  if (ref && !/^[\w./-]+$/.test(ref)) throw new Error(`"${ref}" isn't a tag, branch or commit`);
  return `${s.split('#')[0]}${ref ? `#${ref}` : ''}`;
}
// How a source is pinned, from its ref alone: a commit, a ref (tag or branch), or nothing
// (the repo's default branch, or npm's latest).
export function pinOf(spec) {
  if (spec.kind === 'git') return !spec.ref ? 'default' : /^[0-9a-f]{40}$/.test(spec.ref) ? 'commit' : 'ref';
  if (spec.kind === 'npm') { const v = spec.pkg.match(/.@([^@/]+)$/)?.[1]; return !v ? 'default' : /^\d+\.\d+\.\d+(-[\w.]+)?$/.test(v) ? 'version' : 'range'; }
  return 'local';
}

// A private repo on GitHub works with your gh login: git asks gh for it (`gh auth
// git-credential`), only for github.com and only while fetching. Nothing is stored, and
// there's no token to give. Without gh, git uses whatever login you gave git.
let ghFound;
export function ghCredential(url, { has = () => (ghFound ??= onPath('gh')) } = {}) {
  return /^https:\/\/github\.com\//i.test(url) && has() ? ['-c', 'credential.https://github.com.helper=!gh auth git-credential'] : [];
}
function onPath(cmd) {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  return String(process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':').some((d) => d && exts.some((e) => existsSync(join(d, cmd + e))));
}

const git = (args, opts = {}) => execFileP('git', args, { timeout: 120_000, ...opts, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
const tail = (e) => String(e.stderr || e.message).trim().split('\n').pop();

// Fetch the plugin into `into` (a fresh folder) and return the folder holding its manifest.
// Nothing of the plugin runs: git hooks don't come with a clone, and npm's scripts are off.
export async function fetchPlugin(spec, into, { run = execFileP } = {}) {
  if (spec.kind === 'bundled') return { dir: spec.dir };
  if (spec.kind === 'folder') {
    if (!existsSync(join(spec.dir, MANIFEST))) throw new Error(`there's no ${MANIFEST} in ${spec.dir}`);
    const dir = join(into, 'plugin');
    cpSync(spec.dir, dir, { recursive: true, filter: (p) => !/(^|[\\/])(\.git|node_modules)$/.test(p) });
    return { dir };
  }
  if (spec.kind === 'git') {
    const repo = join(into, 'repo');
    try {
      await git(['init', '-q', repo]);
      await git(['-C', repo, 'remote', 'add', 'origin', spec.url]);
      await git([...ghCredential(spec.url), '-C', repo, 'fetch', '-q', '--depth', '1', 'origin', spec.ref || 'HEAD']);
      await git(['-C', repo, '-c', 'advice.detachedHead=false', 'checkout', '-q', 'FETCH_HEAD']);
    } catch (e) { throw new Error(`git couldn't fetch ${spec.url}${spec.ref ? ` at ${spec.ref}` : ''}: ${tail(e)}`); }
    const commit = (await git(['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim();
    rmSync(join(repo, '.git'), { recursive: true, force: true });
    const dir = spec.sub ? join(repo, ...spec.sub.split('/')) : repo;
    if (relative(repo, dir).split(sep).includes('..')) throw new Error('that folder is outside the repo');
    return { dir, commit };
  }
  if (spec.kind === 'npm') {
    let out;
    try { out = await run('npm', ['pack', '--ignore-scripts', '--silent', '--pack-destination', into, spec.pkg], { timeout: 120_000, cwd: into }); }
    catch (e) { throw new Error(`npm couldn't fetch ${spec.pkg}: ${tail(e)}`); }
    const tgz = String(out.stdout).trim().split('\n').pop();
    try { await run('tar', ['-xzf', join(into, tgz), '-C', into], { timeout: 60_000 }); }
    catch (e) { throw new Error(`couldn't unpack ${tgz}: ${tail(e)}`); }
    let version = null;
    try { version = JSON.parse(readFileSync(join(into, 'package', 'package.json'), 'utf8')).version; } catch {}
    return { dir: join(into, 'package'), npmVersion: version };
  }
  throw new Error(`can't fetch a ${spec.kind}`);
}

// ---------------------------------------------------------------- pinning

// One hash over every file's path and bytes, so a change to any of them shows.
export function treeHash(dir) {
  const h = createHash('sha256');
  const walk = (d) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n), st = lstatSync(p);
      if (st.isSymbolicLink()) throw new Error(`${relative(dir, p)} is a symbolic link; plugins can't have those`);
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) { h.update(`${relative(dir, p).split(sep).join('/')}\0`); h.update(readFileSync(p)); h.update('\0'); }
    }
  };
  walk(dir);
  return `sha256-${h.digest('hex')}`;
}

// ---------------------------------------------------------------- the list of what you added

export function readRegistry(file) {
  try { const r = JSON.parse(readFileSync(file, 'utf8')); return r && typeof r.plugins === 'object' ? r : { plugins: {} }; } catch { return { plugins: {} }; }
}
function writeRegistry(file, reg) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(reg, null, 2)}\n`, { mode: 0o600 });
}

// What adding it would do, without doing it: fetch, read the manifest, and say what it reaches.
// `done()` installs what was fetched; `discard()` throws it away.
export async function preparePlugin(from, { paths = pluginPaths(), bundled = BUNDLED, run } = {}) {
  const spec = parseSpec(from, { bundled });
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  const stage = mkdtempSync(join(paths.root, '.adding-'));
  const discard = () => rmSync(stage, { recursive: true, force: true });
  try {
    const got = await fetchPlugin(spec, stage, { run });
    const manifest = readManifest(got.dir);
    const reg = readRegistry(paths.registry);
    const had = reg.plugins[manifest.name];
    // Another version of the same plugin (another tag of its repo) replaces it; a different
    // plugin with the same name doesn't.
    // A plugin added from its folder here moves to its own repo when you add it by name again.
    const listed = had?.kind === 'bundled' && catalogEntry(manifest.name, bundled);
    const moving = !!listed && sameSource(listed.from, spec, bundled);
    if (had && had.from !== from && !moving && !(had.kind === 'bundled' && spec.kind === 'bundled') && !sameSource(had.from, spec, bundled)) {
      throw new Error(`a plugin called "${manifest.name}" is already added (from ${had.from}); remove it first`);
    }
    let changes = null, warning = null;
    if (had) {
      let before = null;
      try { before = readManifest(had.kind === 'bundled' ? bundledDir(manifest.name, bundled) : codeDir(paths.root, manifest.name)); } catch { /* gone: all of it is new */ }
      changes = reachChanges(before, manifest);
      // A tag is meant to stay put. If it now gives other code than you added, say so.
      if (had.from === from && pinOf(spec) === 'ref' && had.commit && got.commit && had.commit !== got.commit) {
        const tags = await remoteRefs(spec.url).then((r) => r.tags, () => ({}));
        if (tags[spec.ref]) warning = `the tag ${spec.ref} now points to other code (${got.commit.slice(0, 10)}) than when you added it (${had.commit.slice(0, 10)}). Tags shouldn't move; ask whoever publishes it why.`;
      }
    }
    return { spec, manifest, got, had, changes, warning, discard, done: (opts) => installPrepared({ spec, manifest, got, paths, stage }, opts) };
  } catch (e) { discard(); throw e; }
}

function installPrepared({ spec, manifest, got, paths, stage }, { trust = false } = {}) {
  try {
    if (manifest.outside && !trust && spec.kind !== 'bundled') {
      throw new Error(`${manifest.label} runs outside the sandbox (${manifest.outside}). Add it with --trust, or tick "Run it outside the sandbox" in Settings, if you trust its code.`);
    }
    const reg = readRegistry(paths.registry);
    // Only one that can't work in the sandbox runs inside; trusting the others changes nothing.
    const entry = { from: spec.from, kind: spec.kind, version: manifest.version, at: new Date().toISOString(),
      run: spec.kind === 'bundled' || manifest.outside ? 'inside' : 'sandbox', pin: pinOf(spec) };
    if (spec.kind !== 'bundled') {
      const to = codeDir(paths.root, manifest.name);
      rmSync(to, { recursive: true, force: true });
      mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
      renameSync(got.dir, to);
      mkdirSync(dataDir(paths.root, manifest.name), { recursive: true, mode: 0o700 });
      Object.assign(entry, { hash: treeHash(to), ...(got.commit && { commit: got.commit }), ...(got.npmVersion && { npmVersion: got.npmVersion }) });
    }
    reg.plugins[manifest.name] = entry;
    writeRegistry(paths.registry, reg);
    return { name: manifest.name, ...entry };
  } finally { rmSync(stage, { recursive: true, force: true }); }
}

export async function addPlugin(from, { trust = false, ...opts } = {}) {
  const p = await preparePlugin(from, opts);
  return { manifest: p.manifest, ...p.done({ trust }) };
}

// Remove it, and with `data`, what it kept too.
export function removePlugin(name, { paths = pluginPaths(), data = false } = {}) {
  const reg = readRegistry(paths.registry);
  if (!reg.plugins[name]) throw new Error(`no plugin called "${name}" is added`);
  delete reg.plugins[name];
  writeRegistry(paths.registry, reg);
  rmSync(codeDir(paths.root, name), { recursive: true, force: true });
  if (data) rmSync(join(paths.root, name), { recursive: true, force: true });
  return { name };
}

// Fetch it again from where it came from (a new commit on its branch, a new npm version), or
// at another version with `to` (a tag, branch or commit; '' follows the default branch).
// Pinned to a tag or commit, it stays there until you pick another. If the new code reaches
// more than the old (hosts, programs, files, settings, doors), it's not taken unless `accept`:
// what's added is what you saw. Trust (outside the sandbox) is kept, never widened.
export async function updatePlugin(name, { paths = pluginPaths(), to, accept = false, ...opts } = {}) {
  const had = readRegistry(paths.registry).plugins[name];
  if (!had) throw new Error(`no plugin called "${name}" is added`);
  if (retiredText(name, opts.bundled)) throw new Error(retiredText(name, opts.bundled));
  if (had.kind === 'bundled') {
    const c = catalogEntry(name, opts.bundled);
    throw new Error(c ? `${name} has a repo of its own now: \`clearsky add ${c.aka[0] || c.name}\` moves it there (${c.from})` : `${name} ships with Clearsky; it's updated with Clearsky`);
  }
  const from = to === undefined ? had.from : withRef(had.from, to);
  const p = await preparePlugin(from, { paths, ...opts });
  if (p.manifest.name !== name) { p.discard(); throw new Error(`${from} is now a plugin called "${p.manifest.name}", not ${name}`); }
  if (p.changes?.wider && !accept) { p.discard(); throw new Error(`${name}: the new version ${changesText(p.changes)}. Look at it first (Settings → Plugins, or \`clearsky update ${name}\` in a terminal).`); }
  const r = p.done({ trust: had.run === 'inside' });
  return { manifest: p.manifest, ...r, warning: p.warning, before: { version: had.version, commit: had.commit, from: had.from } };
}

// ---------------------------------------------------------------- versions and changes

function sameSource(a, b, bundled) {
  try { return sourceKey(a, { bundled }) === sourceKey(b, { bundled }); } catch { return false; }
}

// What the new manifest reaches that the old one didn't. `wider` if anything.
export function reachChanges(before, after) {
  const was = before || { hosts: [], clis: [], files: [], settings: {}, doors: [] };
  const more = (a = [], b = []) => b.filter((x) => !a.includes(x));
  const c = {
    hosts: more(was.hosts, after.hosts), clis: more(was.clis, after.clis), files: more(was.files, after.files),
    settings: more(Object.keys(was.settings || {}), Object.keys(after.settings || {})),
    doors: more((was.doors || []).map((d) => d.name), (after.doors || []).map((d) => d.name)),
    outside: !was.outside && after.outside ? after.outside : null,
  };
  c.wider = !!(c.hosts.length || c.clis.length || c.files.length || c.doors.length || c.outside || (c.settings.length && after.settings && c.settings.some((k) => after.settings[k]?.secret)));
  return c;
}
export function changesText(c) {
  const parts = [c.hosts.length && `reaches ${c.hosts.join(', ')}`, c.clis.length && `runs ${c.clis.join(', ')}`, c.files.length && `keeps ${c.files.join(', ')}`,
    c.doors.length && `gives chats ${c.doors.join(', ')}`, c.settings.length && `has new settings ${c.settings.join(', ')}`, c.outside && `wants to run outside the sandbox (${c.outside})`].filter(Boolean);
  return parts.length ? `also ${parts.join('; ')}` : 'reaches nothing new';
}

// v1.2.3, 1.2.3 or v1.2 as numbers to compare; null for a tag that isn't a version.
export function versionOf(tag) {
  const m = String(tag).match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/);
  return m ? [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)] : null;
}
const newerFirst = (a, b) => b.v[0] - a.v[0] || b.v[1] - a.v[1] || b.v[2] - a.v[2];

// A git repo's tags, branches and default branch, without fetching any code.
export async function remoteRefs(url, { run = git } = {}) {
  let out;
  try { out = (await run([...ghCredential(url), 'ls-remote', '--symref', url, 'HEAD', 'refs/tags/*', 'refs/heads/*'], { timeout: 30_000 })).stdout; }
  catch (e) { throw new Error(`git couldn't reach ${url}: ${tail(e)}`); }
  const tags = {}, heads = {};
  let head = null, defaultBranch = null;
  for (const line of String(out).split('\n')) {
    let m;
    if ((m = line.match(/^ref: refs\/heads\/(\S+)\s+HEAD$/))) defaultBranch = m[1];
    else if ((m = line.match(/^([0-9a-f]{40})\s+(\S+)$/))) {
      const [, sha, ref] = m;
      if (ref === 'HEAD') head = sha;
      else if (ref.startsWith('refs/heads/')) heads[ref.slice(11)] = sha;
      else if (ref.startsWith('refs/tags/')) {
        // An annotated tag shows twice; the ^{} line is the commit it's on.
        const t = ref.slice(10);
        if (t.endsWith('^{}')) tags[t.slice(0, -3)] = sha;
        else tags[t] ??= sha;
      }
    }
  }
  return { tags, heads, head, defaultBranch };
}

// Is there something newer for an added plugin? Looks without fetching any code: version tags
// newer than the one it's on, and for one that follows a branch, whether the branch moved.
export async function checkPlugin(name, { paths = pluginPaths(), bundled = BUNDLED, refs = remoteRefs, run = execFileP } = {}) {
  const had = readRegistry(paths.registry).plugins[name];
  if (!had) throw new Error(`no plugin called "${name}" is added`);
  const spec = parseSpec(had.from, { bundled });
  const base = { name, from: had.from, version: had.version, commit: had.commit || null, ref: spec.ref || null };
  if (spec.kind === 'git') {
    const r = await refs(spec.url);
    const tagged = Object.entries(r.tags).map(([tag, sha]) => ({ tag, sha, v: versionOf(tag) })).filter((t) => t.v).sort(newerFirst);
    const isTag = spec.ref && r.tags[spec.ref], isBranch = spec.ref && r.heads[spec.ref];
    const pin = !spec.ref ? 'default' : /^[0-9a-f]{40}$/.test(spec.ref) ? 'commit' : isTag ? 'tag' : isBranch ? 'branch' : 'gone';
    // The version it's on: its tag, or a tag on its commit.
    const on = (isTag && versionOf(spec.ref)) || tagged.find((t) => t.sha === had.commit)?.v || null;
    const newer = tagged.filter((t) => (on ? newerFirst(t, { v: on }) < 0 : pin === 'commit' || pin === 'tag')).slice(0, 5)
      .map((t) => ({ tag: t.tag, from: withRef(had.from, t.tag) }));
    const latest = pin === 'default' ? r.head : pin === 'branch' ? r.heads[spec.ref] : pin === 'tag' ? r.tags[spec.ref] : had.commit;
    return { ...base, pin, branch: pin === 'default' ? r.defaultBranch : pin === 'branch' ? spec.ref : null, latest: latest || null,
      // A branch that moved has new code; a tag that moved shouldn't have.
      behind: (pin === 'default' || pin === 'branch') && !!latest && latest !== had.commit,
      moved: pin === 'tag' && !!latest && !!had.commit && latest !== had.commit,
      newer, latestTag: tagged[0]?.tag || null, ...(pin === 'gone' && { problem: `${spec.ref} isn't a tag or branch there any more` }) };
  }
  if (spec.kind === 'npm') {
    const pkg = spec.pkg.replace(/(.)@[^@/]*$/, '$1');
    let latest = null;
    try { latest = JSON.parse((await run('npm', ['view', pkg, 'version', '--json'], { timeout: 30_000 })).stdout); } catch (e) { throw new Error(`npm couldn't look up ${pkg}: ${tail(e)}`); }
    const pin = pinOf(spec), mine = had.npmVersion || had.version;
    const isNewer = versionOf(latest) && versionOf(mine) && newerFirst({ v: versionOf(latest) }, { v: versionOf(mine) }) < 0;
    return { ...base, pin, latest, behind: pin !== 'version' && !!isNewer, moved: false,
      newer: pin === 'version' && isNewer ? [{ tag: latest, from: withRef(had.from, latest) }] : [], latestTag: latest };
  }
  return { ...base, pin: 'local', behind: false, moved: false, newer: [], latestTag: null };
}

// What's added and what ships with Clearsky, for `clearsky plugins` and Settings.
export function listPlugins({ paths = pluginPaths(), bundled = BUNDLED } = {}) {
  const reg = readRegistry(paths.registry);
  const added = Object.entries(reg.plugins).map(([name, e]) => {
    let manifest = null, problem = null;
    try { manifest = readManifest(e.kind === 'bundled' ? bundledDir(name, bundled) || join(bundled, name) : codeDir(paths.root, name)); } catch (err) { problem = movedText(name, bundled) || err.message; }
    return { name, ...e, label: manifest?.label || name, description: manifest?.description || '', manifest, problem: problem || retiredText(name, bundled) };
  });
  // The catalog's plugins (from their repos, pinned), then any other folder in plugins/.
  const local = (name) => { try { const d = bundledDir(name, bundled); return d ? readManifest(d) : null; } catch { return null; } };
  const catalog = readCatalog(bundled).filter((c) => !reg.plugins[c.name]).map((c) => {
    const m = local(c.name);
    return { name: c.name, label: m?.label || c.name, description: m?.description || '', manifest: m, kind: 'catalog', from: c.from };
  });
  const inCatalog = new Set(readCatalog(bundled).flatMap((c) => [c.name, c.folder]));
  const shipped = existsSync(bundled) ? readdirSync(bundled).filter((n) => !inCatalog.has(n) && existsSync(join(bundled, n, MANIFEST))).sort()
    .map((n) => { try { const m = readManifest(join(bundled, n)); return inCatalog.has(m.name) || reg.plugins[m.name] ? null : { name: m.name, label: m.label, description: m.description, manifest: m, kind: 'bundled', from: m.name }; } catch { return null; } })
    .filter(Boolean) : [];
  return { added, available: [...catalog, ...shipped] };
}

// A plugin added from its folder here whose folder is gone: it lives in its own repo now.
function movedText(name, bundled) {
  const gone = retiredText(name, bundled);
  if (gone) return gone;
  const c = catalogEntry(name, bundled);
  return c && !bundledDir(name, bundled) ? `${name} lives in its own repo now: add it again (Settings → Plugins, or \`clearsky add ${c.aka[0] || c.name}\`) to take it from ${c.from}` : null;
}

// When one of Clearsky's own sources becomes a plugin (School, Slack): at the first start after
// that, it's added for you if you had its settings filled in, so nothing you had disappears.
// Each bundled plugin is offered once; after that, what you added or removed stays.
export function migrateBundled(env, { paths = pluginPaths(), bundled = BUNDLED } = {}) {
  if (!existsSync(bundled)) return [];
  const existed = existsSync(paths.registry);
  const reg = readRegistry(paths.registry);
  // Lists written before `offered` existed had only School to offer.
  const offered = new Set(reg.offered || (existed ? ['flyt', ...Object.keys(reg.plugins)] : []));
  const added = [];
  let changed = !existed;
  for (const n of readdirSync(bundled).sort()) {
    let m;
    try { m = readManifest(join(bundled, n)); } catch { continue; }
    if (offered.has(m.name)) continue;
    offered.add(m.name);
    changed = true;
    if (reg.plugins[n] || !m.enabledWhen.length || !m.enabledWhen.every((k) => env[k])) continue;
    reg.plugins[m.name] = { from: m.name, kind: 'bundled', version: m.version, at: new Date().toISOString(), run: 'inside', migrated: true };
    added.push(m.name);
  }
  if (changed) writeRegistry(paths.registry, { ...reg, offered: [...offered].sort() });
  return added;
}

// ---------------------------------------------------------------- loading

// The source each added plugin gives, ready for Clearsky: inside ones imported here, sandboxed
// ones as a stand-in whose hooks run in the plugin's own sandbox (makeSandboxed).
export async function loadPlugins({ paths = pluginPaths(), bundled = BUNDLED, makeSandboxed } = {}) {
  const sources = new Map(), errors = [];
  for (const [name, e] of Object.entries(readRegistry(paths.registry).plugins)) {
    try {
      const dir = e.kind === 'bundled' ? bundledDir(name, bundled) : codeDir(paths.root, name);
      if (!dir || !existsSync(dir)) throw new Error(movedText(name, bundled) || `${name}: its files are gone; add it again`);
      const m = readManifest(dir);
      if (m.name !== name) throw new Error(`${name}: its manifest now calls it "${m.name}"; add it again`);
      if (e.kind !== 'bundled' && treeHash(dir) !== e.hash) throw new Error(`${name}: its files changed since you added it, so it isn't loaded. Run \`clearsky update ${name}\` or add it again.`);
      const s = await sourceFromDir(dir, { run: e.run, makeSandboxed, manifest: m });
      sources.set(name, { ...s, plugin: { from: e.from, kind: e.kind, run: e.run, version: m.version, commit: e.commit || null, dir } });
    } catch (err) { errors.push(err.message); }
  }
  return { sources, errors };
}

// The source in a plugin folder: imported here when it runs inside, else a stand-in from
// `makeSandboxed` (lib/plugin-sandbox.mjs) and no code of it is loaded.
export async function sourceFromDir(dir, { run = 'inside', makeSandboxed, manifest = readManifest(dir) } = {}) {
  const meta = fromManifest(manifest, { dir });
  const file = join(dir, manifest.entry);
  if (run === 'inside') {
    const mod = await import(pathToFileURL(file).href);
    return { ...checkSource({ default: { ...withApi(mod.default), ...meta } }, file), file };
  }
  if (!makeSandboxed) throw new Error(`${manifest.name}: runs in a sandbox, and there's none here`);
  return { ...checkSource({ default: { ...makeSandboxed(meta), ...meta } }, file), file };
}

// A plugin's module may export its hooks, or a function that gets what Clearsky lends plugins
// that run inside (a browser to log in with) and returns them.
function withApi(def) {
  return typeof def === 'function' ? def(PLUGIN_LENDS) : def;
}
export const PLUGIN_LENDS = {
  api: PLUGIN_API,
  findBrowser,
  // A login in a browser window of Clearsky's own, giving back the cookie `pick` finds.
  cookieLogin: (...a) => import('./browser-login.mjs').then((b) => b.cookieLogin(...a)),
  // A page in your default browser, as the desktop opens links (an OAuth login's authorize page).
  openUrl,
  // Remote MCP servers: OAuth with PKCE and a localhost callback, and a Streamable HTTP client.
  mcpOAuth,
  mcpClient,
};
export function openUrl(u, { platform = process.platform, run = spawn } = {}) {
  if (!/^https?:\/\//.test(String(u))) throw new Error('only http(s) pages open in the browser');
  // Windows' start would read & as a command separator; rundll32 takes the URL as it is.
  const [cmd, ...pre] = platform === 'darwin' ? ['open'] : platform === 'win32' ? ['rundll32', 'url.dll,FileProtocolHandler'] : ['xdg-open'];
  run(cmd, [...pre, String(u)], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

// The parts of a source that come from its manifest, which win over the code: what it
// reaches and holds is what you were shown.
function fromManifest(m, { dir }) {
  return {
    name: m.name, label: m.label, area: m.area, settings: m.settings,
    ...(m.panel && { panel: m.panel }),
    ...(m.enabledWhen.length && { enabled: (env) => m.enabledWhen.every((k) => !!env[k]) }),
    manifest: { secrets: m.secrets, hosts: m.hosts, clis: m.clis, files: m.files, doors: m.doors, ...(m.note && { note: m.note }) },
    pluginManifest: m, pluginDir: dir,
  };
}
