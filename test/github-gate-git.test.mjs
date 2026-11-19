// The GitHub gate against real git: pushes over HTTP to a local `git http-backend`, each request
// judged by githubFilter on the way (as srt's proxy does), so what git really sends is what's read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFileSync, execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { githubFilter } from '../lib/github-gate.mjs';

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'push.negotiate=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// Pushes wait asynchronously: the server answering them runs in this same process.
const gitAsync = (cwd, ...args) => promisify(execFile)('git', ['-c', 'push.negotiate=false', ...args], { cwd });

function backend(root, filter) {
  return http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const body = Buffer.concat(chunks), u = new URL(req.url, 'http://x');
      const ghUrl = `https://github.com/acme/api${u.pathname.replace(/^\/api\.git/, '.git')}${u.search}`;
      const decision = await filter(new Request(ghUrl, { method: req.method, headers: { 'content-type': req.headers['content-type'] || '' }, ...(req.method === 'POST' && { body }) }));
      if (decision.action !== 'allow') { res.writeHead(403); res.end(decision.reason || 'denied'); return; }
      const p = spawn('git', ['http-backend'], { env: { ...process.env, GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: '1', PATH_INFO: u.pathname,
        QUERY_STRING: u.search.slice(1), REQUEST_METHOD: req.method, CONTENT_TYPE: req.headers['content-type'] || '', CONTENT_LENGTH: String(body.length), REMOTE_USER: 't' } });
      p.stdin.end(body);
      const out = [];
      p.stdout.on('data', (c) => out.push(c));
      p.on('close', () => {
        const b = Buffer.concat(out), i = b.indexOf('\r\n\r\n'), headers = {};
        let status = 200;
        for (const line of b.subarray(0, i).toString().split('\r\n')) {
          const [k, ...v] = line.split(': ');
          if (k.toLowerCase() === 'status') status = parseInt(v.join(': '), 10); else if (k) headers[k] = v.join(': ');
        }
        res.writeHead(status, headers);
        res.end(b.subarray(i + 4));
      });
    });
  });
}

test('real git pushes to a feature branch go through without a card, big ones too', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'clearsky-gate-git-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, 'init', '-q', '--bare', 'api.git');
  git(join(dir, 'api.git'), 'config', 'http.receivepack', 'true');
  const work = join(dir, 'work');
  git(dir, 'init', '-q', '-b', 'feature/abc-1', 'work');
  git(work, 'commit', '-q', '--allow-empty', '-m', 'one');

  const asked = [], told = [];
  const look = { fastForward: async () => true, protected: async () => false, compare: async () => ({ status: 'ahead' }) };
  const server = backend(dir, githubFilter(async (what) => { asked.push(what); return false; }, { told: (what) => told.push(what), look }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const remote = `http://127.0.0.1:${server.address().port}/api.git`;

  await gitAsync(work, 'push', '-q', remote, 'feature/abc-1');
  git(work, 'commit', '-q', '--allow-empty', '-m', 'two');
  await gitAsync(work, 'push', '-q', remote, 'feature/abc-1');
  // Over http.postBuffer (1 MB) git first sends a probe that is only a flush packet.
  writeFileSync(join(work, 'big.bin'), randomBytes(1_500_000));
  git(work, 'add', 'big.bin');
  git(work, 'commit', '-q', '-m', 'big');
  await gitAsync(work, 'push', '-q', remote, 'feature/abc-1');

  assert.deepEqual(asked, []);
  assert.deepEqual(told, Array(3).fill('git push to acme/api (feature/abc-1)'), 'each push told once, the probe not at all');
  // A push to main still asks (and is turned down here).
  await assert.rejects(gitAsync(work, 'push', '-q', remote, 'feature/abc-1:main'));
  assert.equal(asked.length, 1);
  assert.match(asked[0], /pushes to main/);
});
