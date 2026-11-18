#!/usr/bin/env node
// clearsky: one view of what needs your attention on GitHub and Jira, and in what plugins add (Slack, School…).
// Zero dependencies, Node 22+. See README.md.
//
//   clearsky              print a Markdown summary
//   clearsky --json       print the raw data as JSON (for Copilot skills / scripts)
//   clearsky serve        serve the dashboard on http://127.0.0.1:7777

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync, statSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import * as settings from '../lib/settings.mjs';
import * as localState from '../lib/state.mjs';
import * as copilot from '../lib/copilot.mjs';
import { sessionUsage } from '../lib/copilot-events.mjs';
import { branchesFor } from '../lib/branches.mjs';
import { vmSupport, reapOrphans, vmsLoad } from '../lib/vm.mjs';
import { pruneMirror } from '../lib/registry-mirror.mjs';
import { jobView, tailOf } from '../lib/jobs.mjs';
import { logWrite, readWrites } from '../lib/agent-log.mjs';
import { checkFolder } from '../lib/chat-folders.mjs';
import { checkFileRef, findFiles, fileRefLine } from '../lib/file-refs.mjs';
import * as memory from '../lib/memory.mjs';
import { sshHosts } from '../lib/ssh-hosts.mjs';
import { buildRepos } from '../lib/builds.mjs';
import { allCreditRecords, creditTotals, costRates, costOf, liveRate } from '../lib/credit-usage.mjs';
import { disclosureLine } from '../lib/disclosure.mjs';
import { buildMap } from '../lib/map.mjs';
import { attentionItems } from '../lib/notify.mjs';
import { makeContext } from '../lib/sources.mjs';
import { removePlugin, updatePlugin, checkPlugin, bundledDir, codeDir } from '../lib/plugins.mjs';
import { findBrowser } from '../lib/browser.mjs';
import { wslInfo, loginEnv } from '../lib/wsl.mjs';
import { readLinks, saveLinks, parseBookmarks, mergeLinks } from '../lib/links.mjs';
import { logEvent } from '../lib/event-log.mjs';
import { startDemo, demoPort, isDemo } from '../lib/demo.mjs';
import { suggestions as doctorSuggestions, doctorText, ready as doctorReady } from '../lib/doctor.mjs';
import { joinSummary, readTeam, exportPack } from '../lib/team.mjs';
import { NEW_TASK_HINT, cleanNewTask, newTaskPrompt } from '../lib/new-task.mjs';
import { TRACKERS } from '../lib/tracker.mjs';
import { untilde } from '../lib/util.mjs';
import { pageHeaders, COMMON_HEADERS, crossSite } from '../lib/page-security.mjs';
import { AGENTS } from '../lib/agents.mjs';
import { readHandoffs, saveHandoffs, addHandoff, updateHandoff } from '../lib/handoff.mjs';
import { srtInstalled } from '../lib/doctor.mjs';
import { isBot, openThreads, myPrStatus } from '../lib/modules/github.mjs';
import { sortVersions } from '../lib/modules/jira.mjs';
import { PROJECT_KEY, starredProjects, versionSummary } from '../lib/modules/jira.mjs';
import { appDir, userEnvFile, stateFile, agentLogFile, agentFilesFile, vpn, list, config, tracker, backend, whenSettingsChange, saveSettings, pluginDirs, plugins, standupOn, nextStandup } from '../lib/app/config.mjs';
import { ghModule, gql, reviewerOptions, requestReviews, mergePr, ghCliToken, jiraModule, REPO_NAME, starredRepos, jiraDebug, issuePreview } from '../lib/app/services.mjs';
import { hiddenCalendars, SOURCES, linksFile, moduleManifests, workItemsOf, sourceCache, STALE_MAX, dataVersion, source, loadSourceCache, withOwn, collect, toMarkdown } from '../lib/app/work.mjs';
import { sessionAgent, copilotCwd, copilotInfo, copilotTmp, acpChats, folderNotes, chatFolders, chatReadRoots, chatRepos, tildeHome, sessionsCache, forgetSessions, codeDirs, findCheckout, worktreeFor, prBranch, isDir, copilotFolders } from '../lib/app/chat-env.mjs';
import { CONTEXT_INTRO, UPDATE_INTRO, PR_HINT, trackerHints, CHOICES_HINT, memoryHint, foldersHint, sandboxHintFor, MSG_MARK, REFS_INTRO, referenceText, validRefs, copilotContext } from '../lib/app/chat-hints.mjs';
import { vmQueue, vmsOverview, IMAGE_CACHE_DIR, imageCacheView } from '../lib/app/chat-builds.mjs';
import { copilotCommands, hintOwed, stopCopilot, jobs, jobEnded, watchdog, readFx, chatCredits, acpTurn, attachCopilot } from '../lib/app/chat.mjs';
import { copilotSessions, ticketPr, itemSessionName, copilotLinks, refKey, copilotHistory } from '../lib/app/chat-sessions.mjs';
import { safeName, isStaged, keepAttachment, chatFile, fileDiff, chatOutputs } from '../lib/app/chat-outputs.mjs';
import { sayCache, standupSay, standup } from '../lib/app/standup.mjs';
import { joinTeam, teamWaiting, makeTeamPack, machineChecks, firstRun, settingsStatus, startSourceLogin } from '../lib/app/setup.mjs';
import { ATTENTION_SOURCES, poller, pluginAttention, withReads, startPolling, keepLoginsAlive } from '../lib/app/attention.mjs';
import { restart, chatsBusy, busyChats, updateReady, restartWhenIdle } from '../lib/app/restart.mjs';
import { pluginList, pendingPlugins, previewPlugin, pluginCommand } from '../lib/app/plugin-admin.mjs';
import { handoffFile, handoffs, startHandoffs } from '../lib/app/handoffs.mjs';
import { restartCommand, openInBrowser, appCommand, dockerCommand } from '../lib/app/commands.mjs';
export { userEnvFile, parseWorkdays, tracker, backend, clock, nextStandup, previousStandup } from '../lib/app/config.mjs';
export { issuePreview } from '../lib/app/services.mjs';
export { hiddenCalendars, planNow, moduleManifests, source, prReadKey, collect, toMarkdown } from '../lib/app/work.mjs';
export { remoteRepo, findCheckout, worktreeFor } from '../lib/app/chat-env.mjs';
export { JIRA_HINT, buildsWhere, buildsHint, typedPart, validRefs } from '../lib/app/chat-hints.mjs';
export { jiraTargets } from '../lib/app/chat-gate.mjs';
export { vmMaven } from '../lib/app/chat-builds.mjs';
export { sessionTitle, linkSessions, itemSessionName } from '../lib/app/chat-sessions.mjs';
export { standupText, standup } from '../lib/app/standup.mjs';
export { pollAttention, keepAliveDelay } from '../lib/app/attention.mjs';
export { isBot, openThreads, myPrStatus };
let jiraProjectsCache = { at: 0, data: null }; // every Jira project you can see, for starring (Versions page)
let ghReposCache = { at: 0, data: null }; // the same with GitHub Issues: repos you can star

// ---------------------------------------------------------------- server

// An item read in full (a school message, say): kept 5 minutes, and served from the kept copy
// for up to 30 while a new read runs behind it, so opening it again is instant.
const detailCache = new Map();
function sourceDetail(p, key, data, force) {
  const k = `${p.name}:${key}`, hit = detailCache.get(k), age = hit ? Date.now() - hit.at : Infinity;
  if (!force && hit?.data && age < 5 * 6e4) return Promise.resolve(hit.data);
  if (!hit?.pending) {
    const pending = Promise.resolve(p.detail(key, makeContext(p), data)).then((d) => { detailCache.set(k, { at: Date.now(), data: d }); return d; })
      .catch((e) => { if (hit?.data) detailCache.set(k, hit); else detailCache.delete(k); throw e; });
    detailCache.set(k, { ...hit, pending });
    if (detailCache.size > 300) detailCache.delete(detailCache.keys().next().value);
    if (!force && hit?.data && age < STALE_MAX) { pending.catch(() => {}); return Promise.resolve(hit.data); }
    return pending;
  }
  return !force && hit.data && age < STALE_MAX ? Promise.resolve(hit.data) : hit.pending;
}

let standupCache = { at: 0, data: null };
let buildsCache = { at: 0, data: null };
whenSettingsChange(() => { detailCache.clear(); standupCache = { at: 0, data: null }; });

