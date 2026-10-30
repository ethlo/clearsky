import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createServer, connect } from 'node:net';
import { serveRunner, runRemote } from '../lib/runner.mjs';
import { allowed, serveEgress, mavenHosts } from '../lib/egress.mjs';
import { srtSettings } from '../lib/sandbox.mjs';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const listening = (s) => new Promise((r) => s.on('listening', () => r(s.address().port)));

test('Copilot runs in its own container: stdin, stdout, stderr and the exit code go across, only with the token', async () => {
  const server = serveRunner({ port: 0, host: '127.0.0.1', token: 'secret', bin: process.execPath });
  const port = await listening(server);
  const run = async (token, argv, input = '') => {
    const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
    let out = '', err = '';
    stdout.on('data', (d) => { out += d; }); stderr.on('data', (d) => { err += d; });
    const p = runRemote({ host: '127.0.0.1', port, token, argv, cwd: tmpdir(), stdin, stdout, stderr });
    setTimeout(() => stdin.end(input), 50);
    return { code: await p, out, err };
  };
  const r = await run('secret', ['-e', 'process.stdin.on("data", d => process.stdout.write(String(d).toUpperCase())); process.stdin.on("end", () => { console.error("bye"); process.exit(3); })'], 'hello');
  assert.deepEqual([r.code, r.out, r.err.trim()], [3, 'HELLO', 'bye']);
  assert.equal((await run('wrong', ['-e', '1'])).code, 1, 'a wrong token runs nothing');
  server.close();
});

test('Copilot\'s proxy lets through only the hosts on its list', async () => {
  assert.ok(allowed('api.github.com', ['*.github.com']));
  assert.ok(!allowed('github.com.evil.test', ['*.github.com', 'github.com']));
  assert.ok(!allowed('evil.test', ['github.com']));
  const target = createServer((s) => s.end('hi')); const tport = await listening(target.listen(0, '127.0.0.1'));
  const proxy = serveEgress({ port: 0, host: '127.0.0.1', list: ['github.com'] }); const pport = await listening(proxy);
  const ask = (line) => new Promise((r) => { const c = connect(pport, '127.0.0.1', () => c.write(line)); let d = ''; c.on('data', (x) => { d += x; }); c.on('close', () => r(d)); });
  assert.match(await ask('CONNECT evil.test:443 HTTP/1.1\r\n\r\n'), /403/);
  assert.match(await ask(`CONNECT github.com:${tport} HTTP/1.1\r\n\r\n`), /403/, 'only ports 80 and 443');
  proxy.close(); target.close();
  const home = mkdtempSync(join(tmpdir(), 'm2-')); mkdirSync(join(home, '.m2'));
  writeFileSync(join(home, '.m2', 'settings.xml'), '<settings><mirrors><mirror><url>https://nexus.acme.test/repository/maven/</url></mirror></mirrors></settings>');
  assert.deepEqual(mavenHosts(home), ['nexus.acme.test']);
});

test('on Linux, srt runs without its socket filter and hides the session bus instead', () => {
  const s = srtSettings({ cwd: '/h/dev/x', home: '/h', platform: 'linux', uid: 1000 });
  assert.equal(s.network.allowAllUnixSockets, true);
  assert.ok(s.filesystem.denyRead.includes('/run/user/1000'));
  assert.equal(srtSettings({ cwd: '/h/x', home: '/h', platform: 'darwin', uid: 501 }).network.allowAllUnixSockets, undefined);
});
