// Two doors out of the sandbox that its network can't provide (GitHub's is at srt's proxy,
// lib/github-gate.mjs). scripts/sandbox-bin hands these commands to Clearsky over a socket
// only you can open, and Clearsky runs them here, as you:
// - acli: its Jira login is in the keyring the sandbox can't see. Reading Jira runs at once;
//   a change after you OK it in the chat; a move to a review status only once a person is asked
//   to review the ticket's PR (`gate`, lib/review-gate.mjs);
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
// Commands on Settings → Agent's never-ask list run without asking (`outside` ones only when
// they match exactly). Which chat asks comes from the key Clearsky gave that chat's sandbox.

import { createServer } from 'node:net';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, chmodSync, statSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { adfArgs, acliUpdateFlag } from './to-adf.mjs';
import { isCreate, ticketArgv } from './new-ticket.mjs';

const { acliWrites, acliJira, acliFiles } = createRequire(import.meta.url)('../scripts/sandbox-bin/rules.js');
export { acliWrites, acliJira, acliFiles };

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
  // A new ticket always asks, never-ask list or not: you pick its project and fix version (lib/new-ticket.mjs).
  if (tool === 'acli') return !acliJira(argv) ? 'no' : argv[0] !== 'jira' || !acliWrites(argv) ? 'run' : isCreate(argv) ? 'ask' : listed(allow, ['acli', ...argv]) ? 'run' : 'ask'; // not jira: acli's own help
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
export function serveBroker({ path = brokerSocket(), bins = {}, allow = () => [], ask = async () => false, where = () => null, run = execFile, vm = null, doors = () => null, review = null, usage = null, jobs = null, reads = () => [], gate = null, notes = async () => '', log = () => {} }) {
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
  chmodSync(join(path, '..'), 0o700);
  rmSync(path, { force: true });
  // Which flag acli's `comment update` takes ADF from, asked of acli once (lib/to-adf.mjs).
  let updateFlagOnce = null;
  const server = createServer((sock) => {
    let buf = '';
    // notes(key, { code, vm }) → what Clearsky has to tell the chat now (a host you allowed while it
    // worked), added to the command's output: the agent reads it in its turn, not only after it.
    let note = async () => '';
    const end = (code, stdout, stderr) => { if (!sock.destroyed) sock.end(`${JSON.stringify({ code, stdout: String(stdout || ''), stderr: String(stderr || '') })}\n`); };
    const reply = (code, stdout, stderr) => note({ code }).catch(() => '').then((n) => end(code, stdout, `${stderr || ''}${n || ''}`));
    sock.on('data', async (d) => {
      buf += d;
      if (!buf.includes('\n') || sock.handled) return;
      sock.handled = true;
      let req;
      try { req = JSON.parse(buf.slice(0, buf.indexOf('\n'))); } catch { return reply(2, '', 'bad request\n'); }
      const { tool, argv, cwd, key, java } = req;
      const roots = where(key);
      if (roots) note = (o) => Promise.resolve(notes(key, o));
      const inRoots = typeof cwd === 'string' && isDir(cwd) && roots?.some((r) => cwd === r || cwd.startsWith(`${r}/`));
      const need = !roots ? 'no' : needs(tool, argv, allow(), (n) => !!doors(n));
      // A plugin's door, by its own command or as `door <name> …`.
      const doorName = tool === 'door' ? argv?.[0] : need !== 'no' && doors(tool) ? tool : null;
      if (need === 'no' || (tool !== 'acli' && !doorName && !inRoots)) {
        log(`clearsky: sandbox door ${tool} -> refused`);
        return reply(1, '', `Clearsky: ${!roots ? 'this chat is closed' : need === 'no' ? (tool === 'acli' ? `acli ${argv?.[0] || ''} isn't for a chat: Clearsky runs \`acli jira …\` only` : `${tool} ${argv?.[0] || ''} runs in the sandbox, not through Clearsky`) : 'only in your folders'}.\n`);
      }
      const inVm = async () => {
        // Output as it comes: one JSON line per chunk, then the exit code.
        const chunk = (k) => (d) => { if (!sock.destroyed) sock.write(`${JSON.stringify({ [k]: String(d) })}\n`); };
        // The command in the sandbox ended (stopped turn): stop it in the VM too.
        const ac = new AbortController();
        sock.on('close', () => ac.abort());
        const code = await vm({ key, argv, cwd, java: typeof java === 'string' ? java : null, signal: ac.signal }, chunk('o'), chunk('e')).catch((e) => { chunk('e')(`Clearsky: the VM failed: ${e.message}\n`); return 1; });
        log(`clearsky: sandbox door vm -> exit ${code}`);
        const n = await note({ code, vm: true }).catch(() => '');
        if (n) chunk('e')(n);
        return end(code, '', '');
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
      // A ticket goes to review only once a person reviews its PR (lib/review-gate.mjs), never-ask list or not.
      const held = tool === 'acli' && gate ? await Promise.resolve(gate({ key, argv })).catch(() => null) : null;
      if (held) { log('clearsky: sandbox door acli -> held (no reviewer yet)'); return reply(1, '', held); }
      // An `outside` card can also send it to the chat's VM (answer 'vm').
      const ok = need === 'run' || await ask({ key, tool, argv, cwd, vm: tool === 'outside' && !!vm }).catch(() => false);
      if (ok === 'vm' && vm) { log('clearsky: sandbox door outside -> sent to the VM'); return inVm(); }
      log(`clearsky: sandbox door ${tool} -> ${need === 'run' ? 'ran' : ok ? 'allowed' : 'declined'}`);
      if (!ok) return reply(1, '', `Clearsky: you declined this ${tool === 'outside' ? 'command' : 'Jira change'}. Ask what to do instead.\n`);
      // Jira text goes as ADF, so its headings, lists and code show as such (lib/to-adf.mjs). A
      // --description-file is read only from the chat's folders; a relative one from where the chat ran acli.
      // Copilot's scratch folder too (`reads`), where it puts text it writes first.
      const readable = [...roots, ...reads().map((d) => { try { return realpathSync(d); } catch { return d; } })];
      // A text file Clearsky can't read would reach Jira as it is (raw Markdown): refused instead.
      const unread = [];
      const inChat = (f) => {
        try { const r = realpathSync(f); if (!readable.some((d) => r === d || r.startsWith(`${d}/`))) throw new Error('outside'); return readFileSync(r, 'utf8'); }
        catch (e) { unread.push(f); throw e; }
      };
      // Any other file acli would read here (--from-file, --from-csv…): the chat's own, or refused.
      // Clearsky runs acli as you, outside the sandbox, so it could read what the chat can't.
      const base = typeof cwd === 'string' && cwd.startsWith('/') ? cwd : null;
      if (tool === 'acli') {
        for (const f of acliFiles(argv)) {
          try { const r = realpathSync(f.startsWith('/') || !base ? f : join(base, f)); if (!readable.some((d) => r === d || r.startsWith(`${d}/`))) throw new Error('outside'); }
          catch { if (!unread.includes(f)) unread.push(f); }
        }
      }
      // `comment update` and --from-json take ADF only from a file: a private one, gone after.
      let tmp = null;
      const writeFile = (name, text) => { tmp ||= mkdtempSync(join(tmpdir(), 'clearsky-acli-')); const f = join(tmp, name); writeFileSync(f, text, { mode: 0o600 }); return f; };
      const updating = tool === 'acli' && argv.includes('comment') && argv[argv.indexOf('comment') + 1] === 'update';
      const updateFlag = updating ? await (updateFlagOnce ||= new Promise((res) => run(bins.acli || 'acli', ['jira', 'workitem', 'comment', 'update', '--help'], { timeout: 15_000 },
        (err, out, errOut) => res(acliUpdateFlag(() => { const t = `${out || ''}${errOut || ''}`; if (!t.trim()) throw err || new Error('no help'); return t; }))))) : undefined;
      // A new ticket, in the project and with the fix version you picked on its card.
      let sent = argv;
      if (tool === 'acli' && ok?.ticket) {
        try { sent = ticketArgv(argv, ok.ticket, { readFile: inChat, writeFile, cwd: base }); }
        catch (e) {
          if (tmp) rmSync(tmp, { recursive: true, force: true });
          log('clearsky: sandbox door acli -> refused (new ticket)');
          return reply(1, '', unread.length ? `Clearsky: can't read ${[...new Set(unread)].join(', ')}: acli gets files only from this chat's folders and $TMPDIR.\n` : `Clearsky: ${e.message}.\n`);
        }
      }
      // A definition Clearsky wrote itself already has its description as ADF.
      const built = sent !== argv && sent[3] === '--from-json';
      const [bin, args] = tool === 'outside' ? [argv[0], argv.slice(1)] : [bins.acli || 'acli', built ? sent : acliWrites(sent) ? adfArgs(sent, inChat, base, writeFile, { updateFlag }) : sent];
      if (tool === 'acli' && unread.length) {
        if (tmp) rmSync(tmp, { recursive: true, force: true });
        log('clearsky: sandbox door acli -> refused (text file it can\'t read)');
        return reply(1, '', `Clearsky: can't read ${[...new Set(unread)].join(', ')}: acli gets files only from this chat's folders and $TMPDIR. Write it to a file there, and run the command again.\n`);
      }
      if (tool === 'acli' && ok?.ticket) log(`clearsky: new ticket in ${ok.ticket.project}${ok.ticket.version ? `, fix version ${ok.ticket.version}` : ''}`);
      else if (tool === 'acli' && args.some((x, i) => x !== argv[i])) log('clearsky: acli text sent to Jira as ADF');
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
