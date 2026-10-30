// Copilot in a container of its own (see docker-compose.yml): Clearsky's container runs
// `copilot …` through scripts/copilot-remote.mjs, which hands the command to this runner over
// the containers' private network. The runner has your code, Copilot's folder and its own
// logins, but none of Clearsky's settings, the school login or the dashboard's tokens, and it
// reaches the internet only through the allowlisted proxy (lib/egress.mjs).
//
// One connection runs one process. Frames: 1 byte type, 4 bytes length, then the payload.
//   to the runner:   0 start {token, argv, cwd}   1 stdin   2 end of stdin
//   from the runner: 1 stdout   2 stderr   3 exit {code}

import { createServer, connect } from 'node:net';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';

export const T = { start: 0, stdin: 1, stdinEnd: 2, stdout: 1, stderr: 2, exit: 3 };

export function frame(type, data = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(typeof data === 'string' ? data : JSON.stringify(data));
  const head = Buffer.alloc(5);
  head.writeUInt8(type, 0);
  head.writeUInt32BE(body.length, 1);
  return Buffer.concat([head, body]);
}

// Feed it chunks; it calls onFrame(type, payload) for each whole frame.
export function frames(onFrame) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 5) {
      const len = buf.readUInt32BE(1);
      if (buf.length < 5 + len) break;
      const type = buf.readUInt8(0), body = buf.subarray(5, 5 + len);
      buf = buf.subarray(5 + len);
      onFrame(type, body);
    }
  };
}

const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };

// The runner: runs `bin argv…` in cwd for each caller with the token.
export function serveRunner({ port = 7790, host = '0.0.0.0', token, bin = 'copilot', run = spawn, log = () => {} }) {
  if (!token) throw new Error('the runner needs a token');
  const server = createServer((sock) => {
    let child = null;
    const send = (type, data) => { if (!sock.destroyed) sock.write(frame(type, data)); };
    sock.on('data', frames((type, body) => {
      if (!child) {
        let req;
        try { req = type === T.start && JSON.parse(body); } catch { req = null; }
        if (!req || !same(req.token, token) || !Array.isArray(req.argv) || !req.argv.every((a) => typeof a === 'string')) { log('runner: refused a caller'); return sock.destroy(); }
        const cwd = typeof req.cwd === 'string' && existsSync(req.cwd) ? req.cwd : process.env.HOME;
        child = run(bin, req.argv, { cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
        child.stdout.on('data', (d) => send(T.stdout, d));
        child.stderr.on('data', (d) => send(T.stderr, d));
        child.on('error', (e) => { send(T.stderr, `${e.message}\n`); send(T.exit, { code: 127 }); sock.end(); });
        child.on('close', (code) => { send(T.exit, { code: code ?? 1 }); sock.end(); });
        return;
      }
      if (type === T.stdin) child.stdin.write(body);
      else if (type === T.stdinEnd) child.stdin.end();
    }));
    sock.on('error', () => {});
    sock.on('close', () => { if (child && child.exitCode === null) child.kill(); });
  });
  server.listen(port, host);
  return server;
}

// The caller's side: runs argv on the runner as if it were here. Resolves with the exit code.
export function runRemote({ host, port, token, argv, cwd, stdin = process.stdin, stdout = process.stdout, stderr = process.stderr }) {
  return new Promise((resolve) => {
    const sock = connect(port, host, () => {
      sock.write(frame(T.start, { token, argv, cwd }));
      stdin.on('data', (d) => sock.write(frame(T.stdin, d)));
      stdin.on('end', () => sock.write(frame(T.stdinEnd)));
    });
    let code = null;
    sock.on('data', frames((type, body) => {
      if (type === T.stdout) stdout.write(body);
      else if (type === T.stderr) stderr.write(body);
      else if (type === T.exit) { try { code = JSON.parse(body).code; } catch { code = 1; } }
    }));
    sock.on('error', (e) => { stderr.write(`Copilot's container can't be reached (${e.message})\n`); });
    sock.on('close', () => { stdin.pause?.(); resolve(code ?? 1); });
  });
}
