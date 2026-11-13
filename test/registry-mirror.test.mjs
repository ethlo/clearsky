import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, existsSync, writeFileSync, utimesSync, mkdirSync } from 'node:fs';
import { createServer as httpServer, request as httpRequest } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { connect as netConnect } from 'node:net';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registryMirror, proxiedRequest, pruneMirror, mirrorStats, cacheCapBytes } from '../lib/registry-mirror.mjs';
import { loginForwarder, dockerDaemon } from '../lib/vm.mjs';

const sha = (b) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
const reply = (statusCode, data = '', headers = {}) => Object.assign(Readable.from(data ? [Buffer.from(data)] : []), { statusCode, headers, complete: true });

// A Docker Hub stand-in: a token, one image (manifest by tag and by digest), its layer behind a
// redirect to the CDN, and a layer whose content doesn't match its digest.
function fakeHub() {
  const layer = 'layer-bytes'.repeat(1000), bad = 'not what was asked';
  const manifest = JSON.stringify({ schemaVersion: 2, layers: [{ digest: sha(layer) }] });
  const calls = [];
  const request = async (url, { method = 'GET', headers = {} }) => {
    calls.push(`${method} ${url}`);
    const u = new URL(url);
    if (u.host === 'auth.docker.io') return reply(200, JSON.stringify({ token: 'tok', expires_in: 300 }));
    if (u.host === 'cdn.example') return reply(200, method === 'HEAD' ? '' : layer, { 'content-length': String(layer.length) });
    assert.equal(headers.Authorization, 'Bearer tok');
    if (hub.down) throw new Error('offline');
    if (u.pathname === '/v2/library/pg/manifests/16' || u.pathname === `/v2/library/pg/manifests/${sha(manifest)}`) return reply(200, manifest, { 'content-type': 'application/vnd.oci.image.manifest.v1+json' });
    if (u.pathname === `/v2/library/pg/blobs/${sha(layer)}`) return reply(307, '', { location: 'https://cdn.example/x?sig=1' });
    if (u.pathname === `/v2/library/pg/blobs/${sha('good')}`) return reply(200, bad);
    return reply(404, '{"errors":[]}');
  };
  const hub = { request, calls, layer, manifest, down: false };
  return hub;
}

const get = (port, path, { method = 'GET', headers = {} } = {}) => new Promise((ok, fail) => {
  const r = httpRequest({ host: '127.0.0.1', port, path, method, headers, agent: false }, (res) => {
    const parts = []; res.on('data', (d) => parts.push(d)).on('end', () => ok({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts).toString() }));
  });
  r.on('error', (e) => fail(new Error(`${method} ${path}: ${e.message}`))).end();
});

test('Docker Hub layers are kept: a second pull comes from this machine, checked by its sha256', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mirror-')), hub = fakeHub();
  const mirror = registryMirror({ dir, request: hub.request });
  // Through the VM's proxy port, as Docker in the VM asks it; other requests still go to srt's proxy.
  const fwd = await loginForwarder({ url: 'http://', port: 1 }, { mirror });
  const port = fwd.address().port;

  assert.equal((await get(port, '/v2/')).status, 200);
  const m = await get(port, '/v2/library/pg/manifests/16', { headers: { Accept: 'application/vnd.oci.image.manifest.v1+json' } });
  assert.equal(m.status, 200);
  assert.equal(m.body, hub.manifest);
  assert.equal(m.headers['docker-content-digest'], sha(hub.manifest));
  assert.equal(m.headers['content-type'], 'application/vnd.oci.image.manifest.v1+json');

  const path = `/v2/library/pg/blobs/${sha(hub.layer)}`;
  const first = await get(port, path);
  assert.equal(first.body, hub.layer);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(readdirSync(join(dir, 'blobs')), [sha(hub.layer).slice(7)]);
  const before = hub.calls.length;
  const again = await get(port, path);
  assert.equal(again.body, hub.layer);
  assert.equal(hub.calls.length, before, 'the second pull never reached Docker Hub');
  const part = await get(port, path, { headers: { Range: 'bytes=5-' } });
  assert.equal(part.status, 206);
  assert.equal(part.body, hub.layer.slice(5));
  assert.deepEqual(mirror.take(), { hit: 2, hitBytes: hub.layer.length * 2 - 5, miss: 1, missBytes: hub.layer.length });

  // By digest: from the cache too. By tag with Docker Hub out of reach: the last answer.
  assert.equal((await get(port, `/v2/library/pg/manifests/${sha(hub.manifest)}`)).body, hub.manifest);
  hub.down = true;
  const offline = await get(port, '/v2/library/pg/manifests/16');
  assert.equal(offline.body, hub.manifest);
  assert.equal(offline.headers['docker-content-digest'], sha(hub.manifest));
  hub.down = false;

  // Content that isn't what its digest says is passed on (Docker refuses it) but never kept.
  await get(port, `/v2/library/pg/blobs/${sha('good')}`);
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(!existsSync(join(dir, 'blobs', sha('good').slice(7))));
  assert.deepEqual(readdirSync(join(dir, 'tmp')), []);

  // Only reads, only proper names.
  assert.equal((await get(port, '/v2/library/pg/blobs/uploads/', { method: 'POST' })).status, 405);
  assert.equal((await get(port, '/v2/../../etc/manifests/x')).status, 404);
  assert.equal((await get(port, '/v2/library/pg/manifests/nope')).status, 404);
  const st = mirrorStats(dir);
  assert.equal(st.images, 1);
  assert.equal(st.recent[0].name, 'pg:16');
  assert.equal(st.layers, 1);
  fwd.close();
});

