// Routes for your work: the collected items, the day plan and the stand-up, a source's items in
// full, what is new, read and muted, and your links.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import * as localState from '../../state.mjs';
import { sshHosts } from '../../ssh-hosts.mjs';
import { attentionItems } from '../../notify.mjs';
import { makeContext } from '../../sources.mjs';
import { readLinks, saveLinks, parseBookmarks, mergeLinks } from '../../links.mjs';
import { TRACKERS } from '../../tracker.mjs';
import { stateFile, config, tracker, whenSettingsChange, saveSettings, plugins, muteUntil } from '../config.mjs';
import { hiddenCalendars, SOURCES, linksFile, workItemsOf, sourceCache, dataVersion, source, withOwn, collect, sourceDetail } from '../work.mjs';
import { sayCache, standupSay, standup } from '../standup.mjs';
import { ATTENTION_SOURCES, poller, pluginAttention, withReads } from '../attention.mjs';
import { openInBrowser } from '../commands.mjs';
import { readJson, sendFile, json, NEXT } from '../http.mjs';

let standupCache = { at: 0, data: null };
whenSettingsChange(() => { standupCache = { at: 0, data: null }; });

// Changes: POST only, and the server has checked the page's token before it asks here.
export async function post({ req, res, url }) {
  // A link from the app window, opened in your own browser (where you're logged in).
  if (url.pathname === '/api/open') {
    const { url: u } = await readJson(req);
    if (!/^https?:\/\/[^\s]+$/.test(String(u || ''))) return json(res, 400, { error: 'not a web link' });
    if (process.env.CLEARSKY_IN_CONTAINER === '1') return json(res, 501, { error: 'no desktop in the container' });
    openInBrowser(String(u));
    return json(res, 200, { ok: true });
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
  // Show or hide one calendar's events; saved like a setting, without refetching everything.
  if (url.pathname === '/api/calendar/hidden') {
    const { name, hidden } = await readJson(req);
    if (typeof name !== 'string' || !name.trim() || /[,\r\n]/.test(name)) return json(res, 400, { error: 'bad calendar name' });
    const now = hiddenCalendars();
    if (hidden) now.add(name.trim().toLowerCase()); else now.delete(name.trim().toLowerCase());
    saveSettings({ CALENDAR_HIDDEN: [...now].join(',') }, { quiet: true });
    return json(res, 200, { hidden: [...now] });
  }
  return NEXT;
}

// Reads.
export async function get({ res, url }) {
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
  if (url.pathname === '/api/links') return json(res, 200, readLinks(linksFile()));
  if (url.pathname === '/api/dismissed') return json(res, 200, { dismissed: localState.dismissed(stateFile), muted: localState.muted(stateFile) });
  if (url.pathname === '/api/plan') {
    // Waits for every source (from cache when fresh); the page asks for it alongside them.
    const { plan, nextStandup: next, summary, generatedAt } = await collect(false);
    return json(res, 200, { plan, nextStandup: next, summary, generatedAt, prefs: { hour12: process.env.CLEARSKY_TIME_FORMAT === '12' } });
  }
  // Builds: each repo's main branch, its checks and its newest artifact and release.
  if (url.pathname === '/api/servers') {
    const file = join(homedir(), '.ssh', 'config');
    return json(res, 200, { hosts: sshHosts(file), file: existsSync(file) ? file : null });
  }
  if (url.pathname === '/api/actions') return json(res, 200, { actions: localState.actions(stateFile) });
  if (url.pathname === '/api/work') {
    const data = await collect(url.searchParams.has('refresh'));
    return json(res, 200, data);
  }
  return NEXT;
}
