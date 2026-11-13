// A pull-through cache for Docker Hub, for the chats' VMs. Each VM's disk is thrown away when it
// stops, so every VM used to pull its test images (Testcontainers' databases, Ryuk …) again
// through the proxy. Docker in the VM now asks this cache first (`registry-mirrors`): image
// layers are kept in Clearsky's VM folder by their sha256 and checked against it, so a layer any
// VM pulled before comes from this machine's disk. Image lists by tag are asked of Docker Hub
// each time (a tag can move), and come from the cache only when Docker Hub can't be reached.
//
// Only reads (GET, HEAD) and only Docker Hub: pushes never come here. Docker Hub is reached
// through srt's proxy, like everything else, so its allow list still decides.

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect as tlsConnect, rootCertificates } from 'node:tls';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const REGISTRY = 'https://registry-1.docker.io';
const AUTH = 'https://auth.docker.io/token?service=registry.docker.io';
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const NAME = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/;
const KEEP_DAYS = 30;
// The cache's size cap (Settings → Copilot → Image cache, COPILOT_VM_IMAGE_CACHE_GB): layers used
// longest ago go first once it's over.
export const CACHE_GB_DEFAULT = 20;
export function cacheCapBytes(env = process.env) {
  const n = Number(String(env.COPILOT_VM_IMAGE_CACHE_GB ?? '').trim().replace(',', '.'));
  return Math.round((String(env.COPILOT_VM_IMAGE_CACHE_GB ?? '').trim() && Number.isFinite(n) && n > 0 ? n : CACHE_GB_DEFAULT) * 1024 ** 3);
}

// A request over srt's proxy: CONNECT with its login, then TLS (trusting its CA, which it signs
// Docker Hub's certificate with). Resolves with the response.
export function proxiedRequest(url, { method = 'GET', headers = {}, proxy }) {
  const u = new URL(url);
  const m = /^http:\/\/(?:([^:@]+):([^@]+)@)?$/.exec(proxy.url || '') || [];
  const auth = m[1] ? { 'Proxy-Authorization': `Basic ${Buffer.from(`${decodeURIComponent(m[1])}:${decodeURIComponent(m[2])}`).toString('base64')}` } : {};
  const port = u.port || 443;
  return new Promise((done, fail) => {
    const c = httpRequest({ host: '127.0.0.1', port: proxy.port, method: 'CONNECT', path: `${u.hostname}:${port}`, headers: { Host: `${u.hostname}:${port}`, ...auth } });
    c.setTimeout(30_000, () => c.destroy(new Error('the proxy took too long')));
    c.once('error', fail);
    c.once('connect', (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); fail(new Error(`the proxy answered ${res.statusCode} for ${u.hostname}`)); return; }
      const tls = tlsConnect({ socket, servername: u.hostname, ca: proxy.ca ? [...rootCertificates, proxy.ca] : undefined });
      const r = httpsRequest({ method, path: u.pathname + u.search, headers: { Host: u.host, ...headers }, createConnection: () => tls });
      r.setTimeout(120_000, () => r.destroy(new Error(`${u.hostname} took too long`)));
      r.once('response', done).once('error', fail).end();
    });
    c.end();
  });
}

const body = (res) => new Promise((done, fail) => { const parts = []; res.on('data', (d) => parts.push(d)).once('end', () => done(Buffer.concat(parts))).once('error', fail); });

