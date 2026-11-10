// Two doors out of the sandbox that its network can't provide (GitHub's is at srt's proxy,
// lib/github-gate.mjs). scripts/sandbox-bin hands these commands to Clearsky over a socket
// only you can open, and Clearsky runs them here, as you:
// - acli: its Jira login is in the keyring the sandbox can't see. Reading Jira runs at once;
//   a change after you OK it in the chat;
// - vm <command>: runs in the chat's VM (lib/vm.mjs), with its own Docker: tests that start
//   containers. No question: the VM is the fence. Its output comes back as it's written.
// - outside <command>: what can't run inside (or in the VM), after your OK.
// - review …: a proper review of the chat's change by a fresh Copilot that knows only the goal
//   and the code (lib/review.mjs). Only reads, so no question; in your folders only.
// - bg <command> / bg vm <command> / bg outside <command>: the same command as a background job
//   (lib/jobs.mjs), so the chat can end its turn and be woken with the result; `bg outside` asks
//   like `outside`. `jobs` lists, shows and stops this chat's jobs.
// - plugins' doors (`grafana …`, or `door <name> …` for any): a plugin that runs inside Clearsky
//   acts for the chat with what it holds (Grafana: your login, which stays here). The door decides
//   what to ask; Clearsky logs each call and removes secrets from what goes back.
// Commands on Settings → Copilot's never-ask list run without asking (`outside` ones only when
// they match exactly). Which chat asks comes from the key Clearsky gave that chat's sandbox.

import { createServer } from 'node:net';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, chmodSync, statSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { adfArgs } from './to-adf.mjs';

const { acliWrites } = createRequire(import.meta.url)('../scripts/sandbox-bin/rules.js');
export { acliWrites };

export const brokerSocket = (uid = process.getuid?.() ?? 0) => join(tmpdir(), `clearsky-${uid}`, 'broker.sock');

// A never-ask entry matches a command that starts with it, except `outside` entries, which match
// only that exact command: `outside ./mvnw` must not also let `outside ./mvnw exec:exec …` through.
export const allowMatches = (p, w) => p.every((x, i) => w[i] === x) && (p[0] !== 'outside' || p.length === w.length);
const listed = (allow, words) => allow.some((p) => { const w = p.trim().split(/\s+/); return w[0] && allowMatches(w, words); });

// What a command needs before it runs: 'run' (only reads), 'ask', or 'no' (not something the
// door is for).
export function needs(tool, argv, allow = [], hasDoor = () => false) {
  if (!Array.isArray(argv) || !argv.every((a) => typeof a === 'string')) return 'no';
  if (tool === 'door') return argv.length && hasDoor(argv[0]) ? 'run' : 'no'; // the door asks what it needs to itself
  if (tool === 'acli') return !acliWrites(argv) ? 'run' : listed(allow, ['acli', ...argv]) ? 'run' : 'ask';
  if (tool === 'vm') return argv.length ? 'run' : 'no';
  if (tool === 'review') return 'run';
  if (tool === 'usage') return 'run'; // reads the chat's own session log
  if (tool === 'jobs') return 'run'; // this chat's own jobs
  if (tool === 'bg') return !argv.length || (['vm', 'outside'].includes(argv[0]) && argv.length < 2) ? 'no' : 'run'; // `bg outside` asks below
  if (tool === 'outside') return !argv.length ? 'no' : listed(allow, ['outside', ...argv]) ? 'run' : 'ask';
  return hasDoor(tool) ? 'run' : 'no'; // a door by its own name (scripts/sandbox-bin/grafana)
}

const isDir = (d) => { try { return statSync(d).isDirectory(); } catch { return false; } };

