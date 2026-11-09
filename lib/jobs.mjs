// Background jobs: a chat's long commands (a full build, `vm` tests, waiting for CI) run here,
// outside the chat's turn. Copilot starts one with `bg <command>` (scripts/sandbox-bin/bg) and
// ends its turn; when the job ends Clearsky wakes the chat with how it went and the last lines
// of its output. A turn that sits waiting on a long command is how chats used to stop: the turn
// ran into a limit, or Copilot gave up on the wait.
// - Where it runs is the chat's own fence: 'sandbox' (a new process in the chat's sandbox, same
//   folders and hosts), 'vm' (the chat's VM, through the VM line: lib/vm-queue.mjs) or 'outside'
//   (your machine, after your OK at the door: lib/broker.mjs). This file only keeps the books.
// - The list is kept on disk, so a result that hasn't reached its chat yet, or a job a restart
//   cut short, still reaches it after Clearsky starts again (`told` says it has).
// - Output goes to a log file in the chat's temporary folder, where the sandbox can read it.

import { mkdirSync, readFileSync, writeFileSync, renameSync, createWriteStream, openSync, readSync, fstatSync, closeSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

export const WHERE = ['sandbox', 'vm', 'outside'];
export const JOBS_PER_CHAT = 3; // running at once in one chat
const KEEP = 200; // jobs remembered (with their logs), newest first
const ENDED = new Set(['done', 'failed', 'stopped', 'interrupted']);

export class Jobs {
  // run(job, out, err, signal) → Promise<exit code>: starts the job where it says (bin/clearsky.mjs).
  // logDir: a folder, or a function giving it. onEnd(job): a job ended, or (after a restart) one ended without its chat being told.
  constructor({ file, logDir, run, onEnd = () => {}, now = Date.now, perChat = JOBS_PER_CHAT }) {
    Object.assign(this, { file, logDir, run, onEnd, now, perChat });
    this.jobs = [];
    this.live = new Map(); // id → AbortController, for the ones running in this process
    this.closing = false;
  }

  // Read the list. A job that was running when Clearsky stopped didn't finish: it's 'interrupted',
  // and like any ended job whose chat wasn't told, it's handed to onEnd once more.
  load() {
    try { this.jobs = JSON.parse(readFileSync(this.file, 'utf8')).jobs || []; } catch { this.jobs = []; }
    const owed = [];
    for (const j of this.jobs) {
      if (!ENDED.has(j.state)) Object.assign(j, { state: 'interrupted', endedAt: new Date(this.now()).toISOString(), told: false });
      if (!j.told) owed.push(j);
    }
    this.save();
    return owed;
  }

  save() {
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ jobs: this.jobs }, null, 1), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch { /* read-only home: the jobs still run, they just don't outlive this process */ }
  }

  list(chat) { return this.jobs.filter((j) => !chat || j.chat === chat); }
  running(chat) { return this.jobs.filter((j) => j.state === 'running' && (!chat || j.chat === chat)); }
  get(id) { return this.jobs.find((j) => j.id === id) || null; }

  // Start one. `ctx` is what it takes to wake the chat later (its mode, model, folder).
  start({ chat, where, argv, cwd, ctx = null }) {
    if (!WHERE.includes(where)) throw new Error(`can't run a job in "${where}"`);
    if (!Array.isArray(argv) || !argv.length || !argv.every((a) => typeof a === 'string')) throw new Error('no command');
    if (this.closing) throw new Error('Clearsky is restarting; start it again in a minute');
    if (this.running(chat).length >= this.perChat) throw new Error(`this chat already has ${this.perChat} jobs running; wait for one, or stop one with \`jobs stop <id>\``);
    const id = `j${randomBytes(3).toString('hex')}`;
    const logDir = typeof this.logDir === 'function' ? this.logDir() : this.logDir;
    mkdirSync(logDir, { recursive: true, mode: 0o700 });
    const job = { id, chat, where, argv, cwd, state: 'running', code: null, startedAt: new Date(this.now()).toISOString(), endedAt: null,
      log: join(logDir, `${id}.log`), told: false, ctx };
    this.jobs.unshift(job);
    this.#prune();
    this.save();
    const stream = createWriteStream(job.log, { mode: 0o600 });
    const write = (d) => { if (!stream.destroyed) stream.write(d); };
    const ac = new AbortController();
    this.live.set(id, ac);
    let running;
    try { running = Promise.resolve(this.run(job, write, write, ac.signal)); } catch (e) { running = Promise.reject(e); }
    running
      .then((code) => (typeof code === 'number' ? code : 1), (e) => { write(`\nClearsky: the job failed: ${e.message}\n`); return 1; })
      .then((code) => {
        this.live.delete(id);
        stream.end();
        if (this.closing) return; // Clearsky is going: the next one says it was interrupted
        Object.assign(job, { state: ac.signal.aborted ? 'stopped' : code === 0 ? 'done' : 'failed', code, endedAt: new Date(this.now()).toISOString() });
        this.save();
        try { this.onEnd(job); } catch { /* the chat hears about it when it can */ }
      });
    return job;
  }

  stop(id, chat = null) {
    const j = this.get(id);
    if (!j || (chat && j.chat !== chat)) return false;
    const ac = this.live.get(id);
    if (!ac) return false;
    ac.abort();
    return true;
  }

  stopChat(chat) { for (const j of this.running(chat)) this.stop(j.id); }

  // Its chat was told how it ended.
  told(id) { const j = this.get(id); if (j && !j.told) { j.told = true; this.save(); } }

  // The last `lines` lines of a job's output, at most `max` bytes of them.
  tail(id, lines = 40, max = 64 * 1024) { const j = this.get(id); return j ? tailOf(j.log, lines, max) : ''; }

  #prune() {
    for (const j of this.jobs.splice(KEEP)) { if (!this.live.has(j.id)) rmSync(j.log, { force: true }); else this.jobs.push(j); }
  }
}