// The cache's request handler. `request(url, { method, headers })` reaches the internet (tests
// pass their own).
export function registryMirror({ dir, request, log = () => {}, capBytes = () => cacheCapBytes() }) {
  const blobs = join(dir, 'blobs'), manifests = join(dir, 'manifests'), tmp = join(dir, 'tmp');
  for (const d of [blobs, manifests, tmp]) mkdirSync(d, { recursive: true });
  const tokens = new Map();
  // Layers served since the last look (`take()`), for the VM's log.
  let stats = { hit: 0, hitBytes: 0, miss: 0, missBytes: 0 };

  const token = async (name) => {
    const t = tokens.get(name);
    if (t && t.until > Date.now()) return t.token;
    const res = await request(`${AUTH}&scope=${encodeURIComponent(`repository:${name}:pull`)}`, {});
    const b = await body(res);
    if (res.statusCode !== 200) throw new Error(`Docker Hub's login answered ${res.statusCode}`);
    const j = JSON.parse(b);
    const value = j.token || j.access_token;
    tokens.set(name, { token: value, until: Date.now() + Math.max(30, (j.expires_in || 300) - 30) * 1000 });
    return value;
  };

  // Docker Hub, with a pull token, following its redirect to the CDN (without the token).
  const hub = async (path, name, { method = 'GET', accept } = {}) => {
    let url = `${REGISTRY}${path}`;
    let headers = { Authorization: `Bearer ${await token(name)}`, ...(accept && { Accept: accept }) };
    for (let i = 0; i < 5; i++) {
      const res = await request(url, { method, headers });
      if (![301, 302, 303, 307, 308].includes(res.statusCode) || !res.headers.location) return res;
      res.resume();
      url = new URL(res.headers.location, url).href;
      headers = {};
    }
    throw new Error('too many redirects');
  };

  const manifestFile = (name, ref) => join(manifests, createHash('sha256').update(`${name}@${ref}`).digest('hex'));
  const saveManifest = (name, ref, type, data) => {
    const f = manifestFile(name, ref), t = join(tmp, `${process.pid}-${Math.random().toString(36).slice(2)}`);
    writeFileSync(t, JSON.stringify({ name, ref, type, data: data.toString('base64') }));
    renameSync(t, f);
  };
  const cachedManifest = (name, ref) => { try { const j = JSON.parse(readFileSync(manifestFile(name, ref), 'utf8')); return { type: j.type, data: Buffer.from(j.data, 'base64') }; } catch { return null; } };
  const sendManifest = (req, res, m, digest) => {
    res.writeHead(200, { 'Content-Type': m.type, 'Content-Length': m.data.length, 'Docker-Content-Digest': digest, 'Docker-Distribution-API-Version': 'registry/2.0' });
    res.end(req.method === 'HEAD' ? undefined : m.data);
  };

  async function manifest(req, res, name, ref) {
    const pinned = DIGEST.test(ref);
    const have = pinned && cachedManifest(name, ref);
    if (have) { const now = new Date(); try { utimesSync(manifestFile(name, ref), now, now); } catch {} return sendManifest(req, res, have, ref); }
    let up;
    try {
      up = await hub(`/v2/${name}/manifests/${ref}`, name, { accept: req.headers.accept });
    } catch (e) {
      // Docker Hub out of reach: the last answer for this tag, if there is one.
      const old = cachedManifest(name, ref);
      if (old) { log(`registry cache: ${name}:${ref} from the cache (${e.message})`); return sendManifest(req, res, old, `sha256:${createHash('sha256').update(old.data).digest('hex')}`); }
      throw e;
    }
    const data = await body(up);
    if (up.statusCode !== 200) { res.writeHead(up.statusCode, { 'Content-Type': up.headers['content-type'] || 'application/json' }); res.end(data); return; }
    const digest = `sha256:${createHash('sha256').update(data).digest('hex')}`;
    if (pinned && digest !== ref) throw new Error(`${name}@${ref}: Docker Hub sent other content`);
    const m = { type: up.headers['content-type'] || 'application/vnd.docker.distribution.manifest.v2+json', data };
    saveManifest(name, digest, m.type, data);
    if (!pinned) saveManifest(name, ref, m.type, data);
    sendManifest(req, res, m, digest);
  }

  async function blob(req, res, name, digest) {
    const f = join(blobs, digest.slice(7));
    if (existsSync(f)) {
      const size = statSync(f).size, now = new Date();
      try { utimesSync(f, now, now); } catch {} // last used, for clearing out old layers
      const range = /^bytes=(\d+)-$/.exec(req.headers.range || '');
      const from = range ? Math.min(Number(range[1]), size) : 0;
      res.writeHead(range ? 206 : 200, { 'Content-Type': 'application/octet-stream', 'Content-Length': size - from, 'Docker-Content-Digest': digest,
        'Accept-Ranges': 'bytes', ...(range && { 'Content-Range': `bytes ${from}-${size - 1}/${size}` }) });
      if (req.method === 'HEAD') { res.end(); return; }
      stats.hit++; stats.hitBytes += size - from;
      createReadStream(f, { start: from }).pipe(res);
      return;
    }
    const up = await hub(`/v2/${name}/blobs/${digest}`, name, { method: req.method });
    if (up.statusCode !== 200 || req.method === 'HEAD') {
      res.writeHead(up.statusCode, { ...(up.headers['content-length'] && { 'Content-Length': up.headers['content-length'] }), 'Docker-Content-Digest': digest });
      up.pipe(res);
      return;
    }
    // To Docker and to the cache at once; kept only when its sha256 is the one asked for.
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', ...(up.headers['content-length'] && { 'Content-Length': up.headers['content-length'] }), 'Docker-Content-Digest': digest });
    const t = join(tmp, `${digest.slice(7)}-${process.pid}-${Math.random().toString(36).slice(2)}`);
    const out = createWriteStream(t), hash = createHash('sha256');
    let failed = false;
    up.on('data', (d) => hash.update(d));
    up.pipe(out);
    up.pipe(res);
    up.once('error', () => { failed = true; out.destroy(); res.destroy(); rmSync(t, { force: true }); });
    res.once('close', () => { if (!up.complete) { failed = true; up.destroy(); out.destroy(); rmSync(t, { force: true }); } });
    out.once('finish', () => {
      if (!failed && up.complete && `sha256:${hash.digest('hex')}` === digest) { renameSync(t, f); stats.miss++; stats.missBytes += out.bytesWritten; keepUnderCap(); }
      else rmSync(t, { force: true });
    });
  }

  // After a new layer, at most once a minute: over the cap, the layers used longest ago go.
  let lastTrim = 0;
  const keepUnderCap = () => {
    if (Date.now() - lastTrim < 60_000) return;
    lastTrim = Date.now();
    const r = pruneMirror(dir, { maxBytes: capBytes() });
    if (r.removed) log(`Image cache: removed ${r.removed} layers used longest ago (over the size cap)`);
  };

  const handle = async (req, res) => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
      const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (path === '/v2/' || path === '/v2') { res.writeHead(200, { 'Docker-Distribution-API-Version': 'registry/2.0', 'Content-Type': 'application/json' }); res.end('{}'); return; }
      let m = /^\/v2\/(.+)\/manifests\/([^/]+)$/.exec(path);
      if (m && NAME.test(m[1]) && /^[\w][\w.:-]{0,127}$/.test(m[2])) return await manifest(req, res, m[1], m[2]);
      m = /^\/v2\/(.+)\/blobs\/([^/]+)$/.exec(path);
      if (m && NAME.test(m[1]) && DIGEST.test(m[2])) return await blob(req, res, m[1], m[2]);
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{"errors":[{"code":"UNSUPPORTED"}]}');
    } catch (e) {
      log(`registry cache: ${e.message}`);
      if (!res.headersSent) { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ errors: [{ code: 'UNAVAILABLE', message: e.message }] })); } else res.destroy();
    }
  };
  handle.take = () => { const s = stats; stats = { hit: 0, hitBytes: 0, miss: 0, missBytes: 0 }; return s; };
  return handle;
}

