// Clearsky with made-up data (scripts/demo/run.mjs): `clearsky try`, and Settings → General →
// Try with demo data. It runs on a port of its own, in a throw-away home folder, so nothing of
// yours is read or shown. Good for showing Clearsky to others, and for trying it before you log in.

import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const DEMO_SCRIPT = join(here, '..', 'scripts', 'demo', 'run.mjs');
export const demoPort = (env = process.env) => Number(env.CLEARSKY_DEMO_PORT) || 7790;
export const demoUrl = (port = demoPort()) => `http://127.0.0.1:${port}/`;
export const isDemo = (env = process.env) => env.CLEARSKY_DEMO === '1';

// Whether a Clearsky answers on that port.
export const isUp = (port) => fetch(`http://127.0.0.1:${port}/api/restart`, { signal: AbortSignal.timeout(1500) }).then((r) => r.ok, () => false);

export async function waitUp(port, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await isUp(port)) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

// Start the demo unless it's already running. In the foreground it shares this terminal (Ctrl+C
// stops it); otherwise it runs on its own until "Leave demo" in its menu stops it.
export async function startDemo({ port = demoPort(), foreground = false, node = process.execPath } = {}) {
  if (await isUp(port)) return { url: demoUrl(port), already: true, child: null };
  const child = spawn(node, [DEMO_SCRIPT, String(port)], foreground
    ? { stdio: 'inherit' }
    : { stdio: 'ignore', detached: true });
  if (!foreground) child.unref();
  const exited = new Promise((r) => child.once('exit', () => r(false)));
  const ok = await Promise.race([waitUp(port), exited]);
  if (!ok) { try { child.kill(); } catch {} throw new Error(`the demo didn't start on port ${port}`); }
  return { url: demoUrl(port), already: false, child };
}
