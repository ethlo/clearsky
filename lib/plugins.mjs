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
//   clearsky add school                               (one that ships with Clearsky, in plugins/)
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
//     "enabledWhen": ["WEATHER_PLACE"],  // fetch only once these settings are filled in
//     "hosts": ["api.met.no"],           // all it may reach
//     "clis": [],                        // programs it may run
//     "secrets": [], "files": [],        // what it keeps, for Settings → Modules
//     "outside": "…"                     // only if it can't work in the sandbox: why (see below)
//   }
//
// Installed plugins run in a sandbox of their own (lib/plugin-sandbox.mjs): each fetch is a
// separate process under srt that reaches only the plugin's hosts, reads only its own code and
// writes only its own data folder, and gets only its own settings. Your code folders, your
// logins and Clearsky's settings file are out of its sight. A plugin that can't work like that
// (say it opens a browser for a login) says why in "outside"; it then runs inside Clearsky, and
// only if you said so when adding it (`--trust`, or the box in Settings). The plugins that
// ship with Clearsky (plugins/) are part of it and run inside.
//
// The code is pinned when it's added: its files are hashed, and a plugin whose files changed
// since then isn't loaded until you add or update it again. Git plugins record the commit.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, rmSync, cpSync, renameSync, mkdtempSync, lstatSync } from 'node:fs';
import { join, dirname, resolve, relative, sep } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
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
  }
  if (m.area && !['work', 'personal'].includes(m.area)) throw bad('area must be "work" or "personal"');
  if (m.panel && !['needs', 'track'].includes(m.panel.zone || 'track')) throw bad('panel.zone must be "needs" or "track"');
  const enabledWhen = list('enabledWhen', (x) => KEY.test(x));
  if (m.outside != null && (typeof m.outside !== 'string' || !m.outside.trim())) throw bad('outside must say, in words, why it needs to run outside the sandbox');
  return {
    name: m.name, label: String(m.label || m.name).slice(0, 60), version: String(m.version || '0.0.0').slice(0, 30),
    description: String(m.description || '').slice(0, 300), api: m.clearsky ?? PLUGIN_API, entry,
    area: m.area || 'personal', ...(m.panel && { panel: m.panel }), settings, enabledWhen,
    hosts: list('hosts', (x) => typeof x === 'string' && HOST.test(x)).map((h) => h.toLowerCase()),
    clis: list('clis', (x) => typeof x === 'string' && CLI.test(x)),
    secrets: list('secrets', (x) => x && typeof x === 'object'), files: list('files', (x) => typeof x === 'string'),
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

// ---------------------------------------------------------------- where a plugin comes from

// "github:owner/repo/sub#ref", a git URL, "npm:pkg@1.2", a folder, or a bundled plugin's name.
export function parseSpec(spec, { bundled = BUNDLED } = {}) {
  const s = String(spec || '').trim();
  if (!s) throw new Error('say which plugin: github:owner/repo, a git URL, npm:package or a folder');
  let m;
  if ((m = s.match(/^(github|gitlab|codeberg):([\w.-]+)\/([\w.-]+)((?:\/[\w.-]+)*)(?:#([\w./-]+))?$/))) {
    const host = { github: 'github.com', gitlab: 'gitlab.com', codeberg: 'codeberg.org' }[m[1]];
    return { kind: 'git', url: `https://${host}/${m[2]}/${m[3].replace(/\.git$/, '')}.git`, sub: m[4].slice(1), ref: m[5] || null, from: s };
  }
  if ((m = s.match(/^npm:((?:@[\w.-]+\/)?[\w.-]+)(?:@([\w.^~<>=*-]+))?$/))) return { kind: 'npm', pkg: m[2] ? `${m[1]}@${m[2]}` : m[1], from: s };
  if (/^(git@|ssh:\/\/|git\+https:\/\/)/.test(s) || /^https:\/\/\S+\.git(#[\w./-]+)?$/.test(s)) {
    const [url, ref = null] = s.replace(/^git\+/, '').split('#');
    return { kind: 'git', url, sub: '', ref, from: s };
  }
  if (/^http:\/\//.test(s)) throw new Error('not over plain http');
  if (/^https:\/\//.test(s)) throw new Error('for a git repo, give the URL ending in .git (or github:owner/repo)');
  if (NAME.test(s) && existsSync(join(bundled, s, MANIFEST))) return { kind: 'bundled', dir: join(bundled, s), from: s };
  if (/^[./~]/.test(s)) return { kind: 'folder', dir: resolve(s.replace(/^~(?=\/|$)/, homedir())), from: s };
  throw new Error(`no plugin called "${s}" ships with Clearsky; give github:owner/repo, a git URL, npm:package or a folder`);
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
      await git(['-C', repo, 'fetch', '-q', '--depth', '1', 'origin', spec.ref || 'HEAD']);
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
    if (had && had.from !== from && !(had.kind === 'bundled' && spec.kind === 'bundled')) {
      throw new Error(`a plugin called "${manifest.name}" is already added (from ${had.from}); remove it first`);
    }
    return { spec, manifest, got, had, discard, done: (opts) => installPrepared({ spec, manifest, got, paths, stage }, opts) };
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
      run: spec.kind === 'bundled' || manifest.outside ? 'inside' : 'sandbox' };
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

// Fetch it again from where it came from (a new commit, a new npm version), keeping how it runs.
export async function updatePlugin(name, { paths = pluginPaths(), ...opts } = {}) {
  const had = readRegistry(paths.registry).plugins[name];
  if (!had) throw new Error(`no plugin called "${name}" is added`);
  const r = await addPlugin(had.from, { paths, trust: had.run === 'inside', ...opts });
  return { ...r, before: { version: had.version, commit: had.commit } };
}

// What's added and what ships with Clearsky, for `clearsky plugins` and Settings.
export function listPlugins({ paths = pluginPaths(), bundled = BUNDLED } = {}) {
  const reg = readRegistry(paths.registry);
  const added = Object.entries(reg.plugins).map(([name, e]) => {
    let manifest = null, problem = null;
    try { manifest = readManifest(e.kind === 'bundled' ? join(bundled, name) : codeDir(paths.root, name)); } catch (err) { problem = err.message; }
    return { name, ...e, label: manifest?.label || name, description: manifest?.description || '', manifest, problem };
  });
  const shipped = existsSync(bundled) ? readdirSync(bundled).filter((n) => existsSync(join(bundled, n, MANIFEST))).sort()
    .filter((n) => !reg.plugins[n]).map((n) => { try { const m = readManifest(join(bundled, n)); return { name: n, label: m.label, description: m.description, manifest: m }; } catch { return null; } })
    .filter(Boolean) : [];
  return { added, available: shipped };
}

// The first start after Clearsky's own sources became plugins: a bundled plugin whose settings
// you had already filled in is added for you, so nothing you had disappears.
export function migrateBundled(env, { paths = pluginPaths(), bundled = BUNDLED } = {}) {
  if (existsSync(paths.registry) || !existsSync(bundled)) return [];
  const reg = { plugins: {} }, added = [];
  for (const n of readdirSync(bundled)) {
    let m;
    try { m = readManifest(join(bundled, n)); } catch { continue; }
    if (!m.enabledWhen.length || !m.enabledWhen.every((k) => env[k])) continue;
    reg.plugins[m.name] = { from: m.name, kind: 'bundled', version: m.version, at: new Date().toISOString(), run: 'inside', migrated: true };
    added.push(m.name);
  }
  writeRegistry(paths.registry, reg);
  return added;
}

// ---------------------------------------------------------------- loading

// The source each added plugin gives, ready for Clearsky: inside ones imported here, sandboxed
// ones as a stand-in whose hooks run in the plugin's own sandbox (makeSandboxed).
export async function loadPlugins({ paths = pluginPaths(), bundled = BUNDLED, makeSandboxed } = {}) {
  const sources = new Map(), errors = [];
  for (const [name, e] of Object.entries(readRegistry(paths.registry).plugins)) {
    try {
      const dir = e.kind === 'bundled' ? join(bundled, name) : codeDir(paths.root, name);
      if (!existsSync(dir)) throw new Error(`${name}: its files are gone; add it again`);
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
};

// The parts of a source that come from its manifest, which win over the code: what it
// reaches and holds is what you were shown.
function fromManifest(m, { dir }) {
  return {
    name: m.name, label: m.label, area: m.area, settings: m.settings,
    ...(m.panel && { panel: m.panel }),
    ...(m.enabledWhen.length && { enabled: (env) => m.enabledWhen.every((k) => !!env[k]) }),
    manifest: { secrets: m.secrets, hosts: m.hosts, clis: m.clis, files: m.files, ...(m.note && { note: m.note }) },
    pluginManifest: m, pluginDir: dir,
  };
}
