// Restarting without cutting a chat off: which chats are busy, whether newer code is on disk, and
// the wait until the chats are done.
import { statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import * as localState from '../state.mjs';
import { stopSandbox } from '../sandbox.mjs';
import { logEvent } from '../event-log.mjs';
import * as settings from '../settings.mjs';
import { readRegistry } from '../plugins.mjs';
import { pluginChanges, settingChanges, fileChanges } from '../restart-reasons.mjs';
import { appDir, stateFile, pluginDirs, plugins, userEnvFile } from './config.mjs';
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
  // Every folder of code under these, so a part added later (lib/app/routes) is never missed.
  const newer = (dir, depth = 0) => {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return false; }
    for (const e of entries) {
      if (e.isDirectory()) { if (depth < 4 && e.name !== 'node_modules' && !e.name.startsWith('.') && newer(join(dir, e.name), depth + 1)) return true; continue; }
      try { if (/\.(mjs|html|js|css|json)$/.test(e.name) && statSync(join(dir, e.name)).mtimeMs > startedAt) return true; } catch { /* gone */ }
    }
    return false;
  };
  return ['bin', 'lib', 'web', 'plugins'].some((d) => newer(join(appDir, d)));
}

// What was loaded at start, to tell what a restart would change (lib/restart-reasons.mjs).
const loaded = {
  plugins: readRegistry(pluginDirs.registry).plugins,
  settings: Object.fromEntries(Object.keys(settings.FIELDS).map((k) => [k, process.env[k] || ''])),
  file: settings.readEnvFile(userEnvFile),
};
const pluginLabel = (n) => plugins.sources.get(n)?.label || n;
// Why a restart is needed now, newest code first; empty when nothing waits for one.
export function restartReasons() {
  return [
    ...(updateReady() ? [{ kind: 'code', name: 'clearsky', text: 'Newer Clearsky code on disk' }] : []),
    ...pluginChanges(loaded.plugins, readRegistry(pluginDirs.registry).plugins, pluginLabel),
    ...settingChanges(loaded.settings, process.env, settings.FIELDS),
    ...fileChanges(loaded.file, settings.readEnvFile(userEnvFile), process.env),
  ];
}
// What /api/restart answers: a restart waiting, the chats it waits for, and why one is needed.
export const restartStatus = () => {
  const reasons = restartReasons();
  return { pending: restart.pending, busy: busyChats(), updateReady: reasons.some((r) => r.kind === 'code'), reasons, startedAt: new Date(startedAt).toISOString() };
};

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
    // A supervisor (systemd, the demo) starts us again; a moment first, so the answer to Restart gets out.
    if (process.env.CLEARSKY_SUPERVISED === '1') { setTimeout(() => process.exit(75), 200); return; }
    spawn(process.execPath, process.argv.slice(1), { detached: true, stdio: 'inherit', cwd: process.cwd(),
      env: { ...process.env, CLEARSKY_STARTED_BY: `restart (${restart.pending.force ? 'Restart now' : 'when idle'}, ${busyNow} busy)` } }).unref();
    setTimeout(() => process.exit(0), 200);
  };
  restart.timer = setInterval(check, 3000);
  check();
  return restart.pending;
}