test('Docker in the VM asks the image cache first, on the proxy\'s address, without going through the proxy', () => {
  const d = dockerDaemon('http://10.0.2.100:3128');
  assert.deepEqual(d['registry-mirrors'], ['http://10.0.2.100:3128']);
  assert.match(d.proxies['no-proxy'], /(^|,)10\.0\.2\.100(,|$)/);
  assert.equal(d.proxies['https-proxy'], 'http://10.0.2.100:3128');
});

test('the cache keeps under its size cap by dropping the layers used longest ago; Purge empties it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mirror-'));
  for (const d of ['blobs', 'manifests', 'tmp']) mkdirSync(join(dir, d), { recursive: true });
  const at = (days) => new Date(Date.now() - days * 864e5);
  const put = (sub, f, bytes, days, text) => { writeFileSync(join(dir, sub, f), text ?? 'x'.repeat(bytes)); utimesSync(join(dir, sub, f), at(days), at(days)); };
  put('blobs', 'month', 10, 40); put('blobs', 'old', 100, 5); put('blobs', 'mid', 100, 2); put('blobs', 'new', 100, 0);
  put('manifests', 'm1', 0, 1, JSON.stringify({ name: 'library/postgres', ref: '16', type: 't', data: '' }));
  put('manifests', 'm2', 0, 0, JSON.stringify({ name: 'testcontainers/ryuk', ref: '0.11.0', type: 't', data: '' }));
  put('manifests', 'm3', 0, 0, JSON.stringify({ name: 'library/postgres', ref: `sha256:${'a'.repeat(64)}`, type: 't', data: '' }));
  put('tmp', 'downloading', 5, 0);
  const s = mirrorStats(dir);
  assert.equal(s.images, 2);
  assert.equal(s.layers, 4);
  assert.deepEqual(s.recent.map((x) => x.name), ['ryuk:0.11.0'.replace(/^/, 'testcontainers/'), 'postgres:16']);
  // 30 days unused goes anyway; over 250 bytes, the oldest used goes next.
  const r = pruneMirror(dir, { maxBytes: 250 });
  assert.equal(r.removed, 2);
  assert.deepEqual(readdirSync(join(dir, 'blobs')).sort(), ['mid', 'new']);
  assert.equal(cacheCapBytes({}), 20 * 1024 ** 3);
  assert.equal(cacheCapBytes({ COPILOT_VM_IMAGE_CACHE_GB: '2,5' }), 2.5 * 1024 ** 3);
  // Purge: all of it, except a download running now.
  pruneMirror(dir, { all: true });
  assert.deepEqual(readdirSync(join(dir, 'blobs')), []);
  assert.deepEqual(readdirSync(join(dir, 'manifests')), []);
  assert.deepEqual(readdirSync(join(dir, 'tmp')), ['downloading']);
  assert.deepEqual(mirrorStats(dir), { images: 0, layers: 0, bytes: 0, recent: [] });
});

test('Docker Hub is reached through srt\'s proxy, with its login, trusting its CA', async (t) => {
  let pem;
  const dir = mkdtempSync(join(tmpdir(), 'mirror-tls-'));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'), '-days', '1',
      '-subj', '/CN=registry-1.docker.io', '-addext', 'subjectAltName=DNS:registry-1.docker.io'], { stdio: 'ignore' });
    pem = readFileSync(join(dir, 'c.pem'), 'utf8');
  } catch { t.skip('no openssl'); return; }
  const site = httpsServer({ key: readFileSync(join(dir, 'k.pem')), cert: pem }, (req, res) => res.end(`hello ${req.url} ${req.headers.authorization}`));
  await new Promise((ok) => site.listen(0, '127.0.0.1', ok));
  const seen = [];
  const proxy = httpServer().on('connect', (req, sock) => {
    seen.push(`${req.url} ${req.headers['proxy-authorization']}`);
    const up = netConnect(site.address().port, '127.0.0.1', () => { sock.write('HTTP/1.1 200 OK\r\n\r\n'); up.pipe(sock).pipe(up); });
  });
  await new Promise((ok) => proxy.listen(0, '127.0.0.1', ok));
  const res = await proxiedRequest('https://registry-1.docker.io/v2/x?y=1', { headers: { Authorization: 'Bearer t' }, proxy: { url: 'http://srt:s%40cret@', port: proxy.address().port, ca: pem } });
  const text = await new Promise((ok) => { let b = ''; res.on('data', (d) => { b += d; }).on('end', () => ok(b)); });
  assert.equal(text, 'hello /v2/x?y=1 Bearer t');
  assert.deepEqual(seen, [`registry-1.docker.io:443 Basic ${Buffer.from('srt:s@cret').toString('base64')}`]);
  // Without the proxy's CA the certificate isn't trusted.
  await assert.rejects(proxiedRequest('https://registry-1.docker.io/v2/', { proxy: { url: 'http://', port: proxy.address().port } }));
  site.close(); proxy.close();
});
