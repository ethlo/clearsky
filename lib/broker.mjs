// The sandbox's few doors out. Copilot in srt can't push, change GitHub or Jira, or run things
// on your machine: its GitHub token only reads, and acli's login is in the keyring it can't
// see. So scripts/sandbox-bin hands those commands to Clearsky over a socket only you can open,
// and Clearsky runs them here, as you:
// - acli: reading Jira at once; a change after you OK it in the chat;
// - gh: a change (PR, comment, review, API write) after your OK; reading runs in the sandbox;
// - git push: after your OK, from your machine, with the clone's own hooks and helpers off;
// - outside <command>: anything else (tests that start Docker containers), after your OK.
// Commands on Settings → Copilot's never-ask list run without asking (`outside` ones only when
// they match exactly). Which chat asks comes from the key Clearsky gave that chat's sandbox.

import { createServer } from 'node:net';
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, chmodSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';

const { gitWrites, ghWrites, acliWrites } = createRequire(import.meta.url)('../scripts/sandbox-bin/rules.js');
export { gitWrites, ghWrites, acliWrites };

export const brokerSocket = (uid = process.getuid?.() ?? 0) => join(tmpdir(), `clearsky-${uid}`, 'broker.sock');

// A never-ask entry matches a command that starts with it, except `outside` entries, which match
// only that exact command: `outside ./mvnw` must not also let `outside ./mvnw exec:exec …` through.
export const allowMatches = (p, w) => p.every((x, i) => w[i] === x) && (p[0] !== 'outside' || p.length === w.length);
const listed = (allow, words) => allow.some((p) => { const w = p.trim().split(/\s+/); return w[0] && allowMatches(w, words); });

// What a command needs before it runs: 'run' (only reads), 'ask', or 'no' (not something the
// door is for: a git command other than push, a gh read, which run in the sandbox).
export function needs(tool, argv, allow = []) {
  if (!Array.isArray(argv) || !argv.every((a) => typeof a === 'string')) return 'no';
  if (tool === 'acli') return !acliWrites(argv) ? 'run' : listed(allow, ['acli', ...argv]) ? 'run' : 'ask';
  if (tool === 'gh') return !ghWrites(argv) ? 'no' : listed(allow, ['gh', ...argv]) ? 'run' : 'ask';
  if (tool === 'git') return !gitWrites(argv) ? 'no' : listed(allow, ['git', ...argv]) ? 'run' : 'ask';
  if (tool === 'outside') return !argv.length ? 'no' : listed(allow, ['outside', ...argv]) ? 'run' : 'ask';
  return 'no';
}

// git and gh (which runs git) read the clone's own settings, which Copilot could have changed in
// the sandbox: hooks, an ssh or credential command, filters. Run here with those off; your own
// git settings (~/.gitconfig) still apply, credential helpers included.
export function safeGitEnv(env = process.env, globalHelpers = gitGlobal('credential.helper')) {
  const pairs = [['core.hooksPath', '/dev/null'], ['core.fsmonitor', 'false'], ['core.sshCommand', 'ssh'], ['core.askPass', ''],
    ['protocol.allow', 'never'], ['protocol.https.allow', 'always'], ['protocol.ssh.allow', 'always'], ['push.gpgSign', 'false'],
    ['credential.helper', ''], ...globalHelpers.map((h) => ['credential.helper', h])];
  const out = Object.fromEntries(Object.entries(env).filter(([k]) => !/^GIT_/.test(k)));
  pairs.forEach(([k, v], i) => { out[`GIT_CONFIG_KEY_${i}`] = k; out[`GIT_CONFIG_VALUE_${i}`] = v; });
  out.GIT_CONFIG_COUNT = String(pairs.length);
  return out;
}
function gitGlobal(key) {
  try { return execFileSync('git', ['config', '--global', '--get-all', key], { encoding: 'utf8', timeout: 5000, cwd: tmpdir(), stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean); } catch { return []; }
}

const isDir = (d) => { try { return statSync(d).isDirectory(); } catch { return false; } };

// `ask({ key, tool, argv, cwd })` resolves true when you allowed it in that chat; `where(key)`
// gives the folders that chat may work in (a door only opens in one of them).
export function serveBroker({ path = brokerSocket(), bins = {}, allow = () => [], ask = async () => false, where = () => null, run = execFile, env = safeGitEnv, log = () => {} }) {
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
      const { tool, argv, cwd, key } = req;
      const roots = where(key);
      const inRoots = typeof cwd === 'string' && isDir(cwd) && roots?.some((r) => cwd === r || cwd.startsWith(`${r}/`));
      const need = !roots ? 'no' : needs(tool, argv, allow());
      if (need === 'no' || (tool !== 'acli' && !inRoots)) {
        log(`clearsky: sandbox door ${tool} -> refused`);
        return reply(1, '', `Clearsky: ${!roots ? 'this chat is closed' : need === 'no' ? `${tool} ${argv?.[0] || ''} runs in the sandbox, not through Clearsky` : 'only in your folders'}.\n`);
      }
      const ok = need === 'run' || await ask({ key, tool, argv, cwd }).catch(() => false);
      log(`clearsky: sandbox door ${tool} -> ${need === 'run' ? 'ran' : ok ? 'allowed' : 'declined'}`);
      if (!ok) return reply(1, '', `Clearsky: you declined this ${tool === 'outside' ? 'command' : `${tool} change`}. Ask what to do instead.\n`);
      const [bin, args] = tool === 'outside' ? [argv[0], argv.slice(1)] : [bins[tool] || tool, argv];
      const opts = { cwd: tool === 'acli' ? undefined : cwd, timeout: tool === 'outside' ? 30 * 6e4 : 5 * 6e4, maxBuffer: 64 * 1024 * 1024,
        env: tool === 'git' || tool === 'gh' ? env() : process.env };
      run(bin, args, opts, (err, stdout, stderr) =>
        reply(err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr || (err && typeof err.code !== 'number' ? `${err.message}\n` : '')));
    });
    sock.on('error', () => {});
  });
  server.listen(path, () => { try { chmodSync(path, 0o600); } catch {} });
  return server;
}