// Hover-card details for one pull request.
const prCache = new Map();
export async function prPreview(repo, number) {
  const key = `${repo}#${number}`;
  const hit = prCache.get(key);
  if (hit && Date.now() - hit.at < 5 * 6e4) return hit.data;
  config.github.token ||= await ghCliToken();
  const [owner, name] = repo.split('/');
  const { repository } = await gql(`query($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) { pullRequest(number: $number) {
      title url state isDraft reviewDecision additions deletions changedFiles bodyText updatedAt author { login } } } }`,
  { owner, name, number: Number(number) });
  const pr = repository?.pullRequest;
  if (!pr) throw new Error(`${key} not found`);
  const data = {
    key, url: pr.url, title: pr.title, author: pr.author?.login, draft: pr.isDraft,
    state: pr.state, reviewDecision: pr.reviewDecision, updatedAt: pr.updatedAt,
    size: { additions: pr.additions, deletions: pr.deletions, files: pr.changedFiles },
    description: (pr.bodyText || '').replace(/\s+/g, ' ').trim().slice(0, 600),
  };
  prCache.set(key, { at: Date.now(), data });
  return data;
}

async function readJson(req, max = 64 * 1024) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > max) throw new Error('request too large');
  }
  return body ? JSON.parse(body) : {};
}

