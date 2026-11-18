// Routes for setting Clearsky up: the pages themselves, settings, team packs, logins, doctor,
// restart and the demo.
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { sep } from 'node:path';
import * as settings from '../../settings.mjs';
import { makeContext } from '../../sources.mjs';
import { wslInfo } from '../../wsl.mjs';
import { logEvent } from '../../event-log.mjs';
import { startDemo, isDemo } from '../../demo.mjs';
import { suggestions as doctorSuggestions, ready as doctorReady } from '../../doctor.mjs';
import { joinSummary, readTeam } from '../../team.mjs';
import { appDir, userEnvFile, vpn, config, tracker, saveSettings, plugins } from '../config.mjs';
import { vmQueue } from '../chat-builds.mjs';
import { joinTeam, makeTeamPack, machineChecks, firstRun, settingsStatus, startSourceLogin } from '../setup.mjs';
import { restart, chatsBusy, restartStatus, restartWhenIdle } from '../restart.mjs';
import { html } from '../page.mjs';
import { readJson, json, NEXT } from '../http.mjs';

// Changes: POST only, and the server has checked the page's token before it asks here.
export async function post({ req, res, url }) {
  if (url.pathname === '/api/restart') {
    const { maxWaitMinutes, force } = await readJson(req).catch(() => ({}));
    logEvent(`restart asked (${force === true ? 'Restart now' : 'when idle'}), ${chatsBusy()} busy chat(s)${restart.pending ? ', one already waiting' : ''}`);
    return json(res, 200, { restart: restartWhenIdle({ maxWaitMinutes: Math.min(Math.max(Number(maxWaitMinutes) || 60, 1), 240), force: force === true }) });
  }
  // A plugin with several logins (one per Grafana environment): log in to one, or out.
  const multi = url.pathname.match(/^\/api\/source\/([a-z][a-z0-9-]+)\/logins$/);
  if (multi) {
    const p = plugins.sources.get(multi[1]);
    const { id, action } = await readJson(req);
    if (!p?.logins || typeof id !== 'string') return json(res, 404, { error: 'no such login' });
    try {
      const r = action === 'stop' ? await p.logins.stop?.(id, makeContext(p).env) : await p.logins.start(id, makeContext(p).env);
      return json(res, 200, { ok: true, detail: r?.detail || '', ...await settingsStatus() });
    } catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (url.pathname === '/api/settings') {
    saveSettings(await readJson(req));
    vmQueue.pump(); // more VMs at once: whoever waits starts now
    return json(res, 200, await settingsStatus());
  }
  // Join a team pack, or fetch the one you joined again (from: empty).
  if (url.pathname === '/api/team/join') {
    const { from } = await readJson(req);
    const src = String(from || readTeam(dirname(userEnvFile))?.from || '').trim();
    if (!src) return json(res, 400, { error: 'give the team pack: a git repo, an https link or a file' });
    if (isDemo()) return json(res, 400, { error: 'not in the demo' });
    try { const r = await joinTeam(src); return json(res, 200, { name: r.name, summary: joinSummary(r), result: r }); }
    catch (e) { return json(res, 400, { error: e.message }); }
  }
  // Make a team pack: a new folder with the pack, a README for colleagues, skills and plugins.
  if (url.pathname === '/api/team/scaffold') {
    if (isDemo()) return json(res, 400, { error: 'not in the demo' });
    const b = await readJson(req);
    const dir = resolve(String(b.dir || '').trim().replace(/^~(?=\/|\\|$)/, homedir()));
    if (!String(b.dir || '').trim() || !dir.startsWith(homedir() + sep)) return json(res, 400, { error: 'pick a folder in your home folder' });
    try { return json(res, 200, makeTeamPack({ dir, name: String(b.name || '').trim(), repo: String(b.repo || '').trim(), jiraSite: String(b.jiraSite || '').trim(), links: !!b.links })); }
    catch (e) { return json(res, 400, { error: e.message }); }
  }
  // Try with demo data: the demo on a port of its own; the page opens it in a new tab.
  if (url.pathname === '/api/demo/start') {
    if (isDemo()) return json(res, 400, { error: 'this is the demo already' });
    try { const d = await startDemo(); return json(res, 200, { url: d.url }); } catch (e) { return json(res, 500, { error: e.message }); }
  }
  // Leave demo: the demo stops itself (and its made-up home folder goes with it).
  if (url.pathname === '/api/demo/stop') {
    if (!isDemo()) return json(res, 400, { error: 'not the demo' });
    json(res, 200, { ok: true });
    setTimeout(() => process.exit(0), 200);
    return;
  }
  if (url.pathname === '/api/login/github') return json(res, 200, await settings.githubLogin());
  if (url.pathname === '/api/login/jira') return json(res, 200, await settings.jiraLogin(config.jira.acli));
  const login = url.pathname.match(/^\/api\/source\/([a-z][a-z0-9-]+)\/login$/);
  if (login) {
    const p = plugins.sources.get(login[1]);
    if (!p?.login) return json(res, 404, { error: 'no such login' });
    startSourceLogin(p);
    return json(res, 200, await settingsStatus());
  }
  return NEXT;
}

// Reads, and the pages themselves.
export async function get({ res, url, page, welcomePage, settingsPage }) {
  if (url.pathname === '/api/settings') return json(res, 200, await settingsStatus());
  if (url.pathname === '/api/vpn') return json(res, 200, await vpn.check(url.searchParams.has('now')));
  if (url.pathname === '/settings') return html(res, settingsPage);
  // The first-run welcome: what this machine has, the logins, and your work, in three steps.
  if (url.pathname === '/welcome') return html(res, welcomePage);
  if (url.pathname === '/api/team') return json(res, 200, { team: readTeam(dirname(userEnvFile)) });
  if (url.pathname === '/api/doctor') {
    const [list, hints] = await Promise.all([machineChecks(), doctorSuggestions({ acliBin: config.jira.acli })]);
    return json(res, 200, { checks: list, ready: doctorReady(list), suggestions: hints, platform: process.platform, wsl: wslInfo(),
      tracker: tracker(), values: { TRACKER: process.env.TRACKER || '', GITHUB_ORGS: process.env.GITHUB_ORGS || '', CLEARSKY_STANDUP_TIME: process.env.CLEARSKY_STANDUP_TIME || '', CLEARSKY_WORKDAYS: process.env.CLEARSKY_WORKDAYS || '' } });
  }
  // The app window's manifest and icons (Clearsky in its own window: `clearsky app`).
  const asset = { '/manifest.webmanifest': 'application/manifest+json', '/icon.svg': 'image/svg+xml', '/icon-192.png': 'image/png', '/icon-512.png': 'image/png' }[url.pathname];
  if (asset) {
    res.writeHead(200, { 'Content-Type': asset, 'Cache-Control': 'max-age=3600' });
    return res.end(readFileSync(join(appDir, 'web', url.pathname.slice(1))));
  }
  if (url.pathname === '/favicon.ico') { res.writeHead(302, { Location: '/icon.svg' }); return res.end(); }
  if (url.pathname === '/api/restart') return json(res, 200, restartStatus());
  if (url.pathname === '/' || url.pathname === '/index.html') {
    // The very first start, with nothing set up yet: the welcome page first.
    if (firstRun()) { res.writeHead(302, { Location: '/welcome' }); return res.end(); }
    return html(res, page);
  }
  return NEXT;
}