// What's in the cache, for the VMs view: images (by name and tag), layers, and their size.
export function mirrorStats(dir) {
  const files = (sub) => { try { return readdirSync(join(dir, sub)).map((f) => { try { const st = statSync(join(dir, sub, f)); return { f, size: st.size, used: st.mtimeMs }; } catch { return null; } }).filter(Boolean); } catch { return []; } };
  const blobs = files('blobs'), manifests = files('manifests');
  const images = new Map();
  for (const m of manifests) {
    try {
      const j = JSON.parse(readFileSync(join(dir, 'manifests', m.f), 'utf8'));
      if (j.name && j.ref && !DIGEST.test(j.ref)) images.set(`${j.name.replace(/^library\//, '')}:${j.ref}`, m.used);
    } catch {}
  }
  const bytes = blobs.reduce((a, b) => a + b.size, 0) + manifests.reduce((a, b) => a + b.size, 0);
  return { images: images.size, layers: blobs.length, bytes, recent: [...images].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([name, used]) => ({ name, used: new Date(used).toISOString() })) };
}

// Clearing out: everything (`all`, the Purge button), what no VM used for a month, and then,
// over `maxBytes`, the layers used longest ago (each use touches a layer's time). Files being
// downloaded now are left alone.
export function pruneMirror(dir, { days = KEEP_DAYS, maxBytes = Infinity, all = false, now = Date.now() } = {}) {
  let removed = 0, freed = 0;
  const drop = (p, size) => { try { rmSync(p, { force: true }); removed++; freed += size; } catch {} };
  const list = (sub) => { try { return readdirSync(join(dir, sub)).map((f) => { const p = join(dir, sub, f); try { const st = statSync(p); return { p, size: st.size, used: st.mtimeMs }; } catch { return null; } }).filter(Boolean); } catch { return []; } };
  for (const t of list('tmp')) if (now - t.used > 864e5) drop(t.p, t.size);
  const left = [];
  for (const sub of ['blobs', 'manifests']) {
    for (const x of list(sub)) {
      if (all || now - x.used > days * 864e5) drop(x.p, x.size);
      else if (sub === 'blobs') left.push(x);
    }
  }
  let total = left.reduce((a, b) => a + b.size, 0);
  for (const x of left.sort((a, b) => a.used - b.used)) {
    if (total <= maxBytes) break;
    drop(x.p, x.size);
    total -= x.size;
  }
  return { removed, freed };
}
