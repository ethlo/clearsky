// acli inside the sandbox. acli keeps its Jira login only in the keyring, which the sandbox hides
// (lib/sandbox.mjs), so sandboxed Copilot runs scripts/sandbox-bin/acli instead: it hands the
// command to Clearsky over a socket only you can open, and Clearsky runs the real acli here.
// Reading (view, search, list) always runs. A change to Jira runs only when it starts like a
// command in Settings → Copilot's "never ask" list, or you allowed that command in the chat in
// the last ten minutes (once).

import { createServer } from 'node:net';
import { execFile } from 'node:child_process';
import { mkdirSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { commandAsks } from './assisted.mjs';

export const brokerSocket = (uid = process.getuid?.() ?? 0) => join(tmpdir(), `clearsky-${uid}`, 'acli.sock');

// Commands you allowed in a chat, for a short while.
export function approvals(ttl = 10 * 6e4, now = Date.now) {
  const list = [];
  return {
    add(command) { if (typeof command === 'string' && /\b(acli|outside)\b/.test(command)) list.push({ command, at: now() }); },
    // Takes the approval this command came from: the allowed command names `word` and every argument.
    take(argv, word = 'acli') {
      for (let i = list.length - 1; i >= 0; i--) if (now() - list[i].at > ttl) list.splice(i, 1);
      const i = list.findIndex((a) => new RegExp(`\\b${word}\\b`).test(a.command) && argv.every((x) => a.command.includes(x)));
      return i >= 0 && !!list.splice(i, 1);
    },
  };
}

// Why acli may run this: 'read', 'allowed' or 'approved'; null when it may not.
export function acliAllowed(argv, { allow = [], approved } = {}) {
  if (commandAsks('acli', argv) === null) return 'read';
  const line = ['acli', ...argv].join(' ');
  if (allow.some((p) => p && line.startsWith(p))) return 'allowed';
  return approved?.take(argv) ? 'approved' : null;
}

export function serveBroker({ path = brokerSocket(), bin = 'acli', allow = () => [], approved, run = execFile, log = () => {} }) {
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
  chmodSync(join(path, '..'), 0o700);
  rmSync(path, { force: true });
  const server = createServer((sock) => {
    let buf = '';
    sock.on('data', (d) => {
      buf += d;
      if (!buf.includes("\n")) return;
      let req;
      try { req = JSON.parse(buf.slice(0, buf.indexOf('\n'))); } catch { return sock.end(`${JSON.stringify({ code: 2, stderr: 'bad request\n' })}\n`); }
      const argv = Array.isArray(req.argv) && req.argv.every((a) => typeof a === 'string') ? req.argv : null;
      const reply = (code, stdout, stderr) => sock.end(`${JSON.stringify({ code, stdout: String(stdout || ''), stderr: String(stderr || '') })}\n`);
      if (req.outside) return runOutside(argv, req.cwd, { approved, allow: allow(), run, log, reply });
      const why = argv && acliAllowed(argv, { allow: allow(), approved });
      log(`clearsky: sandboxed acli -> ${why || 'refused'}`);
      if (!why) return sock.end(`${JSON.stringify({ code: 1, stderr: 'Clearsky: this acli command changes Jira and wasn\'t allowed in the chat; ask for it so it can be approved.\n' })}\n`);
      run(bin, argv, { timeout: 120_000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
        sock.end(`${JSON.stringify({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || (err && !err.code ? err.message : '')) })}\n`);
      });
    });
    sock.on('error', () => {});
  });
  server.listen(path, () => { try { chmodSync(path, 0o600); } catch {} });
  return server;
}

// `outside <command>`: a command that can't work in the sandbox (tests that start Docker
// containers) runs here, on your machine, once you've allowed exactly that command in the chat.
// A command on Settings → Copilot's never-ask list (like "outside ./mvnw") runs without that.
function runOutside(argv, cwd, { approved, allow = [], run, log, reply }) {
  const line = ['outside', ...(argv || [])].join(' ');
  const listed = allow.some((p) => /^outside\s+\S/.test(p) && (line === p || line.startsWith(`${p} `)));
  const ok = argv?.length && typeof cwd === 'string' && existsSync(cwd) && (listed || approved?.take(argv, 'outside'));
  log(`clearsky: outside the sandbox -> ${ok ? 'approved' : 'refused'}`);
  if (!ok) return reply(1, '', 'Clearsky: running this outside the sandbox needs your OK in the chat for this exact command.\n');
  run(argv[0], argv.slice(1), { cwd, timeout: 30 * 6e4, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) =>
    reply(err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr || (err && typeof err.code !== 'number' ? `${err.message}\n` : '')));
}
