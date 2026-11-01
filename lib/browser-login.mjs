// Log in to a web app in a real browser window (its own SSO, MFA, whatever it uses) and keep the
// cookie it sets. Opens your Chrome-type browser with a fresh throw-away profile and the DevTools
// port on, waits until `pick(cookies)` finds the login, then closes the window. Nothing to install.

import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { findBrowser } from './browser.mjs';

async function devtools(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('could not reach the browser')); });
  let id = 0;
  const waiting = new Map();
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    const w = waiting.get(msg.id);
    if (!w) return;
    waiting.delete(msg.id);
    msg.error ? w.reject(new Error(msg.error.message)) : w.resolve(msg.result);
  };
  ws.onclose = () => { for (const w of waiting.values()) w.reject(new Error('the browser window was closed')); waiting.clear(); };
  return {
    send: (method, params = {}) => new Promise((resolve, reject) => {
      if (ws.readyState !== WebSocket.OPEN) return reject(new Error('the browser window was closed'));
      waiting.set(++id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    }),
    close: () => ws.close(),
  };
}

// Resolves with what `pick(cookies)` returns once it returns something.
export async function cookieLogin({ url, pick, browser = findBrowser(), timeoutMs = 10 * 60_000 }) {
  if (!browser) throw new Error('No Chrome or Chromium found. Install one, or set CLEARSKY_BROWSER to its path.');
  const profile = mkdtempSync(join(tmpdir(), 'clearsky-login-'));
  const proc = spawn(browser, [`--user-data-dir=${profile}`, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
    '--no-first-run', '--no-default-browser-check', '--disable-sync', url], { stdio: 'ignore' });
  let exited = false;
  proc.on('exit', () => { exited = true; });
  proc.on('error', () => { exited = true; });
  let dt;
  try {
    const deadline = Date.now() + timeoutMs;
    const portFile = join(profile, 'DevToolsActivePort');
    while (!existsSync(portFile) || readFileSync(portFile, 'utf8').split('\n').length < 2) {
      if (exited) throw new Error(`${browser} did not start`);
      if (Date.now() > deadline) throw new Error('the browser did not start in time');
      await sleep(200);
    }
    const [port, path] = readFileSync(portFile, 'utf8').split('\n');
    dt = await devtools(`ws://127.0.0.1:${port.trim()}${path.trim()}`);
    while (Date.now() < deadline) {
      const { cookies } = await dt.send('Storage.getCookies');
      const found = pick(cookies);
      if (found) return found;
      await sleep(1000);
    }
    throw new Error('Gave up waiting for the login after 10 minutes');
  } finally {
    await dt?.send('Browser.close').catch(() => {});
    dt?.close();
    if (!exited) proc.kill();
    await sleep(300);
    rmSync(profile, { recursive: true, force: true });
  }
}
