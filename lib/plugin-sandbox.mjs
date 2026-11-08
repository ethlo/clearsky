// An installed plugin's own sandbox: each fetch (and each read of an item or file) is a new
// process under srt with the plugin's rules only, apart from Copilot's sandbox and its proxy:
//
// - network: only the hosts in its manifest (srt's proxy; none listed means no network)
// - reading: its own code, its data folder and the run folder, and system files outside your
//   home; nothing else in your home (so not your code, ~/.ssh or ~/.config/clearsky)
// - writing: its data folder and the run folder
// - environment: nothing of Clearsky's; its own settings come in the request file
//
// Clearsky never imports a sandboxed plugin's code. The hooks that turn its data into rows,
// reminders, events and stand-up lines run in the sandbox too, right after fetch(), and come
// back with the data (as data.__hooks, so they survive Clearsky's cache and a restart).

import { writeFileSync, readFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SECRETS } from './sandbox.mjs';
import { dataDir as dataDirOf } from './plugins.mjs';

export const HOST = fileURLToPath(new URL('./plugin-host.mjs', import.meta.url));
const expand = (p, home) => resolve(p.replace(/^~(?=\/|$)/, home));

// srt's settings for one run of a plugin.
export function pluginSrtSettings({ code, data, run, hosts = [], home = homedir(), node = process.execPath, platform = process.platform, uid = process.getuid?.() }) {
  const nodeHome = dirname(dirname(node)); // e.g. ~/.nvm/versions/node/v22…: Node itself, if it lives in your home
  return {
    // Linux: as for Copilot (lib/sandbox.mjs), srt's socket filter can't run under Ubuntu's
    // AppArmor rules; the sandbox has its own network namespace, and /run/user is hidden.
    network: { allowedDomains: [...new Set(hosts)], deniedDomains: [], ...(platform === 'linux' && { allowAllUnixSockets: true }) },
    filesystem: {
      denyRead: [home, ...SECRETS.map((p) => expand(p, home)), ...(platform === 'linux' && uid != null ? [`/run/user/${uid}`] : [])],
      allowRead: [code, data, run, dirname(HOST), ...(nodeHome.startsWith(home) ? [nodeHome] : [])],
      allowWrite: [data, run],
      denyWrite: [],
    },
  };
}

// srt's command line, from the package that ships with Clearsky; null if it isn't installed.
export function srtCli() {
  try {
    const index = fileURLToPath(import.meta.resolve('@anthropic-ai/sandbox-runtime'));
    const cli = join(dirname(index), 'cli.js');
    return existsSync(cli) ? cli : null;
  } catch { return null; }
}

// What the plugin's process starts with: no tokens, no settings, just enough to run.
export function cleanEnv(env = process.env) {
  // A proxy you go out through (and its certificate) is for srt's own proxy to use.
  const keep = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE'];
  // TMPDIR is srt's own (its sockets live there, and it gives the sandbox a /tmp of its own).
  return { ...Object.fromEntries([...keep, 'TMPDIR'].filter((k) => env[k]).map((k) => [k, env[k]])), NODE_USE_ENV_PROXY: '1' };
}

// Run one op of the plugin in its sandbox and return what plugin-host.mjs wrote.
// `wrap` builds the command (srt by default); tests pass one that runs it plain.
export async function runPlugin(meta, op, payload = {}, { root, wrap = srtWrap, timeout = 120_000, home = homedir() } = {}) {
  const data = dataDirOf(root, meta.name);
  mkdirSync(data, { recursive: true, mode: 0o700 });
  mkdirSync(join(root, meta.name, 'runs'), { recursive: true, mode: 0o700 });
  const run = mkdtempSync(join(root, meta.name, 'runs', `${op}-`));
  try {
    const m = meta.pluginManifest;
    writeFileSync(join(run, 'request.json'), JSON.stringify({ entry: join(meta.pluginDir, m.entry), op, hosts: m.hosts, clis: m.clis, dataDir: data, ...payload }), { mode: 0o600 });
    const settings = pluginSrtSettings({ code: meta.pluginDir, data, run, hosts: m.hosts, home });
    const { bin, args } = await wrap([process.execPath, HOST, run], settings, run);
    const err = await new Promise((done) => {
      const child = spawn(bin, args, { cwd: run, env: cleanEnv(process.env), stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (c) => { if (stderr.length < 4000) stderr += c; });
      const t = setTimeout(() => { child.kill('SIGKILL'); stderr = `took longer than ${Math.round(timeout / 1000)}s`; }, timeout);
      child.on('error', (e) => { clearTimeout(t); done(e.message); });
      child.on('exit', (code) => { clearTimeout(t); done(code ? stderr.trim().split('\n').pop() || `exited with ${code}` : null); });
    });
    let out;
    try { out = JSON.parse(readFileSync(join(run, 'result.json'), 'utf8')); } catch { throw new Error(`${meta.label}: its sandbox gave nothing back${err ? ` (${err})` : ''}`); }
    if (!out.ok) throw Object.assign(new Error(`${meta.label}: ${out.error}`), out.auth ? { auth: true } : {});
    return out;
  } finally { rmSync(run, { recursive: true, force: true }); }
}

export async function srtWrap(argv, settings, run) {
  const cli = srtCli();
  if (!cli) throw new Error('needs the sandbox (srt), which isn\'t installed; `clearsky doctor` says how');
  writeFileSync(join(run, 'srt.json'), JSON.stringify(settings), { mode: 0o600 });
  // '--': the command's own options aren't srt's.
  return { bin: process.execPath, args: [cli, '-s', join(run, 'srt.json'), '--', ...argv] };
}

// The stand-in source for a sandboxed plugin (see loadPlugins in lib/plugins.mjs).
export function sandboxedSource({ root, wrap, standupSince = () => null } = {}) {
  return (meta) => {
    const h = (data) => data?.__hooks || {};
    // Only the data the plugin itself returned goes back in; never what Clearsky added to it.
    const own = (data) => { const { __hooks, items, ...rest } = data || {}; return { ...rest, ...(h(data).rawItems !== undefined && { items: h(data).rawItems }) }; };
    return {
      sandboxed: true,
      async fetch(ctx) {
        const since = standupSince();
        const r = await runPlugin(meta, 'collect', { env: ctx.env, standupSince: since && new Date(since).toISOString() }, { root, wrap });
        const data = r.data && typeof r.data === 'object' && !Array.isArray(r.data) ? r.data : { value: r.data };
        return { ...data, __hooks: { ...r.hooks, rawItems: data.items } };
      },
      items: (data) => h(data).items ?? null,
      attention: (data) => h(data).attention ?? null,
      events: (data) => h(data).events ?? null,
      standup: (data) => h(data).standup ?? null,
      async detail(key, ctx, data) {
        if (!h(data).detail) throw new Error(`${meta.label} has no reader`);
        return (await runPlugin(meta, 'detail', { env: ctx.env, key, data: own(data) }, { root, wrap })).detail;
      },
      async attachment(key, id, ctx, data) {
        if (!h(data).attachment) throw new Error(`${meta.label} has no files`);
        const f = (await runPlugin(meta, 'attachment', { env: ctx.env, key, id, data: own(data) }, { root, wrap })).file;
        return f && { ...f, data: Buffer.from(f.data || '', 'base64') };
      },
    };
  };
}
