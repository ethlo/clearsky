// Two doors out of the sandbox that its network can't provide (GitHub's is at srt's proxy,
// lib/github-gate.mjs). scripts/sandbox-bin hands these commands to Clearsky over a socket
// only you can open, and Clearsky runs them here, as you:
// - acli: its Jira login is in the keyring the sandbox can't see. Reading Jira runs at once;
//   a change after you OK it in the chat;
// - vm <command>: runs in the chat's VM (lib/vm.mjs), with its own Docker: tests that start
//   containers. No question: the VM is the fence. Its output comes back as it's written.
// - outside <command>: what can't run inside (or in the VM), after your OK.
// Commands on Settings → Copilot's never-ask list run without asking (`outside` ones only when
// they match exactly). Which chat asks comes from the key Clearsky gave that chat's sandbox.

import { createServer } from 'node:net';
import { execFile } from 'node:child_process';
import { mkdirSync, rmSync, chmodSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';

const { acliWrites } = createRequire(import.meta.url)('../scripts/sandbox-bin/rules.js');
export { acliWrites };

export const brokerSocket = (uid = process.getuid?.() ?? 0) => join(tmpdir(), `clearsky-${uid}`, 'broker.sock');

// A never-ask entry matches a command that starts with it, except `outside` entries, which match
// only that exact command: `outside ./mvnw` must not also let `outside ./mvnw exec:exec …` through.
export const allowMatches = (p, w) => p.every((x, i) => w[i] === x) && (p[0] !== 'outside' || p.length === w.length);
const listed = (allow, words) => allow.some((p) => { const w = p.trim().split(/\s+/); return w[0] && allowMatches(w, words); });

// What a command needs before it runs: 'run' (only reads), 'ask', or 'no' (not something the
// door is for).
export function needs(tool, argv, allow = []) {
  if (!Array.isArray(argv) || !argv.every((a) => typeof a === 'string')) return 'no';
  if (tool === 'acli') return !acliWrites(argv) ? 'run' : listed(allow, ['acli', ...argv]) ? 'run' : 'ask';
  if (tool === 'vm') return argv.length ? 'run' : 'no';
  if (tool === 'outside') return !argv.length ? 'no' : listed(allow, ['outside', ...argv]) ? 'run' : 'ask';
  return 'no';
}

const isDir = (d) => { try { return statSync(d).isDirectory(); } catch { return false; } };

// `ask({ key, tool, argv, cwd })` resolves true when you allowed it in that chat; `where(key)`
// gives the folders that chat may work in (a door only opens in one of them).
export function serveBroker({ path = brokerSocket(), bins = {}, allow = () => [], ask = async () => false, where = () => null, run = execFile, vm = null, log = () => {} }) {
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
  chmodSync(join(path, '..'), 0o700);
  rmSync(path, { force: true });
  const server = createServer((sock) => {
    let buf = '';
    const reply = (code, stdout, stderr) => { if (!sock.destroyed) sock.end(`${JSON.stringify({ code, stdout: String(stdout || ''), stderr: String(stderr || '') })}\n`); };
    sock.on('data', async (d) => {
      buf += d;
      if (!buf.includes('\n') || sock.handled) return;
      sock.handled = true;
      let req;
      try { req = JSON.parse(buf.slice(0, buf.indexOf('\n'))); } catch { return reply(2, '', 'bad request\n'); }
      const { tool, argv, cwd, key, java } = req;
      const roots = where(key);
      const inRoots = typeof cwd === 'string' && isDir(cwd) && roots?.some((r) => cwd === r || cwd.startsWith(`${r}/`));
      const need = !roots ? 'no' : needs(tool, argv, allow());
      if (need === 'no' || (tool !== 'acli' && !inRoots)) {
        log(`clearsky: sandbox door ${tool} -> refused`);
        return reply(1, '', `Clearsky: ${!roots ? 'this chat is closed' : need === 'no' ? `${tool} ${argv?.[0] || ''} runs in the sandbox, not through Clearsky` : 'only in your folders'}.\n`);
      }
      const inVm = async () => {
        // Output as it comes: one JSON line per chunk, then the exit code.
        const chunk = (k) => (d) => { if (!sock.destroyed) sock.write(`${JSON.stringify({ [k]: String(d) })}\n`); };
        // The command in the sandbox ended (stopped turn): stop it in the VM too.
        const ac = new AbortController();
        sock.on('close', () => ac.abort());
        const code = await vm({ key, argv, cwd, java: typeof java === 'string' ? java : null, signal: ac.signal }, chunk('o'), chunk('e')).catch((e) => { chunk('e')(`Clearsky: the VM failed: ${e.message}\n`); return 1; });
        log(`clearsky: sandbox door vm -> exit ${code}`);
        return reply(code, '', '');
      };
      if (tool === 'vm') return vm ? inVm() : reply(1, '', 'Clearsky: there is no VM on this machine; use `outside` for this.\n');
      // An `outside` card can also send it to the chat's VM (answer 'vm').
      const ok = need === 'run' || await ask({ key, tool, argv, cwd, vm: tool === 'outside' && !!vm }).catch(() => false);
      if (ok === 'vm' && vm) { log('clearsky: sandbox door outside -> sent to the VM'); return inVm(); }
      log(`clearsky: sandbox door ${tool} -> ${need === 'run' ? 'ran' : ok ? 'allowed' : 'declined'}`);
      if (!ok) return reply(1, '', `Clearsky: you declined this ${tool === 'outside' ? 'command' : 'Jira change'}. Ask what to do instead.\n`);
      const [bin, args] = tool === 'outside' ? [argv[0], argv.slice(1)] : [bins.acli || 'acli', argv];
      const opts = { cwd: tool === 'acli' ? undefined : cwd, timeout: tool === 'outside' ? 30 * 6e4 : 5 * 6e4, maxBuffer: 64 * 1024 * 1024 };
      run(bin, args, opts, (err, stdout, stderr) =>
        reply(err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr || (err && typeof err.code !== 'number' ? `${err.message}\n` : '')));
    });
    sock.on('error', () => {});
  });
  server.listen(path, () => { try { chmodSync(path, 0o600); } catch {} });
  return server;
}