export function tailOf(file, lines = 40, max = 64 * 1024) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size, n = Math.min(size, max);
    const buf = Buffer.alloc(n);
    readSync(fd, buf, 0, n, size - n);
    // Progress bars and spinners redraw one line with \r: keep what's left on it.
    const text = buf.toString('utf8').split('\n').map((l) => l.split('\r').filter(Boolean).pop() || '').join('\n').replace(/\n+$/, '');
    return text.split('\n').slice(-lines).join('\n');
  } catch { return ''; } finally { if (fd != null) closeSync(fd); }
}

export const shellLine = (argv) => argv.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ');
export function took(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}
const WHERE_TEXT = { sandbox: 'in the sandbox', vm: 'in the VM', outside: 'outside the sandbox' };

// What the chat is told when a job ends: how, after how long, the end of its output, where the
// rest is. `tilde` shortens the log's path.
export function jobReport(job, tail, { tilde = (p) => p } = {}) {
  const cmd = shellLine(job.argv);
  const ms = Date.parse(job.endedAt) - Date.parse(job.startedAt);
  const after = took(ms);
  const how = job.state === 'done' ? `finished: exit 0, after ${after}.`
    : job.state === 'failed' ? `failed: exit ${job.code}, after ${after}.`
      : job.state === 'stopped' ? `was stopped before it finished, after ${after}.`
        : `was cut short after ${after}: Clearsky restarted while it ran. Start it again with \`bg\` if you still need it.`;
  return `Background job ${job.id} (\`${cmd}\`, ${WHERE_TEXT[job.where] || job.where}) ${how}`
    + (tail ? `\nThe last lines of its output:\n\`\`\`\n${tail.replace(/```/g, '`​``')}\n\`\`\`` : '\nIt wrote no output.')
    + `\nAll of it: ${tilde(job.log)}. Go on with the task from here.`;
}

// For the page: no log paths outside the chat, no wake context.
export function jobView(j, { tilde = (p) => p, now = Date.now() } = {}) {
  return { id: j.id, where: j.where, command: shellLine(j.argv), cwd: tilde(j.cwd || ''), state: j.state, code: j.code,
    startedAt: j.startedAt, endedAt: j.endedAt, ms: (j.endedAt ? Date.parse(j.endedAt) : now) - Date.parse(j.startedAt), told: !!j.told };
}
