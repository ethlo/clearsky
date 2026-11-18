// Restarting without cutting a chat off: which chats are busy, whether newer code is on disk, and
// the wait until the chats are done.
import { statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import * as localState from '../state.mjs';
import { stopSandbox } from '../sandbox.mjs';
import { logEvent } from '../event-log.mjs';
import { appDir, stateFile } from './config.mjs';
import { acpChats, sessionsCache } from './chat-env.mjs';
import { jobs } from './chat.mjs';
import { needsYou } from './chat-sessions.mjs';

// Restart without cutting off Copilot: wait until no chat here is working or waiting for an OK,
// then start a fresh server (or, under systemd, exit for it to restart us). Idle chats carry on
// after the restart, because a new message reopens the session.
export const restart = { pending: null, timer: null, server: null };
// A restart waits for chats started here that are mid-answer or waiting on your Allow/Deny.
// Chats done with their turn, and Copilot in a terminal or editor, don't hold it up.
// A background job running holds it up too (Restart now cuts it short; its chat hears so after).
export const chatsBusy = () => [...acpChats.values()].filter((c) => c.busy || c.waiting.size).length + jobs.running().length;
export function busyChats() {
  const names = localState.sessionNames(stateFile), titles = new Map((sessionsCache?.data || []).map((x) => [x.id, x.title]));
  return [...acpChats.entries()].filter(([, c]) => c.busy || c.waiting.size)
    .map(([id, c]) => ({ id, title: names[id] || titles.get(id) || 'Copilot chat', status: needsYou(c) ? 'needs-you' : 'working' }));
}

// Whether Clearsky's files changed since this process started (a pull), so a restart would update it.
const startedAt = Date.now();
export function updateReady() {
  const root = appDir;
  let bundled = [];
  try { bundled = readdirSync(join(root, 'plugins')).flatMap((n) => [`plugins/${n}`, `plugins/${n}/lib`]); } catch { /* none */ }
  for (const dir of ['bin', 'lib', 'lib/modules', 'web', 'web/js', 'web/css', ...bundled]) {
    let names = [];
    try { names = readdirSync(join(root, dir)); } catch { continue; }
    for (const n of names) {
      try { if (/\.(mjs|html|js|css)$/.test(n) && statSync(join(root, dir, n)).mtimeMs > startedAt) return true; } catch { /* gone */ }
    }
  }
  return false;
}
export function restartWhenIdle({ maxWaitMinutes = 60, force = false } = {}) {
  // "Restart now" while a restart waits: stop waiting.
  if (restart.pending) { if (force) { restart.pending.force = true; restart.check?.(); } return restart.pending; }
  restart.pending = { since: new Date().toISOString(), until: new Date(Date.now() + maxWaitMinutes * 6e4).toISOString(), busy: chatsBusy(), force };
  const check = restart.check = () => {
    if (!restart.pending.force && chatsBusy()) {
      if (Date.now() > Date.parse(restart.pending.until)) { logEvent(`restart given up, ${chatsBusy()} chat(s) still working`); clearInterval(restart.timer); restart.pending = null; }
      return;
    }
    clearInterval(restart.timer);
    const busyNow = chatsBusy();
    logEvent(`restarting (${restart.pending.force ? 'Restart now' : 'when idle'}, ${busyNow} busy chat(s) stopped)`);
    jobs.closing = true; // what's still running is 'interrupted' for the next Clearsky, which tells its chats
    for (const c of acpChats.values()) { c.agent.close(); c.vm?.stop(); }
    stopSandbox().catch(() => {});
    restart.server?.close();
    if (process.env.CLEARSKY_SUPERVISED === '1') process.exit(75); // a supervisor (systemd) starts us again
    spawn(process.execPath, process.argv.slice(1), { detached: true, stdio: 'inherit', cwd: process.cwd(),
      env: { ...process.env, CLEARSKY_STARTED_BY: `restart (${restart.pending.force ? 'Restart now' : 'when idle'}, ${busyNow} busy)` } }).unref();
    setTimeout(() => process.exit(0), 200);
  };
  restart.timer = setInterval(check, 3000);
  check();
  return restart.pending;
}
