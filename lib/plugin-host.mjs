// Runs one hook of a plugin, inside the plugin's sandbox (lib/plugin-sandbox.mjs starts it).
// Self-contained on purpose: in the sandbox it can read only this file, the plugin's code and
// its run folder.
//
//   node plugin-host.mjs <run folder>
//
// The run folder has request.json:
//   { entry, op: 'collect' | 'detail' | 'attachment', env, hosts, clis, dataDir, standupSince, key, id, data }
// and gets result.json: { ok: true, ... } or { ok: false, error, auth }.

import { readFileSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const runDir = process.argv[2];
const req = JSON.parse(readFileSync(join(runDir, 'request.json'), 'utf8'));
const done = (out) => { writeFileSync(join(runDir, 'result.json'), JSON.stringify(out)); };

const allowed = (url) => {
  let h;
  try { h = new URL(url).hostname.toLowerCase(); } catch { return false; }
  return (req.hosts || []).some((p) => (p.startsWith('*.') ? h.endsWith(p.slice(1)) : h === p));
};
const guarded = (url, opts) => (allowed(url) ? fetch(url, opts) : Promise.reject(new Error(`${new URL(url).host} is not in its manifest`)));
const ctx = {
  env: req.env || {},
  dataDir: req.dataDir,
  fetch: guarded,
  async json(url, opts = {}) {
    const res = await guarded(url, opts);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  },
  async run(bin, args, { timeout = 30_000 } = {}) {
    if (!(req.clis || []).includes(basename(bin))) throw new Error(`${bin} is not in its manifest`);
    const { stdout } = await execFileP(bin, args, { timeout, maxBuffer: 20 * 1024 * 1024 });
    try { return JSON.parse(stdout); } catch { return stdout; }
  },
};

const safe = (fn, ...a) => {
  if (typeof fn !== 'function') return null;
  try { return fn(...a); } catch (e) { return { hookError: e.message }; }
};

try {
  let s = (await import(pathToFileURL(req.entry).href)).default;
  if (typeof s === 'function') s = s({ api: 1 });
  if (!s || typeof s.fetch !== 'function') throw new Error('its module needs a fetch(ctx) function');
  if (req.op === 'collect') {
    const data = await s.fetch(ctx);
    const since = req.standupSince ? new Date(req.standupSince) : new Date(Date.now() - 864e5);
    // Hooks are worked out here, from this data, so Clearsky never runs the plugin's code.
    done({ ok: true, data, hooks: { items: safe(s.items, data), attention: safe(s.attention, data), events: safe(s.events, data),
      standup: safe(s.standup, data, since), detail: typeof s.detail === 'function', attachment: typeof s.attachment === 'function' } });
  } else if (req.op === 'detail') {
    if (typeof s.detail !== 'function') throw new Error('it has no reader');
    done({ ok: true, detail: await s.detail(req.key, ctx, req.data) });
  } else if (req.op === 'attachment') {
    if (typeof s.attachment !== 'function') throw new Error('it has no files');
    const f = await s.attachment(req.key, req.id, ctx, req.data);
    done({ ok: true, file: f && { ...f, data: Buffer.from(f.data || '').toString('base64') } });
  } else throw new Error(`unknown op ${req.op}`);
} catch (e) {
  done({ ok: false, error: e?.message || String(e), auth: !!e?.auth });
}