// `ask({ key, tool, argv, cwd })` resolves true when you allowed it in that chat; `where(key)`
// gives the folders that chat may work in (a door only opens in one of them). `doors(name)` is a
// plugin's door, or null: `({ key, name, argv }) → { code, stdout, stderr }`.
export function serveBroker({ path = brokerSocket(), bins = {}, allow = () => [], ask = async () => false, where = () => null, run = execFile, vm = null, doors = () => null, review = null, usage = null, jobs = null, log = () => {} }) {
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
      const need = !roots ? 'no' : needs(tool, argv, allow(), (n) => !!doors(n));
      // A plugin's door, by its own command or as `door <name> …`.
      const doorName = tool === 'door' ? argv?.[0] : need !== 'no' && doors(tool) ? tool : null;
      if (need === 'no' || (tool !== 'acli' && !doorName && !inRoots)) {
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
      if (tool === 'review') {
        if (!review) return reply(1, '', 'Clearsky: review isn\'t available here.\n');
        const chunk = (k) => (d) => { if (!sock.destroyed) sock.write(`${JSON.stringify({ [k]: String(d) })}\n`); };
        const ac = new AbortController();
        sock.on('close', () => ac.abort());
        const code = await review({ key, argv, cwd, signal: ac.signal }, chunk('o'), chunk('e')).catch((e) => { chunk('e')(`Clearsky: the review failed: ${e.message}\n`); return 1; });
        log(`clearsky: sandbox door review -> exit ${code}`);
        return reply(code, '', '');
      }
      if (tool === 'usage') {
        const r = usage ? await Promise.resolve(usage({ key, argv })).catch((e) => ({ code: 1, stdout: '', stderr: `Clearsky: ${e.message}\n` })) : { code: 1, stdout: '', stderr: 'Clearsky: usage isn\'t available here.\n' };
        return reply(r.code, r.stdout, r.stderr);
      }
      if (tool === 'bg' || tool === 'jobs') {
        if (!jobs) return reply(1, '', 'Clearsky: background jobs aren\'t available here; run the command as usual.\n');
        let where = tool === 'bg' ? (['vm', 'outside'].includes(argv[0]) ? argv[0] : 'sandbox') : null;
        const cmd = where && where !== 'sandbox' ? argv.slice(1) : argv;
        if (where === 'vm' && !vm) return reply(1, '', 'Clearsky: there is no VM on this machine; use `bg outside` for this.\n');
        if (where === 'outside' && !listed(allow(), ['outside', ...cmd])) {
          const ok = await ask({ key, tool: 'outside', argv: cmd, cwd, vm: !!vm, background: true }).catch(() => false);
          log(`clearsky: sandbox door bg outside -> ${ok === 'vm' ? 'sent to the VM' : ok ? 'allowed' : 'declined'}`);
          if (!ok) return reply(1, '', 'Clearsky: you declined this command. Ask what to do instead.\n');
          if (ok === 'vm') where = 'vm';
        }
        const r = await Promise.resolve(jobs({ key, tool, where, argv: cmd, cwd, java: typeof java === 'string' ? java : null }))
          .catch((e) => ({ code: 1, stdout: '', stderr: `Clearsky: ${e.message}\n` }));
        if (tool === 'bg') log(`clearsky: sandbox door bg ${where} -> ${r.code ? 'refused' : 'started'}`);
        return reply(r.code, r.stdout, r.stderr);
      }
      if (doorName) {
        const r = await doors(doorName)({ key, name: doorName, argv: tool === 'door' ? argv.slice(1) : argv }).catch((e) => ({ code: 1, stdout: '', stderr: `Clearsky: ${e.message}\n` }));
        log(`clearsky: sandbox door ${doorName} -> exit ${r.code}`);
        return reply(r.code, r.stdout, r.stderr);
      }
      // An `outside` card can also send it to the chat's VM (answer 'vm').
      const ok = need === 'run' || await ask({ key, tool, argv, cwd, vm: tool === 'outside' && !!vm }).catch(() => false);
      if (ok === 'vm' && vm) { log('clearsky: sandbox door outside -> sent to the VM'); return inVm(); }
      log(`clearsky: sandbox door ${tool} -> ${need === 'run' ? 'ran' : ok ? 'allowed' : 'declined'}`);
      if (!ok) return reply(1, '', `Clearsky: you declined this ${tool === 'outside' ? 'command' : 'Jira change'}. Ask what to do instead.\n`);
      // Jira text goes as ADF, so its headings, lists and code show as such (lib/to-adf.mjs). A
      // --description-file is read only from the chat's folders.
      const inChat = (f) => { const r = realpathSync(f); if (!roots.some((d) => r === d || r.startsWith(`${d}/`))) throw new Error('outside'); return readFileSync(r, 'utf8'); };
      // `comment update` and --from-json take ADF only from a file: a private one, gone after.
      let tmp = null;
      const writeFile = (name, text) => { tmp ||= mkdtempSync(join(tmpdir(), 'clearsky-acli-')); const f = join(tmp, name); writeFileSync(f, text, { mode: 0o600 }); return f; };
      const [bin, args] = tool === 'outside' ? [argv[0], argv.slice(1)] : [bins.acli || 'acli', acliWrites(argv) ? adfArgs(argv, inChat, inRoots ? cwd : null, writeFile) : argv];
      if (tool === 'acli' && args.some((x, i) => x !== argv[i])) log('clearsky: acli text sent to Jira as ADF');
      const opts = { cwd: tool === 'acli' ? undefined : cwd, timeout: tool === 'outside' ? 30 * 6e4 : 5 * 6e4, maxBuffer: 64 * 1024 * 1024 };
      run(bin, args, opts, (err, stdout, stderr) => {
        if (tmp) rmSync(tmp, { recursive: true, force: true });
        reply(err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr || (err && typeof err.code !== 'number' ? `${err.message}\n` : ''));
      });
    });
    sock.on('error', () => {});
  });
  server.listen(path, () => { try { chmodSync(path, 0o600); } catch {} });
  return server;
}
