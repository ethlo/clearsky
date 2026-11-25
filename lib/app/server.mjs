// The server: one process on 127.0.0.1 that sends the page and answers its requests. It checks who
// asks (this machine's own names, this page's token), then hands the request to the routes by area
// (lib/app/routes).
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { vmSupport, reapOrphans } from '../vm.mjs';
import * as memory from '../memory.mjs';
import { logEvent } from '../event-log.mjs';
import { isDemo } from '../demo.mjs';
import { crossSite } from '../page-security.mjs';
import { appDir, userEnvFile, config } from './config.mjs';
import { loadSourceCache } from './work.mjs';
import { jobs, jobEnded } from './chat.mjs';
import { teamWaiting } from './setup.mjs';
import { startPolling, keepLoginsAlive } from './attention.mjs';
import { restart, chatsBusy } from './restart.mjs';
import { startHandoffs } from './handoffs.mjs';
import { startSchedules } from './schedules.mjs';
import { startPush } from './push.mjs';
import { demoMark, buildPage } from './page.mjs';
import { json, NEXT } from './http.mjs';
import * as setupRoutes from './routes/setup.mjs';
import * as workRoutes from './routes/work.mjs';
import * as ticketsRoutes from './routes/tickets.mjs';
import * as chatRoutes from './routes/chat.mjs';
import * as pluginsRoutes from './routes/plugins.mjs';

// A token kept in a file only you can read: made once, read again after a restart.
function localToken(file) {
  try { const t = readFileSync(file, 'utf8').trim(); if (/^[0-9a-f]{36}$/.test(t)) return t; } catch {}
  const t = randomBytes(18).toString('hex');
  try { mkdirSync(dirname(file), { recursive: true, mode: 0o700 }); writeFileSync(file, t, { mode: 0o600 }); } catch {}
  return t;
}

// The routes, by what they are for (lib/app/routes): each group answers its own and says NEXT to the rest.
const AREAS = [setupRoutes, workRoutes, ticketsRoutes, chatRoutes, pluginsRoutes];

export function serve() {
  // A bug in a library (srt's proxy, say) shouldn't take the dashboard and every chat down with it.
  process.on('uncaughtException', (e) => logEvent(`unexpected error, still running: ${e?.stack || e}`));
  logEvent(`started, pid ${process.pid}, by ${process.env.CLEARSKY_STARTED_BY || (process.env.CLEARSKY_SUPERVISED === '1' ? 'systemd' : 'hand or app window')}`, { echo: false });
  delete process.env.CLEARSKY_STARTED_BY;
  // Errors go to the log file too: a server started from the app window has no terminal.
  const err0 = console.error.bind(console);
  console.error = (...a) => { err0(...a); logEvent(a.map(String).join(' ').replace(/^clearsky: /, 'error: ').slice(0, 2000), { echo: false }); };
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.once(sig, () => { logEvent(`stopped by ${sig}, ${chatsBusy()} busy chat(s)`, { echo: false }); process.exit(0); });
  loadSourceCache(join(dirname(userEnvFile), 'sources-cache.json'));
  if (!isDemo()) teamWaiting();
  // Every state-changing request must carry this token and come from this origin, so other
  // websites open in the browser can't change settings or start logins. It's kept across
  // restarts so an open page keeps working.
  const csrf = localToken(join(dirname(userEnvFile), 'csrf'));
  // Copilot's memory folder exists from the start, so every chat can read the file once you save a note.
  try { mkdirSync(memory.memoryDir(), { recursive: true, mode: 0o700 }); } catch { /* read-only home: no memory */ }
  const page = buildPage(csrf);
  const welcomePage = demoMark(readFileSync(join(appDir, 'web', 'welcome.html'), 'utf8')).replaceAll('__CSRF__', csrf)
    .replace('/*__CSS__*/', () => readFileSync(join(appDir, 'web', 'css', 'app.css'), 'utf8'));
  const settingsPage = demoMark(readFileSync(join(appDir, 'web', 'settings.html'), 'utf8')).replace('__CSRF__', csrf)
    .replace('/*__CSS__*/', () => readFileSync(join(appDir, 'web', 'css', 'app.css'), 'utf8'))
    .replace('/*__TALK__*/', () => readFileSync(join(appDir, 'web', 'js', '12-talk.js'), 'utf8')); // 🎤 on its text boxes
  // A container publishes its port to another one on the host (CLEARSKY_PUBLIC_PORT), and the
  // browser then names that port.
  const ports = [...new Set([config.port, Number(process.env.CLEARSKY_PUBLIC_PORT) || config.port])];
  const origins = new Set(ports.flatMap((p) => [`http://127.0.0.1:${p}`, `http://localhost:${p}`]));

  // Only answer to this machine's own names, so a web page can't reach the API through a
  // DNS name it controls that points here.
  const hosts = new Set(ports.flatMap((p) => [`127.0.0.1:${p}`, `localhost:${p}`]));

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (!hosts.has(req.headers.host)) return json(res, 421, { error: 'wrong host' });
    // The API answers this page, a command line and Clearsky itself: not another site's request
    // from your browser (lib/page-security.mjs).
    if (crossSite(req, url.pathname)) return json(res, 403, { error: 'forbidden' });
    try {
      const ask = { req, res, url, page, welcomePage, settingsPage };
      if (req.method === 'POST') {
        if (req.headers['x-clearsky-token'] !== csrf || (req.headers.origin && !origins.has(req.headers.origin))) {
          return json(res, 403, { error: 'forbidden' });
        }
        for (const area of AREAS) if (area.post && await area.post(ask) !== NEXT) return;
        return json(res, 404, { error: 'not found' });
      }
      for (const area of AREAS) if (area.get && await area.get(ask) !== NEXT) return;
      res.writeHead(404).end('Not found');
    } catch (e) {
      json(res, e instanceof SyntaxError || /^(unknown setting|.* must |the |workday)/.test(e.message) ? 400 : 500, { error: e.message });
    }
  });
  restart.server = server;
  // Right after a restart the old server may still hold the port for a moment.
  let tries = 0;
  server.on('error', (e) => {
    if (e.code !== 'EADDRINUSE' || ++tries > 20) throw e;
    setTimeout(() => server.listen(config.port, config.bind), 500);
  });
  server.once('listening', () => {
    const shown = Number(process.env.CLEARSKY_PUBLIC_PORT) || config.port; // the port on your machine, in a container
    console.log(`clearsky: http://127.0.0.1:${shown}  (settings and logins: http://127.0.0.1:${shown}/settings)`);
    if (process.env.CLEARSKY_POLL_MINUTES !== '0') startPolling();
    keepLoginsAlive();
    startHandoffs(csrf);
    startSchedules(csrf);
    startPush();
    // Job results a restart kept from their chats (and jobs it cut short): they go out now.
    const owed = jobs.load();
    setTimeout(() => {
      if (owed.length) logEvent(`telling ${owed.length} chat(s) about background jobs from before the restart`);
      for (const j of owed) jobEnded(j);
    }, isDemo() ? 0 : 5000).unref();
    // Only once this server holds the port, so a second Clearsky can't stop the first one's VMs.
    if (vmSupport().ok) {
      const n = reapOrphans().length;
      if (n) logEvent(`stopped ${n} VM${n > 1 ? 's' : ''} left running by an earlier Clearsky`);
    }
  });
  server.listen(config.port, config.bind);
}