// A file from a source, such as a school attachment. It comes from someone else, so it can
// never run as part of this page: PDFs, images and plain text open in the browser, anything
// else is downloaded, and nothing is sniffed or scripted.
const INLINE = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'text/plain']);
export function fileHeaders({ type, name, data }) {
  const inline = INLINE.has(type);
  return {
    'Content-Type': inline ? (type === 'text/plain' ? 'text/plain; charset=utf-8' : type) : 'application/octet-stream',
    'Content-Length': data.length,
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name || 'file')}`,
    'X-Content-Type-Options': 'nosniff',
    // Chrome's PDF viewer doesn't run in a sandbox, and a PDF can't reach this page's scripts.
    'Content-Security-Policy': type === 'application/pdf' ? "default-src 'none'; object-src 'self'" : "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
    'Cache-Control': 'private, no-store',
  };
}

function sendFile(res, file) {
  if (!file?.data) throw new Error('no file');
  res.writeHead(200, fileHeaders(file));
  res.end(file.data);
}

// "1h", "3h", "tomorrow" (the next workday's stand-up), "week", a YYYY-MM-DD date (that
// day's stand-up), or null to unmute.
function muteUntil(span, now = new Date()) {
  if (span == null) return null;
  const hours = String(span).match(/^(\d{1,3})h$/)?.[1];
  if (hours) return new Date(+now + hours * 36e5);
  if (span === 'week') return new Date(+now + 7 * 864e5);
  if (span === 'tomorrow') { const t = new Date(now); t.setDate(t.getDate() + 1); t.setHours(0, 0, 0, 0); return nextStandup(t); }
  if (/^\d{4}-\d{2}-\d{2}$/.test(span)) { const [y, m, d] = span.split('-').map(Number); return standupOn(new Date(y, m - 1, d)); }
  throw new Error('unknown mute time');
}

function localToken(file) {
  try { const t = readFileSync(file, 'utf8').trim(); if (/^[0-9a-f]{36}$/.test(t)) return t; } catch {}
  const t = randomBytes(18).toString('hex');
  try { mkdirSync(dirname(file), { recursive: true, mode: 0o700 }); writeFileSync(file, t, { mode: 0o600 }); } catch {}
  return t;
}

// The page: web/index.html with web/css/app.css and web/js/*.js (in name order, one shared
// scope) put inline, so it stays one request and works offline.
// The demo's pages say so: a "Demo data" badge with Leave demo, so nobody takes it for real.
const demoMark = (html) => (isDemo() ? html.replace('<meta name="theme-color"', '<meta name="demo" content="1">\n<meta name="theme-color"') : html);

export function buildPage(csrf, web = join(appDir, 'web')) {
  const css = readFileSync(join(web, 'css', 'app.css'), 'utf8');
  const js = readdirSync(join(web, 'js')).filter((n) => n.endsWith('.js')).sort()
    .map((n) => readFileSync(join(web, 'js', n), 'utf8')).join('\n');
  return demoMark(readFileSync(join(web, 'index.html'), 'utf8').replace('__CSRF__', csrf)
    .replace('/*__CSS__*/', () => css).replace('/*__JS__*/', () => js));
}

function serve() {
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
  // What the browser may do with each page (lib/page-security.mjs): only its own scripts, no frames.
  // Pages name the agent your chats run in ("Copilot", "Claude Code") where they say __AGENT__.
  const named = new Map();
  const forAgent = (text) => { const k = `${backend().label}\n${text.length}\n${text.slice(0, 64)}`; return named.get(k) || named.set(k, text.replaceAll('__AGENT__', backend().label)).get(k); };
  const html = (res, page) => { const text = forAgent(page); res.writeHead(200, htmlHeaders.get(text) || htmlHeaders.set(text, pageHeaders(text)).get(text)); res.end(text); };
  const htmlHeaders = new Map();
  const json = (res, code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...COMMON_HEADERS });
    res.end(JSON.stringify(body));
  };

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
      if (req.method === 'POST') {
        if (req.headers['x-clearsky-token'] !== csrf || (req.headers.origin && !origins.has(req.headers.origin))) {
          return json(res, 403, { error: 'forbidden' });
        }
        // Plugins (lib/plugins.mjs): look first (what it reaches, before any of its code runs), then add.
        if (url.pathname === '/api/plugins/preview') {
          if (isDemo()) return json(res, 400, { error: 'not in the demo' });
          const { from } = await readJson(req);
          try { return json(res, 200, await previewPlugin(String(from || ''))); } catch (e) { return json(res, 400, { error: e.message }); }
        }
        if (url.pathname === '/api/plugins/add') {
          const { token, trust } = await readJson(req);
          const p = pendingPlugins.get(String(token || ''));
          if (!p) return json(res, 400, { error: 'look at it again first; that preview has run out' });
          pendingPlugins.delete(String(token));
          clearTimeout(p.timer);
          // A new version of one you trusted keeps that trust; one that newly wants out needs your tick.
          try { const r = p.done({ trust: trust === true || p.had?.run === 'inside' }); logEvent(`plugin ${r.name} ${p.had ? `updated to ${r.from}${r.commit ? ` @ ${r.commit.slice(0, 10)}` : ''}` : 'added from ' + r.from} (${r.run === 'inside' ? 'runs inside Clearsky' : 'sandboxed'})`); return json(res, 200, { added: r, ...pluginList() }); }
          catch (e) { return json(res, 400, { error: e.message }); }
        }
        // Is there a newer version? Looks at the repo's tags and branch, without fetching code.
        if (url.pathname === '/api/plugins/check') {
          const { name } = await readJson(req);
          try { return json(res, 200, await checkPlugin(String(name || ''), { paths: pluginDirs })); } catch (e) { return json(res, 400, { error: e.message }); }
        }
        if (url.pathname === '/api/plugins/remove' || url.pathname === '/api/plugins/update') {
          const { name, data } = await readJson(req);
          try {
            const r = url.pathname.endsWith('remove') ? removePlugin(String(name || ''), { paths: pluginDirs, data: data === true }) : await updatePlugin(String(name || ''), { paths: pluginDirs });
            logEvent(`plugin ${r.name} ${url.pathname.endsWith('remove') ? 'removed' : `updated from ${r.from}`}`);
            return json(res, 200, { done: r, ...pluginList() });
          } catch (e) { return json(res, 400, { error: e.message }); }
        }
        if (url.pathname === '/api/restart') {
          const { maxWaitMinutes, force } = await readJson(req).catch(() => ({}));
          logEvent(`restart asked (${force === true ? 'Restart now' : 'when idle'}), ${chatsBusy()} busy chat(s)${restart.pending ? ', one already waiting' : ''}`);
          return json(res, 200, { restart: restartWhenIdle({ maxWaitMinutes: Math.min(Math.max(Number(maxWaitMinutes) || 60, 1), 240), force: force === true }) });
        }
        // End a chat's Copilot. Its conversation stays; the next message resumes it in a new one.
        if (url.pathname === '/api/copilot/close') {
          const { chat } = await readJson(req);
          const c = acpChats.get(String(chat || ''));
          if (c) { stopCopilot(String(chat)); jobs.stopChat(String(chat)); watchdog.forget(String(chat)); c.agent.close(); c.vm?.stop(); acpChats.delete(String(chat)); }
          return json(res, 200, { closed: !!c });
        }
        // The VMs view's Purge: the image cache emptied (a pull running now still finishes).
        if (url.pathname === '/api/vms/image-cache/purge') {
          if (isDemo()) return json(res, 200, { removed: 0, freed: 0 });
          const r = pruneMirror(IMAGE_CACHE_DIR, { all: true });
          return json(res, 200, { ...r, imageCache: imageCacheView(true) });
        }
        if (url.pathname === '/api/vm/stop') {
          const { chat } = await readJson(req);
          const vm = acpChats.get(String(chat || ''))?.vm;
          if (vm && (vm.state !== 'off' || vm.queue?.().position)) { vm.event('Stopped from Clearsky'); vm.stop(); }
          return json(res, 200, { stopped: !!vm });
        }
        // A background job stopped from the chat's side panel.
        if (url.pathname === '/api/copilot/jobs/stop') {
          const { chat, id } = await readJson(req);
          return json(res, 200, { stopped: jobs.stop(String(id || ''), String(chat || '')) });
        }
        // The watchdog paused (or on again) for one chat.
        if (url.pathname === '/api/copilot/watchdog') {
          const { chat, paused } = await readJson(req);
          if (!/^[\w-]{8,64}$/.test(String(chat || ''))) return json(res, 400, { error: 'bad chat' });
          watchdog.pause(String(chat), paused === true);
          return json(res, 200, { watchdog: watchdog.view(String(chat)) });
        }
        if (url.pathname === '/api/copilot/stop') {
          const { chat } = await readJson(req);
          return json(res, 200, { stopped: stopCopilot(String(chat || '')) });
        }
        // Your own name for a Copilot session; it wins over the title Copilot gave it.
        // A folder added to (or taken off) one chat, from its side panel. Its Copilot starts again
        // with it on the next message, resuming the same session.
        if (url.pathname === '/api/copilot/folders') {
          const { chat: id, add, remove } = await readJson(req);
          if (!/^[\w-]{8,64}$/.test(String(id || ''))) return json(res, 400, { error: 'bad chat' });
          let list = localState.sessionFolders(stateFile)[id] || [];
          if (add) {
            const r = checkFolder(add, homedir());
            if (r.error) return json(res, 400, { error: r.error });
            if (!list.includes(r.path)) {
              list = [...list, r.path];
              folderNotes.set(id, `I added ${r.path.replace(homedir(), '~')} to this chat: you can read and change files there now, and review, vm and outside work there too.`);
            }
          }
          if (remove) list = list.filter((f) => f !== untilde(remove));
          localState.setSessionFolders(stateFile, id, list);
          return json(res, 200, { folders: list.map((f) => f.replace(homedir(), '~')) });
        }
        if (url.pathname === '/api/copilot/rename') {
          const { id, title } = await readJson(req);
          if (!/^[\w-]{8,64}$/.test(String(id || '')) || typeof title !== 'string' || !title.trim()) return json(res, 400, { error: 'bad session or title' });
          localState.setSessionName(stateFile, id, title.trim().split('\n')[0]);
          forgetSessions();
          return json(res, 200, { ok: true });
        }
        // Ask people to review one of your PRs, as you (through your GitHub login).
        // A link from the app window, opened in your own browser (where you're logged in).
        if (url.pathname === '/api/open') {
          const { url: u } = await readJson(req);
          if (!/^https?:\/\/[^\s]+$/.test(String(u || ''))) return json(res, 400, { error: 'not a web link' });
          if (process.env.CLEARSKY_IN_CONTAINER === '1') return json(res, 501, { error: 'no desktop in the container' });
          openInBrowser(String(u));
          return json(res, 200, { ok: true });
        }
        if (url.pathname === '/api/pr/request-review') {
          const { repo, number, logins } = await readJson(req);
          if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '') || !/^\d+$/.test(String(number)) || !Array.isArray(logins) || !logins.length || logins.length > 15
            || !logins.every((l) => /^[A-Za-z\d](?:[A-Za-z\d-]{0,38})$/.test(l))) return json(res, 400, { error: 'bad request' });
          if (!config.github.orgs.includes(repo.split('/')[0])) return json(res, 400, { error: 'not one of your work repos' });
          await requestReviews(repo, Number(number), logins);
          localState.setLastReviewers(stateFile, repo, logins);
          localState.logAction(stateFile, `https://github.com/${repo}/pull/${number}`, `Asked ${logins.join(', ')} to review`);
          sourceCache.delete('github');
          return json(res, 200, { ok: true });
        }
        // Merge one of your PRs, as you; only from the button, which asks you first.
        if (url.pathname === '/api/pr/merge') {
          const { repo, number } = await readJson(req);
          if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '') || !/^\d+$/.test(String(number))) return json(res, 400, { error: 'bad request' });
          if (!config.github.orgs.includes(repo.split('/')[0])) return json(res, 400, { error: 'not one of your work repos' });
          try {
            const { method } = await mergePr(repo, Number(number));
            localState.logAction(stateFile, `https://github.com/${repo}/pull/${number}`, `Merged (${method})`);
            sourceCache.delete('github');
            return json(res, 200, { ok: true, method });
          } catch (e) {
            // GitHub says why (a required review or check, a conflict): pass its message on.
            let why = e.message;
            try { why = JSON.parse(e.message.replace(/^[^{]*/, '')).message || why; } catch {}
            return json(res, 409, { error: why });
          }
        }
        if (url.pathname === '/api/copilot/permission') {
          const { chat, id, option } = await readJson(req);
          const waiting = acpChats.get(chat)?.waiting;
          const resolve = waiting?.get(id);
          if (!resolve) return json(res, 404, { error: 'that question has already been answered or expired' });
          waiting.delete(id);
          resolve(option ? { outcome: 'selected', optionId: String(option) } : { outcome: 'cancelled' });
          return json(res, 200, { ok: true });
        }
        // A file you drop on the chat: kept where the chat can read it, named in your next message.
        if (url.pathname === '/api/copilot/attach') {
          const name = safeName(url.searchParams.get('name') || 'file');
          const chunks = []; let size = 0;
          for await (const ch of req) { size += ch.length; if (size > 25 * 1024 * 1024) return json(res, 413, { error: 'at most 25 MB' }); chunks.push(ch); }
          const dir = join(copilotTmp(), 'attachments', randomBytes(6).toString('hex'));
          mkdirSync(dir, { recursive: true, mode: 0o700 });
          const path = join(dir, name);
          writeFileSync(path, Buffer.concat(chunks), { mode: 0o600 });
          return json(res, 200, { path, name, size });
        }
        if (url.pathname === '/api/copilot') {
          const body = await readJson(req);
          const info = await copilotInfo();
          if (!info.available) return json(res, 400, { error: 'GitHub Copilot CLI not found; install it or set COPILOT_BIN' });
          // Files you attached (uploaded first to /api/copilot/attach): named at the end of the message.
          const attached = (Array.isArray(body.attachments) ? body.attachments : []).map(String).filter((pth) => isStaged(pth)).slice(0, 10);
          // Files on disk you pointed at with @: only their paths go in, Copilot reads them itself.
          const pointRoots = chatReadRoots(body.session, body.cwd && isDir(body.cwd) ? body.cwd : null);
          const pointed = [];
          for (const f of (Array.isArray(body.files) ? body.files : []).slice(0, 20)) {
            const r = checkFileRef(f, { roots: pointRoots, home: homedir(), cwd: body.cwd });
            if (r.error) return json(res, 400, { error: r.error });
            if (!pointed.some((x) => x.path === r.path)) pointed.push(r);
          }
          const tail = [attached.length && `Files I attached: ${attached.join(', ')}`, fileRefLine(pointed, homedir())].filter(Boolean).join('\n');
          // A new task from another chat's card (lib/new-task.mjs): its hand-off, and how to start.
          const task = !body.resume && cleanNewTask(body.newTask);
          const typed = String(body.message || '').slice(0, 20_000);
          const message = `${task ? newTaskPrompt(task, typed, { skills: (info.skills || []).map((x) => x.name) }) : typed}${tail ? `\n\n${tail}` : ''}`;
          if (!message.trim()) return json(res, 400, { error: 'empty message' });
          if (!copilot.validModel(body.model)) return json(res, 400, { error: 'bad model name' });
          if (!body.session || !/^[\w-]{8,64}$/.test(body.session)) return json(res, 400, { error: 'bad session' });
          const refs = validRefs(body.refs);
          // A new chat about a PR runs in your clone of that repository, when there is one.
          // A chat about a PR or GitHub issue runs in your clone of its repo; one about a ticket, in
          // the clone of the PR that carries its key (in the PR's title or branch), if there is one.
          const repoRef = !body.resume && !body.cwd && (refs.find((r) => r.kind === 'pr' || r.kind === 'gh') || ticketPr(refs.find((r) => r.kind === 'issue')));
          let clone = repoRef ? findCheckout(repoRef.repo) : null;
          let checkout = clone && (worktreeFor(clone, prBranch(repoRef)) || clone);
          // A ticket with no PR yet: the clone (and worktree) of a branch that carries its key.
          const ticket = !checkout && !body.resume && !body.cwd && refs.find((r) => r.kind === 'issue');
          if (ticket) {
            const found = (await branchesFor([ticket.key], codeDirs()).catch(() => ({})))[ticket.key] || [];
            const b = found.find((x) => x.local) || found[0];
            if (b) checkout = worktreeFor(b.clone, b.branch) || b.clone;
          }
          // A new task names its repository: its clone, when the ticket gave none.
          if (!checkout && task?.repo && !body.cwd) checkout = findCheckout(task.repo);
          // A PR or ticket chat with no clone found starts in your first folder (Settings → Agent).
          const cwd = checkout || (body.cwd && isDir(body.cwd) ? body.cwd : (refs.length && !body.resume && copilotFolders().map((d) => untilde(d)).find(isDir)) || copilotCwd());
          let refText = '';
          if (refs.length) {
            const parts = await Promise.all(refs.map((r) => referenceText(r).catch((e) => `## ${r.key || `${r.repo}#${r.number}`}\n(couldn't load: ${e.message})`)));
            refText = `${REFS_INTRO}\n\n${parts.join('\n\n')}`;
          }
          const list = (v) => (Array.isArray(v) ? v : String(v || '').split(',')).map((x) => String(x).trim()).filter(Boolean);
          if (body.permission === 'assisted') body.permission = 'sandboxed'; // Assisted is gone: the sandbox does its job
          const options = { model: body.model, effort: body.effort, permission: copilot.PERMISSIONS[body.permission] ? body.permission : 'ask',
            allow: list(body.allow), deny: list(body.deny) };
          // The first turn carries the dashboard so Copilot knows what you're looking at.
          const sandboxHint = sandboxHintFor(body.permission);
          const folders = foldersHint();
          // A Copilot command (/compact, say) only works as the whole message: nothing goes in front.
          // The sandbox hint a resumed chat is owed then goes with the next message instead.
          const command = /^\/(compact|clear|context|usage|model)\b/.test(message.trim());
          const owed = body.resume && sandboxHint && (!acpChats.has(body.session) || hintOwed.has(body.session));
          if (command) { if (owed) hintOwed.add(body.session); } else hintOwed.delete(body.session);
          // Folders you added to this chat since its last message: say so once.
          const note = !command && folderNotes.get(body.session);
          if (note) folderNotes.delete(body.session);
          const update = !command && (owed || note) && `${UPDATE_INTRO}${owed ? sandboxHint : ''}${note ? `\n\n${note}` : ''}`;
          const prefix = command ? '' : [update, !body.resume && `${CONTEXT_INTRO}\n\n${copilotContext()}\n\n${CHOICES_HINT}\n\n${NEW_TASK_HINT}\n\n${memoryHint()}\n\n${PR_HINT}\n\n${trackerHints()}${folders && `\n\n${folders}`}${sandboxHint}`, refText].filter(Boolean).join('\n\n---\n\n');
          const prompt = prefix ? `${prefix}${MSG_MARK}${message}` : message;
          // Answers stream back as one JSON event per line: text, tool, permission, done, error.
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
          let sessionId = body.session;
          const emit = (e) => {
            e.at ??= Date.now(); // when it happened, shown on each line in the chat
            if (e.type === 'session') { sessionId = e.id; linkRefs(); }
            if (!res.writableEnded && !res.destroyed) res.write(`${JSON.stringify(e)}\n`);
          };
          // A new chat about one item is named after it. (Copilot 1.0.105 ignores /rename over ACP, so the name lives here.)
          const named1 = !body.resume && refs.length === 1 ? itemSessionName(refs[0]) : null;
          // A new task is named after its card when Jira doesn't know the ticket yet (or it has none).
          const itemName = task?.title && !named1?.includes(' · ') ? [named1, task.title !== named1 && task.title].filter(Boolean).join(' · ').slice(0, 100) : named1;
          // Remember which PRs and tickets this session is about, for the links on the page.
          const kept = new Set();
          const linkRefs = () => {
            for (const pth of attached) if (!kept.has(`${sessionId}|${pth}`)) { kept.add(`${sessionId}|${pth}`); keepAttachment(sessionId, pth); }
            for (const f of pointed) if (!f.dir && !kept.has(`${sessionId}|${f.path}`)) { kept.add(`${sessionId}|${f.path}`); logWrite(agentFilesFile, { where: 'file', what: f.path, kind: 'pointed', chats: [{ id: sessionId }], decided: 'done' }); }
            if (refs.length) localState.addSessionRefs(stateFile, sessionId, refs.map(refKey));
            if (prefix && !body.resume) localState.setSessionTitle(stateFile, sessionId, message.trim().split('\n')[0]);
            if (itemName) localState.setSessionName(stateFile, sessionId, itemName);
          };
          res.on('close', linkRefs);
          if (cwd !== (body.cwd || copilotCwd())) emit({ type: 'cwd', cwd });
          if (itemName) emit({ type: 'title', title: itemName });
          forgetSessions();
          try {
            const named = [...String(message).matchAll(/\b([A-Z][A-Z0-9_]+)-\d+\b/g)].map((m) => ({ kind: 'issue', key: m[0] }));
            watchdog.userMessage(body.session); // a message from you: a new task, so a fresh count of nudges
            await acpTurn({ chat: body.session, options, prompt, resumeId: body.resume ? body.session : null, cwd, emit, res, bin: info.bin, scope: [...refs, ...named], agent: AGENTS[body.agent] ? body.agent : null });
          } catch (e) { emit({ type: 'error', message: e.message }); }
          return res.end();
        }
        if (url.pathname === '/api/mute') {
          const { key, for: span } = await readJson(req);
          return json(res, 200, { muted: localState.setMuted(stateFile, { key, until: muteUntil(span) }) });
        }
        if (url.pathname === '/api/read') {
          const { marks } = await readJson(req);
          if (!Array.isArray(marks) || marks.length > 1000) return json(res, 400, { error: 'marks must be a list' });
          localState.setRead(stateFile, marks);
          return json(res, 200, { ok: true });
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
        // Copilot's memory (lib/memory.mjs): the whole file from Settings, or notes from a card's Save.
        if (url.pathname === '/api/copilot/memory') {
          const body = await readJson(req, 64 * 1024);
          const file = memory.memoryFile();
          const r = typeof body.text === 'string' ? memory.writeMemory(file, body.text)
            : (() => { const a = memory.addNotes(memory.readMemory(file), { lines: Array.isArray(body.lines) ? body.lines.map(String) : [], repo: body.repo });
              return a.error || !a.added ? a : { ...memory.writeMemory(file, a.text), added: a.added }; })();
          if (r.error) return json(res, 400, { error: r.error });
          return json(res, 200, { text: r.text, added: r.added ?? null, max: memory.MAX_BYTES });
        }
        // Links (lib/links.mjs): the whole list as you edited it, or bookmarks from a browser's export.
        if (url.pathname === '/api/links') {
          const doc = await readJson(req, 1024 * 1024);
          return json(res, 200, saveLinks(linksFile(), doc));
        }
        if (url.pathname === '/api/links/import') {
          const { html, area } = await readJson(req, 8 * 1024 * 1024);
          const found = parseBookmarks(String(html || ''), { area: area === 'personal' ? 'personal' : 'work' });
          const count = found.groups.reduce((n, g) => n + g.links.length, 0);
          if (!count) return json(res, 400, { error: 'no links found: export your bookmarks as an HTML file from the browser and pick that' });
          return json(res, 200, { ...saveLinks(linksFile(), mergeLinks(readLinks(linksFile()), found)), imported: count });
        }
        if (url.pathname === '/api/dismiss') {
          return json(res, 200, { dismissed: localState.setDismissed(stateFile, await readJson(req)) });
        }
        if (url.pathname === '/api/settings') {
          saveSettings(await readJson(req));
          vmQueue.pump(); // more VMs at once: whoever waits starts now
          return json(res, 200, await settingsStatus());
        }
        // Star or unstar a Jira project for the Versions page; saved like a setting.
        if (url.pathname === '/api/jira/star' && tracker() === 'github') {
          const { key, starred } = await readJson(req);
          if (!REPO_NAME.test(key || '')) return json(res, 400, { error: 'bad repo (owner/name)' });
          const now = starredRepos().filter((k) => k !== key);
          if (starred) now.push(key);
          saveSettings({ GITHUB_STARRED_REPOS: now.join(',') }, { quiet: true });
          return json(res, 200, { starred: starredRepos() });
        }
        if (url.pathname === '/api/jira/star') {
          const { key, starred } = await readJson(req);
          if (!PROJECT_KEY.test(key || '')) return json(res, 400, { error: 'bad project key' });
          const now = starredProjects(process.env.JIRA_STARRED_PROJECTS).filter((k) => k !== key);
          if (starred) now.push(key);
          saveSettings({ JIRA_STARRED_PROJECTS: now.join(',') }, { quiet: true });
          return json(res, 200, { starred: starredProjects(process.env.JIRA_STARRED_PROJECTS) });
        }
        // Show or hide one calendar's events; saved like a setting, without refetching everything.
        if (url.pathname === '/api/calendar/hidden') {
          const { name, hidden } = await readJson(req);
          if (typeof name !== 'string' || !name.trim() || /[,\r\n]/.test(name)) return json(res, 400, { error: 'bad calendar name' });
          const now = hiddenCalendars();
          if (hidden) now.add(name.trim().toLowerCase()); else now.delete(name.trim().toLowerCase());
          saveSettings({ CALENDAR_HIDDEN: [...now].join(',') }, { quiet: true });
          return json(res, 200, { hidden: [...now] });
        }
        // Hand-offs: add one (now, or from a time such as your next meeting), start one now, cancel.
        if (url.pathname === '/api/handoffs') {
          const body = await readJson(req);
          let list = readHandoffs(handoffFile());
          if (body.action === 'add') {
            const r = addHandoff(list, body.ref, { after: body.after });
            saveHandoffs(handoffFile(), r.list);
            setTimeout(() => handoffs.check?.(), 100);
            return json(res, 200, { handoff: r.handoff, already: r.already, handoffs: r.list });
          }
          const h = list.find((x) => x.id === body.id);
          if (!h) return json(res, 404, { error: 'no such hand-off' });
          if (body.action === 'start' && h.status === 'queued') list = updateHandoff(list, h.id, { after: null });
          else if (body.action === 'retry' && ['failed', 'stopped', 'blocked', 'cancelled'].includes(h.status)) list = updateHandoff(list, h.id, { status: 'queued', after: null, note: '' });
          else if (body.action === 'cancel' && h.status === 'queued') list = updateHandoff(list, h.id, { status: 'cancelled' });
          else if (body.action === 'forget' && !['working', 'needs-you'].includes(h.status)) list = list.filter((x) => x.id !== h.id);
          else return json(res, 400, { error: `can't ${body.action} a hand-off that is ${h.status}` });
          saveHandoffs(handoffFile(), list);
          setTimeout(() => handoffs.check?.(), 100);
          return json(res, 200, { handoffs: list });
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
        return json(res, 404, { error: 'not found' });
      }
      if (url.pathname === '/api/settings') return json(res, 200, await settingsStatus());
      if (url.pathname === '/api/vpn') return json(res, 200, await vpn.check(url.searchParams.has('now')));
      if (url.pathname === '/settings') return html(res, settingsPage);
      // The first-run welcome: what this machine has, the logins, and your work, in three steps.
      if (url.pathname === '/welcome') return html(res, welcomePage);
      if (url.pathname === '/api/handoffs') return json(res, 200, { handoffs: readHandoffs(handoffFile()), sandbox: isDemo() || await srtInstalled() });
      if (url.pathname === '/api/team') return json(res, 200, { team: readTeam(dirname(userEnvFile)) });
      if (url.pathname === '/api/doctor') {
        const [list, hints] = await Promise.all([machineChecks(), doctorSuggestions({ acliBin: config.jira.acli })]);
        return json(res, 200, { checks: list, ready: doctorReady(list), suggestions: hints, platform: process.platform, wsl: wslInfo(),
          tracker: tracker(), values: { TRACKER: process.env.TRACKER || '', GITHUB_ORGS: process.env.GITHUB_ORGS || '', CLEARSKY_STANDUP_TIME: process.env.CLEARSKY_STANDUP_TIME || '', CLEARSKY_WORKDAYS: process.env.CLEARSKY_WORKDAYS || '' } });
      }
      if (url.pathname === '/api/standup/say') {
        if (!standupCache.data) standupCache = { at: Date.now(), data: await standup(await collect(false)) };
        // ?cached=1: what was written for this stand-up already, without asking Copilot.
        if (url.searchParams.has('cached')) return json(res, 200, sayCache.key === `${standupCache.data.sinceLabel}|${standupCache.data.text}` ? { text: sayCache.text, at: sayCache.at } : { text: null });
        try { const r = await standupSay(standupCache.data, url.searchParams.has('refresh')); return json(res, 200, { text: r.text, at: r.at }); }
        catch (e) { return json(res, 502, { error: e.message }); }
      }
      if (url.pathname === '/api/standup') {
        const force = url.searchParams.has('refresh');
        if (force || !standupCache.data || Date.now() - standupCache.at > config.cacheSeconds * 1000) {
          standupCache = { at: Date.now(), data: await standup(await collect(force)) };
        }
        return json(res, 200, standupCache.data);
      }
      // A source's item read in full, and its files (see detail and attachment in lib/sources.mjs).
      const part = url.pathname.match(/^\/api\/source\/([a-z][a-z0-9-]+)\/(detail|attachment)$/);
      if (part) {
        const p = plugins.sources.get(part[1]), key = url.searchParams.get('key');
        if (!p || typeof p[part[2]] !== 'function') return json(res, 404, { error: 'not found' });
        if (!key) return json(res, 400, { error: 'key is required' });
        try {
          const data = await source(p.name, false);
          if (part[2] === 'detail') return json(res, 200, await sourceDetail(p, key, data, url.searchParams.has('refresh')));
          return sendFile(res, await p.attachment(key, url.searchParams.get('id') || '', makeContext(p), data));
        } catch (e) {
          return json(res, e.auth ? 401 : 502, { error: e.message, ...(e.auth && { needsLogin: true }) });
        }
      }
      const src = url.pathname.match(/^\/api\/source\/([a-zA-Z][\w-]*)$/)?.[1];
      if (src) {
        if (!SOURCES[src]) return json(res, 404, { error: 'unknown source' });
        // ?wait: the new data once the fetch behind a stale answer lands.
        const behind = url.searchParams.has('wait') && sourceCache.get(src)?.pending;
        const data = await (behind || source(src, url.searchParams.has('refresh')));
        const shown = src === 'github' ? withOwn(data) : withReads(src, data);
        return json(res, 200, { ...shown, work: workItemsOf(src, shown), fetchedAt: new Date(sourceCache.get(src)?.at || Date.now()).toISOString(),
          ...(sourceCache.get(src)?.pending && { refreshing: true }) });
      }
      // The app window's manifest and icons (Clearsky in its own window: `clearsky app`).
      const asset = { '/manifest.webmanifest': 'application/manifest+json', '/icon.svg': 'image/svg+xml', '/icon-192.png': 'image/png', '/icon-512.png': 'image/png' }[url.pathname];
      if (asset) {
        res.writeHead(200, { 'Content-Type': asset, 'Cache-Control': 'max-age=3600' });
        return res.end(readFileSync(join(appDir, 'web', url.pathname.slice(1))));
      }
      if (url.pathname === '/favicon.ico') { res.writeHead(302, { Location: '/icon.svg' }); return res.end(); }
      if (url.pathname === '/api/modules') return json(res, 200, { modules: moduleManifests() });
      if (url.pathname === '/api/plugins') return json(res, 200, pluginList());
      if (url.pathname === '/api/sources') {
        return json(res, 200, { tracker: TRACKERS[tracker()], sources: [...plugins.sources.values()].map((p) => ({ name: p.name, label: p.label, area: p.area, panel: p.panel || null })), errors: plugins.errors });
      }
      // What needs you, with when each first showed up, so the page can mark what's new.
      // What was notified lately, to find out why something came twice.
      if (url.pathname === '/api/notifications/log') return json(res, 200, { log: localState.notifiedLog(stateFile), pollMinutes: Math.max(1, Number(process.env.CLEARSKY_POLL_MINUTES) || 3), notifier: poller.notifier, pid: process.pid });
      if (url.pathname === '/api/attention') {
        const data = Object.fromEntries(await Promise.all(ATTENTION_SOURCES.map(async (n) => [n, await source(n, false)])));
        const seen = localState.seen(stateFile);
        return json(res, 200, { lastPoll: poller.lastPoll, notifier: poller.notifier, dataVersion,
          items: [...attentionItems(data), ...await pluginAttention(false)].map((it) => ({ ...it, at: seen[it.key]?.stamp === String(it.stamp ?? '') ? seen[it.key].at : null })) });
      }
      if (url.pathname === '/api/copilot') return json(res, 200, { ...await copilotInfo(url.searchParams.has('refresh')), commands: copilotCommands });
      // Files and folders for the @ picker: names under the chat's folders, or a path's entries.
      if (url.pathname === '/api/copilot/files') {
        const id = url.searchParams.get('chat') || '';
        const cwd = url.searchParams.get('cwd') || '';
        const dir = cwd && isDir(cwd) ? cwd : null;
        return json(res, 200, { files: findFiles(url.searchParams.get('q') || '', { roots: chatReadRoots(id, dir), home: homedir(), cwd: dir || acpChats.get(id)?.cwd || copilotCwd() }) });
      }
      // A chat's background jobs, newest first, and the end of one's output.
      if (url.pathname === '/api/copilot/jobs') {
        const id = url.searchParams.get('chat') || '';
        if (isDemo()) return json(res, 200, (await import('../scripts/demo/data.mjs')).jobs(id));
        return json(res, 200, { jobs: jobs.list(id).slice(0, 20).map((j) => jobView(j, { tilde: tildeHome })), watchdog: watchdog.view(id) });
      }
      if (url.pathname === '/api/copilot/job-log') {
        const j = jobs.get(url.searchParams.get('id') || '');
        if (!j || j.chat !== url.searchParams.get('chat')) return json(res, 404, { error: 'no such job' });
        return json(res, 200, { log: tailOf(j.log, 400, 256 * 1024) });
      }
      // What one chat runs with, for the panel beside it.
      if (url.pathname === '/api/copilot/chat') {
        const id = url.searchParams.get('id') || '';
        const c = acpChats.get(id);
        const tilde = (p) => (p.startsWith(homedir()) ? `~${p.slice(homedir().length)}` : p);
        return json(res, 200, {
          running: !!c && !c.agent.closed, busy: !!c?.busy, sandboxed: c ? !!c.agent.sandboxed : null, hosts: c?.agent.hosts || null, github: c?.agent.github || null,
          cwd: c?.cwd ? tilde(c.cwd) : null,
          folders: copilotFolders().map(tilde), read: list(process.env.AGENT_READ).map(tilde), chatFolders: chatFolders(id).map(tilde),
          sandbox: process.env.AGENT_SANDBOX === 'srt',
          usage: /^[\w-]{8,64}$/.test(id) ? sessionUsage(join(homedir(), '.copilot'), id) : null,
          // What it cost so far, split like the line at the end of a PR (lib/disclosure.mjs).
          credits: /^[\w-]{8,64}$/.test(id) ? (() => { const sp = chatCredits(id, c?.model); return sp.total != null ? { ...sp, line: disclosureLine(sp), cost: costOf(sp.total, costRates(process.env, readFx())) } : null; })() : null,
          // When it last did anything (its log's time), and what it's about: for "start fresh".
          lastAt: /^[\w-]{8,64}$/.test(id) ? (() => { try { return statSync(join(homedir(), '.copilot', 'session-state', id, 'events.jsonl')).mtimeMs; } catch { return null; } })() : null,
          refs: localState.sessionRefs(stateFile)[id] || [],
        });
      }
      // AI credits across all chats (today, this week, this month, all time; by day, week and
      // chat), with what they cost in dollars and your currency (lib/credit-usage.mjs).
      if (url.pathname === '/api/copilot/usage') {
        const home = join(homedir(), '.copilot');
        const t = creditTotals(allCreditRecords(home));
        const env = process.env;
        const live = env.CLEARSKY_FX_LIVE === 'on' ? await liveRate(String(env.CLEARSKY_CURRENCY || '').trim().toUpperCase(), join(homedir(), '.cache', 'clearsky', 'fx.json')) : null;
        const rates = costRates(env, live);
        // Chat names, if Copilot's list is at hand (never waits long for it).
        let names = {};
        try {
          const info = await copilotInfo();
          if (info.available) names = Object.fromEntries((await Promise.race([copilotSessions(info.bin, false), new Promise((r) => setTimeout(() => r([]), 3000))])).map((x) => [x.id, x.title]));
        } catch { /* ids only */ }
        const cost = (n) => costOf(n, rates);
        return json(res, 200, {
          ...t, agent: backend().name, rates, liveFailed: rates.live && !!rates.currency && rates.rateFrom !== 'live',
          cost: { total: cost(t.total), today: cost(t.today), week: cost(t.week), month: cost(t.month) },
          days: t.days.map((d) => ({ ...d, cost: cost(d.credits) })), weeks: t.weeks.map((w) => ({ ...w, cost: cost(w.credits) })),
          chats: t.chats.map((c) => ({ ...c, title: names[c.id] || null, cost: cost(c.credits) })),
        });
      }
      // What Copilot changed as you on GitHub and Jira (all chats, or one).
      // A chat's outputs: files it made, files you attached, and what it changed elsewhere, linked.
      if (url.pathname === '/api/copilot/outputs') {
        const id = url.searchParams.get('chat') || '';
        if (!/^[\w-]{8,64}$/.test(id)) return json(res, 400, { error: 'bad chat' });
        return json(res, 200, await chatOutputs(id));
      }
      if (url.pathname === '/api/copilot/file') {
        const id = url.searchParams.get('chat') || '', pth = url.searchParams.get('path') || '';
        const file = /^[\w-]{8,64}$/.test(id) && chatFile(id, pth);
        if (!file) return json(res, 404, { error: 'not one of this chat\'s files' });
        if (url.searchParams.has('diff')) return json(res, 200, await fileDiff(pth, acpChats.get(id)));
        return sendFile(res, file);
      }
      if (url.pathname === '/api/links') return json(res, 200, readLinks(linksFile()));
      if (url.pathname === '/api/copilot/memory') {
        const file = memory.memoryFile();
        return json(res, 200, { path: file.replace(homedir(), '~'), text: memory.readMemory(file), max: memory.MAX_BYTES });
      }
      // The map of what chats did where (lib/map.mjs): one chat's, or the recent ones'.
      if (url.pathname === '/api/copilot/map') {
        const chatId = url.searchParams.get('chat') || null;
        const writes = readWrites(agentLogFile, { chat: chatId, limit: 3000 });
        const names = localState.sessionNames(stateFile), titles = new Map((sessionsCache?.data || []).map((x) => [x.id, x.title]));
        const refs = localState.sessionRefs(stateFile);
        const scope = (id) => {
          const c = acpChats.get(id), r = refs[id] || [];
          return {
            repos: [...new Set([...(c ? chatRepos(c) : []), ...r.map((k) => k.match(/^(?:pr|gh):([\w.-]+\/[\w.-]+)#/)?.[1]?.toLowerCase()).filter(Boolean)])],
            tickets: [...new Set([...(c?.tickets || []), ...r.filter((k) => k.startsWith('issue:')).map((k) => k.slice(6))])],
          };
        };
        let chats = buildMap(writes, { scope });
        if (chatId && !chats.length) {
          const sc = scope(chatId), n = (kind) => (key) => ({ kind, key, first: null, acts: [], prs: [], branches: [], scope: true });
          const nodes = [...sc.repos.map(n('repo')), ...sc.tickets.map(n('ticket'))];
          if (nodes.length) chats = [{ id: chatId, first: null, at: null, shared: 0, nodes }];
        }
        for (const ch of chats) Object.assign(ch, { title: names[ch.id] || titles.get(ch.id) || null, live: acpChats.has(ch.id) });
        return json(res, 200, { chats: chats.slice(0, 40), jira: jiraModule.site || null });
      }
      if (url.pathname === '/api/agent-log') return json(res, 200, { writes: readWrites(agentLogFile, { chat: url.searchParams.get('chat') || null, limit: Math.min(Number(url.searchParams.get('limit')) || 300, 2000) }) });
      // A chat's VM, for its view: what runs in it, what it can reach, and what happened.
      if (url.pathname === '/api/vm') {
        const vm = acpChats.get(url.searchParams.get('id') || '')?.vm;
        const support = vmSupport();
        if (!vm) return json(res, 200, { vm: null, support });
        await vm.refresh();
        const v = vm.view();
        const tilde = (p) => (p.startsWith(homedir()) ? `~${p.slice(homedir().length)}` : p);
        return json(res, 200, { vm: { ...v, cwd: tilde(v.cwd), shares: v.shares.map(tilde) }, support });
      }
      // All chats' VMs (the VMs view): who has a place, who waits in line, and what runs in each.
      if (url.pathname === '/api/vms') {
        if (isDemo()) { const d = (await import('../scripts/demo/data.mjs')).vms(); return json(res, 200, { ...d, load: vmsLoad(d.vms), support: { ok: true } }); }
        { const d = await vmsOverview({ look: !url.searchParams.has('quick') }); return json(res, 200, { ...d, load: vmsLoad(d.vms), support: vmSupport() }); }
      }
      if (url.pathname === '/api/copilot/sessions') {
        const info = await copilotInfo();
        if (!info.available) return json(res, 400, { error: 'GitHub Copilot CLI not found' });
        // How full each chat's context is (from its log, cached by the file's size and time).
        const full = (x) => { const u = /^[\w-]{8,64}$/.test(x.id) ? sessionUsage(join(homedir(), '.copilot'), x.id) : null; return u?.context != null && u.limit ? { context: u.context, limit: u.limit } : {}; };
        return json(res, 200, { cwd: copilotCwd(), sessions: (await copilotSessions(info.bin, url.searchParams.has('refresh'))).map((x) => ({ ...x, ...full(x) })) });
      }
      if (url.pathname === '/api/copilot/links') {
        const info = await copilotInfo();
        if (!info.available) return json(res, 200, { links: {}, live: [] });
        return json(res, 200, await copilotLinks(info.bin));
      }
      const histId = url.pathname.match(/^\/api\/copilot\/sessions\/([\w-]{8,64})$/)?.[1];
      if (histId) {
        const info = await copilotInfo();
        if (!info.available) return json(res, 400, { error: 'GitHub Copilot CLI not found' });
        const cwd = isDir(url.searchParams.get('cwd')) ? url.searchParams.get('cwd') : copilotCwd();
        const c = acpChats.get(histId);
        const busy = !!c?.busy;
        // A chat that only exists in this server so far may not be readable from disk yet.
        const messages = await copilotHistory(info.bin, histId, cwd).catch((e) => { if (c || busy) return []; throw e; });
        return json(res, 200, { id: histId, agent: c?.agentName || sessionAgent(histId) || backend().name, cwd, home: homedir(), here: !!c, busy, messages, title: localState.sessionNames(stateFile)[histId] || null });
      }
      const attach = url.pathname.match(/^\/api\/copilot\/sessions\/([\w-]{8,64})\/live$/)?.[1];
      if (attach) return attachCopilot(attach, req, res);
      if (url.pathname === '/api/dismissed') return json(res, 200, { dismissed: localState.dismissed(stateFile), muted: localState.muted(stateFile) });
      if (url.pathname === '/api/plan') {
        // Waits for every source (from cache when fresh); the page asks for it alongside them.
        const { plan, nextStandup: next, summary, generatedAt } = await collect(false);
        return json(res, 200, { plan, nextStandup: next, summary, generatedAt, prefs: { hour12: process.env.CLEARSKY_TIME_FORMAT === '12' } });
      }
      const issueKey = url.pathname.match(/^\/api\/issue\/([A-Z][A-Z0-9_]+-\d+)$/)?.[1];
      if (issueKey) return json(res, 200, await issuePreview(issueKey));
      // The Versions page: starred Jira projects, their fix versions, and one version's tickets.
      // With GitHub Issues: starred repos, their milestones, and one milestone's issues and PRs.
      if (url.pathname.startsWith('/api/jira/') && tracker() === 'none') return json(res, 404, { error: 'no issue tracker is set up' });
      if (url.pathname.startsWith('/api/jira/') && tracker() === 'github') {
        const p = url.pathname.slice('/api/jira/'.length), force = url.searchParams.has('refresh');
        if (p === 'starred') return json(res, 200, { tracker: 'github', starred: starredRepos().map((key) => ({ key, name: key })), site: 'https://github.com' });
        if (p === 'projects') {
          if (!ghReposCache.data || Date.now() - ghReposCache.at > 30 * 6e4 || force) ghReposCache = { at: Date.now(), data: await ghModule.repoChoices() };
          return json(res, 200, { projects: ghReposCache.data, starred: starredRepos() });
        }
        const key = url.searchParams.get('project') || '';
        if (['versions', 'version'].includes(p) && !REPO_NAME.test(key)) return json(res, 400, { error: 'bad repo (owner/name)' });
        if (p === 'versions') return json(res, 200, { project: key, versions: sortVersions(await ghModule.milestones(key, force)) });
        if (p === 'version') {
          const version = url.searchParams.get('version') || '';
          if (!version || version.length > 200 || /[\r\n]/.test(version)) return json(res, 400, { error: 'bad version' });
          const d = await ghModule.milestoneIssues(key, version, force);
          return json(res, 200, { ...d, summary: versionSummary(d.issues) });
        }
      }
      if (url.pathname === '/api/jira/starred') {
        const names = new Map((jiraProjectsCache.data || []).map((p) => [p.key, p.name]));
        return json(res, 200, { starred: starredProjects(process.env.JIRA_STARRED_PROJECTS).map((key) => ({ key, name: names.get(key) || null })), site: jiraModule.site });
      }
      if (url.pathname === '/api/jira/projects') {
        if (!jiraProjectsCache.data || Date.now() - jiraProjectsCache.at > 30 * 6e4 || url.searchParams.has('refresh')) {
          jiraProjectsCache = { at: Date.now(), data: await jiraModule.jiraProjects() };
        }
        return json(res, 200, { projects: jiraProjectsCache.data, starred: starredProjects(process.env.JIRA_STARRED_PROJECTS) });
      }
      if (url.pathname === '/api/jira/versions') {
        const key = url.searchParams.get('project') || '';
        if (!PROJECT_KEY.test(key)) return json(res, 400, { error: 'bad project key' });
        return json(res, 200, { project: key, versions: await jiraModule.projectVersions(key, url.searchParams.has('refresh')) });
      }
      if (url.pathname === '/api/jira/version') {
        const key = url.searchParams.get('project') || '', version = url.searchParams.get('version') || '';
        if (!PROJECT_KEY.test(key)) return json(res, 400, { error: 'bad project key' });
        if (!version || version.length > 200 || /[\r\n]/.test(version)) return json(res, 400, { error: 'bad version' });
        const d = await jiraModule.versionIssues(key, version, url.searchParams.has('refresh'));
        return json(res, 200, { ...d, summary: versionSummary(d.issues) });
      }
      const prsFor = url.pathname.match(/^\/api\/issue\/([A-Z][A-Z0-9_]+-\d+)\/prs$/)?.[1];
      if (prsFor) return json(res, 200, await ghModule.ticketPrs(prsFor, { fresh: url.searchParams.has('fresh') }));
      // Builds: each repo's main branch, its checks and its newest artifact and release.
      if (url.pathname === '/api/servers') {
        const file = join(homedir(), '.ssh', 'config');
        return json(res, 200, { hosts: sshHosts(file), file: existsSync(file) ? file : null });
      }
      if (url.pathname === '/api/builds') {
        const fresh = buildsCache.data && Date.now() - buildsCache.at < 2 * 6e4 && !url.searchParams.has('refresh');
        if (!fresh) {
          const gh = await source('github', false).catch(() => null);
          const repos = buildRepos(process.env.GITHUB_BUILD_REPOS, gh);
          buildsCache = { at: Date.now(), data: { repos: await ghModule.builds(repos), named: !!process.env.GITHUB_BUILD_REPOS, checkedAt: new Date().toISOString() } };
        }
        return json(res, 200, buildsCache.data);
      }
      if (url.pathname === '/api/pr') {
        const repo = url.searchParams.get('repo') || '', number = url.searchParams.get('number') || '';
        if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !/^\d+$/.test(number)) return json(res, 400, { error: 'bad PR reference' });
        return json(res, 200, await prPreview(repo, number));
      }
      if (url.pathname === '/api/pr/reviewers') {
        const repo = url.searchParams.get('repo') || '', number = url.searchParams.get('number') || '';
        if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !/^\d+$/.test(number)) return json(res, 400, { error: 'bad PR reference' });
        const d = await reviewerOptions(repo, Number(number));
        const last = new Set(localState.lastReviewers(stateFile, repo));
        for (const p of d.people) p.last = last.has(p.login);
        const rank = (p) => (p.requested ? 0 : p.last ? 1 : 2);
        d.people.sort((a, b) => rank(a) - rank(b)); // stable: GitHub's order otherwise
        return json(res, 200, d);
      }
      // Branches in your clones carrying the key of a ticket you have.
      if (url.pathname === '/api/branches') {
        // Waits for the ticket lists, so a page loaded right after a start doesn't get a partial answer.
        const [j, jm] = (await Promise.all([source('jira'), source('jiraMentions')])).map((d) => d || {});
        const keys = [...new Set([...(j.assigned || []), ...(jm.tickets || [])].map((t) => t.key).filter(Boolean))];
        return json(res, 200, { branches: await branchesFor(keys, codeDirs()) });
      }
      if (url.pathname === '/api/restart') return json(res, 200, { pending: restart.pending, busy: busyChats(), updateReady: updateReady() });
      if (url.pathname === '/api/actions') return json(res, 200, { actions: localState.actions(stateFile) });
      if (url.pathname === '/api/work') {
        const data = await collect(url.searchParams.has('refresh'));
        return json(res, 200, data);
      }
      if (url.pathname === '/' || url.pathname === '/index.html') {
        // The very first start, with nothing set up yet: the welcome page first.
        if (firstRun()) { res.writeHead(302, { Location: '/welcome' }); return res.end(); }
        return html(res, page);
      }
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

export { findBrowser, SOURCES, sourceCache };

// ---------------------------------------------------------------- main

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const args = process.argv.slice(2);
  if (args.includes('-h') || args.includes('--help')) {
    console.log('usage: clearsky [--json] | clearsky try [--port N] [--no-open] | clearsky doctor [--json] | clearsky join [<team pack>] | clearsky team init <folder> [--name N] [--repo URL] [--links] | clearsky team export [--name N] [--links] | clearsky add <plugin> [--trust] [--yes] | clearsky remove <plugin> [--data] | clearsky plugins | clearsky update [<plugin>] | clearsky standup [--json] | clearsky serve [--port N] | clearsky restart [--now] [--wait MIN] [--port N] | clearsky app [--port N] | clearsky login jira|github | clearsky docker [up|start|down|logs|login|mounts] [--port N] | clearsky school-handover | clearsky jira-debug');
  } else if (args[0] === 'try') {
    // Clearsky with made-up data, in this terminal: Ctrl+C stops it.
    const p = args.indexOf('--port');
    const port = p > -1 ? Number(args[p + 1]) : demoPort();
    const d = await startDemo({ port, foreground: true });
    if (d.already) console.log(`The demo is already running: ${d.url}`);
    if (!args.includes('--no-open')) openInBrowser(d.url);
    if (d.child) await new Promise((r) => d.child.once('exit', r));
  } else if (args[0] === 'join') {
    // clearsky join <git repo | https link | file>; without one, fetch the pack you joined again.
    const from = args[1] || readTeam(dirname(userEnvFile))?.from;
    if (!from) { console.error('usage: clearsky join <git repo | https://…/clearsky-team.json | file>'); process.exitCode = 2; }
    else {
      try {
        const r = await joinTeam(from);
        console.log(`Joined ${r.name}: ${joinSummary(r)}`);
        if (r.plugins.some((p) => p.state !== 'added')) console.log('Look at the team\'s plugins and add them with `clearsky add --team` (or in Settings → Plugins).');
      }
      catch (e) { console.error(`clearsky: ${e.message}`); process.exitCode = 1; }
    }
  } else if (args[0] === 'team' && args[1] === 'init') {
    // clearsky team init <folder> [--name N] [--repo URL] [--jira-site S] [--links] [--force]
    const opt = (f) => { const i = args.indexOf(f); return i > -1 ? args[i + 1] : undefined; };
    const dir = args[2] && !args[2].startsWith('--') ? args[2] : null;
    if (!dir) { console.error('usage: clearsky team init <folder> [--name "Payments team"] [--repo https://github.com/acme/clearsky-team] [--jira-site acme.atlassian.net] [--links] [--force]'); process.exitCode = 2; }
    else {
      try {
        const r = makeTeamPack({ dir, name: opt('--name'), repo: opt('--repo'), jiraSite: opt('--jira-site'), links: args.includes('--links'), force: args.includes('--force') });
        console.log(`Wrote ${r.pack.name}'s team pack to ${r.dir}: ${r.written.join(', ')}`);
        for (const w of r.warnings) console.log(`  note: ${w}`);
        console.log('\nLook through clearsky-team.json, then:\n');
        for (const n of r.next) console.log(`  ${n}`);
      } catch (e) { console.error(`clearsky: ${e.message}`); process.exitCode = 1; }
    }
  } else if (args[0] === 'team' && args[1] === 'export') {
    // A team pack from your own settings (and, with --links, your work links), to share.
    const n = args.indexOf('--name');
    console.log(JSON.stringify(exportPack({ name: n > -1 ? args[n + 1] : 'Team', links: args.includes('--links') ? readLinks(linksFile()) : null }), null, 2));
  } else if (args[0] === 'doctor') {
    const list = await machineChecks();
    console.log(args.includes('--json') ? JSON.stringify(list, null, 2) : doctorText(list));
    process.exitCode = doctorReady(list) ? 0 : 1;
  } else if (args[0] === 'standup') {
    const s = await standup();
    console.log(args.includes('--json') ? JSON.stringify(s, null, 2) : s.text);
  } else if (args[0] === 'restart') {
    const p = args.indexOf('--port');
    if (p > -1) config.port = Number(args[p + 1]);
    await restartCommand(args);
  } else if (args[0] === 'app') {
    const p = args.indexOf('--port');
    if (p > -1) config.port = Number(args[p + 1]);
    await appCommand();
  } else if (args[0] === 'login' && ['jira', 'github'].includes(args[1])) {
    // The Settings logins, in this terminal: same browser handling (Windows browser under WSL).
    const [bin, argv] = args[1] === 'jira' ? [config.jira.acli || 'acli', ['jira', 'auth', 'login', '--web']] : ['gh', ['auth', 'login', '--web', '--hostname', 'github.com', '--git-protocol', 'https']];
    const code = await new Promise((done) => spawn(bin, argv, { stdio: 'inherit', env: loginEnv() }).on('exit', done).on('error', (e) => { console.error(`clearsky: ${e.code === 'ENOENT' ? `${bin} is not installed` : e.message}`); done(1); }));
    if (code && args[1] === 'jira') console.error('\nIf acli said "authentication failed" before any browser opened: run `acli jira auth logout` and try again; `clearsky doctor` says what this machine is missing for the browser.');
    process.exitCode = code || 0;
  } else if (args[0] === 'docker') {
    const p = args.indexOf('--port');
    if (p > -1) { config.port = Number(args[p + 1]); args.splice(p, 2); }
    await dockerCommand(args.slice(1));
  } else if (['add', 'remove', 'plugins', 'update'].includes(args[0])) {
    process.exitCode = await pluginCommand(args);
  } else if (args[0] === 'school-handover') {
    // The School plugin's own code, wherever it is: added from its repo, or its folder here.
    const dir = [codeDir(pluginDirs.root, 'flyt'), bundledDir('flyt')].find((d) => d && existsSync(join(d, 'lib', 'flyt.mjs')));
    if (!dir) { console.error('clearsky: the School plugin isn\'t added here (`clearsky add visma-flyt --trust`)'); process.exitCode = 1; } else {
      const { handOverLogin } = await import(pathToFileURL(join(dir, 'lib', 'flyt.mjs')).href);
      const where = await handOverLogin();
      console.log(where ? `School login moved to ${where}; Clearsky's container takes it from there.` : 'No school login here to hand over.');
    }
  } else if (args[0] === 'jira-debug') {
    await jiraDebug();
  } else if (args[0] === 'serve') {
    const p = args.indexOf('--port');
    if (p > -1) config.port = Number(args[p + 1]);
    serve();
  } else {
    const data = await collect();
    console.log(args.includes('--json') ? JSON.stringify(data, null, 2) : toMarkdown(data));
  }
}
