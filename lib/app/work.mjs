// Your work, collected: each source fetched and cached on its own, the day plan (Now / Next)
// worked out from it, and the same as Markdown for `clearsky` in a terminal.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import * as localState from '../state.mjs';
import { readWrites } from '../agent-log.mjs';
import { makeContext, hook, asList } from '../sources.mjs';
import { pluginItems } from '../items.mjs';
import { manifest as calendarManifest } from '../modules/calendar.mjs';
import { ownRead, chatPushes } from '../own-read.mjs';
import { manifest as githubManifest, workItems as githubItems } from '../modules/github.mjs';
import { manifest as jiraManifest, workItems as jiraItems, mentionItems as jiraMentionItems, jiraMentionsByTicket, mergeJira } from '../modules/jira.mjs';
import { userEnvFile, stateFile, agentLogFile, vpn, needsVpn, config, tracker, plugins, clock, atLocalTime, sameDay, nextStandup } from './config.mjs';
import { settle, fetchGitHub, fetchJiraWork, fetchJiraMentions, fetchCalendar } from './services.mjs';

// ---------------------------------------------------------------- Now / Next

export const hiddenCalendars = () => new Set((process.env.CALENDAR_HIDDEN || '').split(',').map((n) => n.trim().toLowerCase()).filter(Boolean));

function reviewMinutes(p) {
  if (p.rerequested) return 15;
  const lines = (p.size?.additions || 0) + (p.size?.deletions || 0);
  return lines < 100 ? 15 : lines < 500 ? 30 : 60;
}

// What to do in the next free slot: the current/next meeting, how long the gap is,
// and up to three tasks that fit it, most urgent first.
export function planNow(d, now = Date.now(), dismissedItems = localState.dismissed(stateFile), mutedItems = localState.muted(stateFile, now),
  doneAt = localState.doneAt(stateFile)) {
  const g = d.github || {}, j = d.jira || {}, cal = d.calendar || {};
  // Calendars you hid (from the agenda) neither show nor take your time.
  const hidden = hiddenCalendars();
  const calendars = [...new Set((cal.events || []).map((e) => e.calendar).filter(Boolean))]
    .map((name) => ({ name, hidden: hidden.has(name.toLowerCase()) }));
  const shown = (cal.events || []).filter((e) => !e.allDay && !e.transparent && !hidden.has((e.calendar || '').toLowerCase()))
    .map((e) => ({ ...e, s: Date.parse(e.start), e: Date.parse(e.end) }));
  // Someone else's events on a shared calendar show in the agenda but don't take your time.
  const timed = shown.filter((e) => !e.fyi);
  // The daily stand-up counts as a meeting even when the calendar doesn't have it (or isn't set up).
  const su = nextStandup(new Date(now));
  if (sameDay(su, new Date(now)) && !timed.some((e) => /stand-?\s?up|daily/i.test(e.title) && Math.abs(e.s - su) < 30 * 6e4)) {
    timed.push({ title: 'Stand-up', start: su.toISOString(), end: new Date(+su + 15 * 6e4).toISOString(), allDay: false, url: null, s: +su, e: +su + 15 * 6e4 });
    timed.sort((a, b) => a.s - b.s);
  }

  const current = timed.find((e) => e.s <= now && now < e.e) || null;
  // Back-to-back meetings (gaps under 5 minutes) count as one busy block.
  let freeFrom = current ? current.e : now;
  for (const e of timed) if (e.s <= freeFrom + 5 * 6e4 && e.e > freeFrom && e.s > now) freeFrom = e.e;
  const next = timed.find((e) => e.s >= freeFrom) || null;
  const workdayEnd = atLocalTime(now, config.workdayEnd);
  const freeUntil = next && next.s < workdayEnd ? next.s : workdayEnd;
  const freeMinutes = Math.max(0, Math.round((freeUntil - freeFrom) / 6e4));

  const recent = (iso, hours) => Date.now() - Date.parse(iso) < hours * 36e5;
  // Each task carries the key and stamp of the item behind it. Marking it done (or dismissing the
  // item on the page) keeps it out until that stamp changes, i.e. until there's something new.
  const off = (key, stamp) => localState.isDismissed(dismissedItems, key, stamp);
  const toStart = (j.assigned || []).filter((i) => i.statusCategory !== 'indeterminate');
  const candidates = [
    ...(g.myPrs || []).filter((p) => p.status.label === 'Ready to merge')
      .map((p) => ({ title: `Merge ${p.repo}#${p.number}`, detail: p.title, url: p.url, stamp: p.stamp, minutes: 5, why: 'approved and green' })),
    // What plugins put forward (their plan() hook), such as replying to a Slack mention.
    ...(d.extraTasks || []),
    ...(j.tickets || jiraMentionsByTicket(j.mentions)).filter((t) => recent(t.at, 48))
      .map((t) => ({ key: t.dismissKey, title: `Answer ${t.by} on ${t.key}`, detail: t.excerpt, url: t.url, stamp: t.stamp, minutes: 10, why: 'Jira mention' })),
    ...[...(g.reviewRequested || [])].filter((p) => !p.draft)
      .sort((a, b) => (b.rerequested - a.rerequested) || Date.parse(a.requestedAt) - Date.parse(b.requestedAt))
      .map((p) => ({ title: `${p.rerequested ? 'Re-review' : 'Review'} ${p.repo}#${p.number}`, detail: p.title, url: p.url, stamp: p.stamp,
        minutes: reviewMinutes(p), why: `someone is waiting, requested ${Math.max(1, Math.round((Date.now() - Date.parse(p.requestedAt)) / 36e5))}h ago` })),
    ...(g.myPrs || []).filter((p) => p.status.owner === 'me' && !p.draft && p.status.label !== 'Ready to merge')
      .map((p) => ({ title: `${p.status.label}: ${p.repo}#${p.number}`, detail: p.title, url: p.url, stamp: p.stamp, minutes: 30, why: 'your PR is blocked on you' })),
    ...(j.assigned || []).filter((i) => i.statusCategory === 'indeterminate' && !i.waiting)
      .map((i) => ({ title: `Continue ${i.key}`, detail: i.summary, url: i.url, stamp: i.stamp, minutes: 90, why: 'in progress' })),
    // The next three to start, skipping ones marked done (which still show in the done list).
    ...[...toStart.filter((i) => off(i.url, i.stamp)), ...toStart.filter((i) => !off(i.url, i.stamp)).slice(0, 3)]
      .map((i) => ({ title: `Start ${i.key}`, detail: i.summary, url: i.url, stamp: i.stamp, minutes: 90, why: i.priority ? `${i.priority} priority` : 'next in your queue' })),
  ];

  for (const c of candidates) c.key ||= c.url;
  const doneList = candidates.filter((c) => off(c.key, c.stamp)).map((c) => ({ ...c, doneAt: doneAt[c.key] || null }));
  // Muted from the "Do next" list: left out until the chosen time, whatever happens on them.
  const mutedList = candidates.filter((c) => mutedItems[c.key] && !off(c.key, c.stamp)).map((c) => ({ ...c, until: mutedItems[c.key] }));
  const suggestions = [];
  let left = freeMinutes;
  for (const c of candidates.filter((x) => !mutedItems[x.key] && !off(x.key, x.stamp))) {
    if (suggestions.length === 3) break;
    // Deep work still gets suggested for a long-enough gap even if it won't finish.
    const fits = c.minutes <= left || (c.minutes >= 90 && freeMinutes >= 45 && left >= 20);
    if (!fits) continue;
    suggestions.push(c);
    left -= Math.min(c.minutes, left);
  }

  const strip = ({ s: _s, e: _e, ...e }) => e;
  return {
    calendar: !cal.disabled && !cal.error,
    calendars,
    now: current && strip(current),
    next: next && strip(next),
    freeFrom: new Date(freeFrom).toISOString(),
    freeUntil: new Date(freeUntil).toISOString(),
    freeMinutes,
    afterHours: now >= workdayEnd,
    muted: mutedList,
    done: doneList,
    agenda: [...timed, ...shown.filter((e) => e.fyi)].sort((a, b) => a.s - b.s)
      .filter((e) => e.e > now && e.s < atLocalTime(now, '23:59')).map(strip),
    // Today as a schedule: everything since midnight, done or not, and the all-day items.
    day: {
      events: [...timed, ...shown.filter((e) => e.fyi)].sort((a, b) => a.s - b.s)
        .filter((e) => e.e > atLocalTime(now, '00:00') && e.s < atLocalTime(now, '23:59')).map(strip),
      allDay: (cal.events || []).filter((e) => e.allDay && !hidden.has((e.calendar || '').toLowerCase())
        && Date.parse(e.start) <= now && now < Date.parse(e.end)).map(({ title, calendar, work }) => ({ title, calendar, work })),
      workdayEnd: new Date(workdayEnd).toISOString(),
    },
    suggestions,
  };
}

// ---------------------------------------------------------------- collect


// Each source is fetched and cached on its own, so the page can show whatever is ready.
// Jira's two sources only run when Jira is the tracker; otherwise they say so and stay empty.
const jiraOnly = (fetch) => () => (tracker() === 'jira' ? fetch() : Promise.resolve({ disabled: true, tracker: tracker() }));
export const SOURCES = { github: fetchGitHub, jira: jiraOnly(fetchJiraWork), jiraMentions: jiraOnly(fetchJiraMentions), calendar: fetchCalendar };
for (const p of plugins.sources.values()) {
  SOURCES[p.name] = async () => {
    if (p.enabled && !p.enabled(process.env)) return { disabled: true };
    const data = await p.fetch(makeContext(p));
    // The rows for its panel, worked out here so the page needs no code from the source.
    const items = hook(p, 'items', data);
    return { ...data, ...(items && { items: items.hookError ? [] : asList(items), ...(items.hookError && { error: items.hookError }) }) };
  };
}
// What each module holds and reaches, for Settings → Plugins. Secret values never leave here:
// `set` only says whether one is saved.
export const BUILTIN_MANIFESTS = [
  githubManifest,
  jiraManifest,
  calendarManifest,
  { name: 'copilot', label: 'Copilot', area: 'work', secrets: [{ kind: 'cli-login', note: 'none from Clearsky (its tokens are removed from Copilot\'s environment); Copilot keeps its own login in ~/.copilot or the keyring' }],
    hosts: ['*.githubcopilot.com', 'github.com'], clis: ['copilot'], files: ['~/.copilot', 'your Copilot folders'],
    note: 'Settings → Agent → Sandbox limits it to your folders and listed hosts.' },
  { name: 'links', label: 'Links', area: 'work', description: 'Your favourite links, in the menu. Edit them in Clearsky.', secrets: [], files: ['~/.config/clearsky/links.json'],
    note: 'Your favourites, edited in Clearsky. Only http(s) links; Clearsky never opens them itself.' },
];
export const linksFile = () => join(dirname(userEnvFile), 'links.json');
export function moduleManifests(env = process.env) {
  const fromPlugin = (p) => ({ name: p.name, label: p.label, area: p.area, ...(p.manifest || {}),
    plugin: p.plugin ? { from: p.plugin.from, run: p.plugin.run, version: p.plugin.version, commit: p.plugin.commit } : { from: '~/.config/clearsky/sources', run: 'inside' },
    secrets: p.manifest?.secrets || Object.entries(p.settings || {}).filter(([, f]) => f.secret).map(([key]) => ({ key, kind: 'token' })) });
  return [...BUILTIN_MANIFESTS, ...[...plugins.sources.values()].map(fromPlugin)].map((m) => ({
    hosts: [], clis: [], files: [], ...m,
    secrets: (m.secrets || []).map((x) => ({ ...x, ...(x.key && { set: !!env[x.key] }) })),
  }));
}

// Each source's data as rows of the one item model (lib/items.mjs).
const WORK_ITEMS = { github: githubItems, jira: jiraItems, jiraMentions: jiraMentionItems };
export function workItemsOf(name, data) {
  try {
    if (WORK_ITEMS[name]) return WORK_ITEMS[name](data);
    const p = plugins.sources.get(name);
    return p ? pluginItems(p, data) : [];
  } catch (e) {
    console.error(`clearsky: items from ${name}: ${e.message}`);
    return [];
  }
}
export const pluginData = async (force) => Object.fromEntries(await Promise.all([...plugins.sources.keys()].map(async (n) => [n, await source(n, force)])));
export const sourceCache = new Map();

// Snappy clicking: fresh data (CLEARSKY_CACHE_SECONDS, 2 min) is served as is; older data is
// still served at once while a new fetch runs behind it, and the page picks that up when it
// lands (dataVersion, via /api/attention). Only Refresh, or data over STALE_MAX old, waits.
export const STALE_MAX = 30 * 6e4;
export let dataVersion = 0;
// Each source's last good answer, however old: shown (marked) when its login is lost.
const lastGood = new Map();
export function source(name, force) {
  const hit = sourceCache.get(name);
  if (!force && hit?.data && Date.now() - hit.at < config.cacheSeconds * 1000) return Promise.resolve(hit.data);
  if (hit?.pending) return !force && hit.data && Date.now() - hit.at < STALE_MAX ? Promise.resolve(hit.data) : hit.pending;
  const pending = (needsVpn(name) ? vpn.check() : Promise.resolve(null)).then((v) => (v?.known && !v.up ? { paused: 'VPN off', why: v.why } : settle(SOURCES[name]()))).then((data) => {
    // Logged out: what was there stays, marked as no longer updating, instead of a blank panel.
    const good = lastGood.get(name);
    if (data?.needsLogin && good) data = { ...good.data, notUpdating: `Not logged in, so nothing new is coming in. This is from ${sameDay(new Date(good.at), new Date()) ? '' : `${new Date(good.at).toLocaleDateString()} `}${clock(good.at)}.`, needsLogin: true, staleSince: new Date(good.at).toISOString() };
    else if (data && !data.error && !data.paused && !data.disabled) lastGood.set(name, { at: Date.now(), data });
    sourceCache.set(name, { at: Date.now(), data });
    dataVersion++;
    saveSourceCache();
    return data;
  });
  sourceCache.set(name, { ...hit, pending });
  return !force && hit?.data && Date.now() - hit.at < STALE_MAX ? Promise.resolve(hit.data) : pending;
}

// The last good data per source, kept across a Restart so the page fills at once (as stale,
// refreshed behind it). In ~/.config/clearsky, which chats can't see; only `serve` uses it.
let sourceCacheFile = null, saveTimer = null;
export function loadSourceCache(file) {
  sourceCacheFile = file;
  try {
    for (const [name, e] of Object.entries(JSON.parse(readFileSync(file, 'utf8')))) {
      if (!e?.data || e.data.error) continue;
      if ((name === 'jira' || name === 'jiraMentions') && tracker() !== 'jira') continue; // Jira was the tracker before
      lastGood.set(name, { at: e.at, data: e.data });
      if (Date.now() - e.at < STALE_MAX) sourceCache.set(name, { at: e.at, data: e.data });
    }
  } catch {}
}
function saveSourceCache() {
  if (!sourceCacheFile || saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const out = Object.fromEntries([...lastGood].map(([n, e]) => [n, { at: e.at, data: e.data }]));
    try { writeFileSync(sourceCacheFile, JSON.stringify(out), { mode: 0o600 }); } catch {}
  }, 2000);
  saveTimer.unref?.();
}

// Your PRs with "read by you" (lib/own-read.mjs): your marks, and what Clearsky's chats pushed.
// The commits themselves stay here; the page gets the summary.
export const prReadKey = (url) => `prread:${url}`;
export function withOwn(data) {
  if (!data?.myPrs) return data;
  const reads = localState.readMarks(stateFile), pushes = chatPushes(readWrites(agentLogFile, { limit: 5000 }));
  return { ...data, myPrs: data.myPrs.map(({ commits, ...p }) => ({ ...p, own: ownRead({ ...p, commits }, { login: data.login, name: data.name }, reads[prReadKey(p.url)], pushes) })) };
}

export async function collect(force) {
  const [rawGithub, jiraWork, jiraMentions, calendar] = await Promise.all(
    ['github', 'jira', 'jiraMentions', 'calendar'].map((n) => source(n, force)));
  const github = withOwn(rawGithub);
  const jira = mergeJira(jiraWork, jiraMentions);
  const needsMe = (github.myPrs || []).filter((p) => p.status.owner === 'me' && !p.draft);
  const extra = await pluginData(force);
  // Events from other sources (school, activities) join your calendar in Now / Next.
  const more = [...plugins.sources.values()].flatMap((p) => (extra[p.name]?.error || extra[p.name]?.disabled ? []
    : asList(hook(p, 'events', extra[p.name])).map((e) => ({ ...e, calendar: e.calendar || p.label }))));
  const cal = more.length ? { ...calendar, events: [...(calendar.events || []), ...more] } : calendar;
  // Tasks plugins suggest for the next free slot (their plan() hook), work ones only.
  const ok = (p) => !(extra[p.name]?.error || extra[p.name]?.disabled || extra[p.name]?.paused);
  const extraTasks = [...plugins.sources.values()].filter((p) => p.area === 'work' && ok(p))
    .flatMap((p) => asList(hook(p, 'plan', extra[p.name])).filter((t) => t?.title && (t.key || t.url))
      .map((t) => ({ title: String(t.title), detail: t.detail || '', url: t.url || null, stamp: t.stamp, minutes: Math.min(Math.max(Number(t.minutes) || 15, 5), 240), why: t.why || p.label, key: `${p.name}:${t.key || t.url}` })));
  const pluginMentions = [...plugins.sources.values()].filter(ok).flatMap((p) => workItemsOf(p.name, extra[p.name])).filter((i) => i.kind === 'mention').length;
  return {
    generatedAt: new Date().toISOString(),
    plan: planNow({ github, jira, calendar: cal, extraTasks }),
    nextStandup: nextStandup().toISOString(),
    summary: {
      reviewsWaiting: github.reviewRequested?.length ?? null,
      myPrsNeedingAction: github.myPrs ? needsMe.length : null,
      myPrsWaitingOnOthers: github.myPrs ? github.myPrs.filter((p) => p.status.owner === 'others').length : null,
      mentions: (github.mentions?.length || 0) + (jira.mentions?.length || 0) + pluginMentions,
      jiraOpen: jira.assigned?.length ?? null,
      jiraInProgress: jira.assigned ? jira.assigned.filter((i) => i.statusCategory === 'indeterminate').length : null,
    },
    github,
    jira,
    calendar: cal,
    sources: extra,
    // Everything that can need you, from every source, with the next step on each.
    items: [['github', github], ['jira', jiraWork], ['jiraMentions', jiraMentions], ...Object.entries(extra)].flatMap(([n, d]) => workItemsOf(n, d)),
  };
}

// ---------------------------------------------------------------- Markdown

function ago(iso) {
  if (!iso) return '';
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function toMarkdown(d) {
  const out = [`# Clearsky (${new Date(d.generatedAt).toLocaleDateString()} ${clock(d.generatedAt)})`, ''];
  const section = (title, items, line, error) => {
    out.push(`## ${title}${items ? ` (${items.length})` : ''}`);
    if (error) out.push(`_Unavailable: ${error}_`);
    else if (!items.length) out.push('_Nothing here._');
    else for (const i of items) out.push(`- ${line(i)}`);
    out.push('');
  };
  const g = d.github, j = d.jira, p = d.plan;
  const hm = clock;
  out.push('## Now / Next');
  if (d.calendar?.error) out.push(`_Calendar unavailable: ${d.calendar.error}_`);
  if (p.now) out.push(`Now: **${p.now.title}** until ${hm(p.now.end)}`);
  if (p.afterHours) out.push('After hours.');
  else out.push(`Free for **${p.freeMinutes} min** from ${hm(p.freeFrom)}` +
    (p.next ? `, then **${p.next.title}** at ${hm(p.next.start)}` : ', until the end of the workday'));
  for (const sg of p.suggestions) out.push(`- [${sg.title}](${sg.url}) ~${sg.minutes} min, ${sg.why}: ${sg.detail}`);
  out.push('');
  section('Needs my review', g.reviewRequested, (p) =>
    `[${p.repo}#${p.number}](${p.url}) ${p.title} by @${p.author}, requested ${ago(p.requestedAt)}` +
    `${p.rerequested ? ', re-requested' : ''}${p.viaTeam ? ', via team' : ''}${p.draft ? ', draft' : ''}` +
    ` (+${p.size.additions}/-${p.size.deletions}, ${p.size.files} files)`, g.error);
  section('My PRs', g.myPrs, (p) =>
    `**${p.status.label}** (${p.status.owner === 'me' ? 'your move' : 'waiting'}) [${p.repo}#${p.number}](${p.url}) ${p.title}` +
    `${p.approvals.length ? `, approved by ${p.approvals.join(', ')}` : ''}` +
    `${p.changesRequested.length ? `, changes requested by ${p.changesRequested.join(', ')}` : ''}` +
    `${p.pendingReviewers.length ? `, waiting on ${p.pendingReviewers.join(', ')}` : ''}`, g.error);
  section('GitHub mentions', g.mentions, (m) =>
    `[${m.repo}#${m.number}](${m.url}) ${m.kind}: ${m.title}, updated ${ago(m.updatedAt)}`, g.error);
  const jiraOn = !j.disabled;
  if (jiraOn) section('Jira mentions', j.mentions || [], (m) =>
    `[${m.key}](${m.url}) ${m.summary}: ${m.by}, ${ago(m.at)}: "${m.excerpt}"`, j.error);
  // Work plugins, each with its own section (their markdown() hook).
  for (const p of plugins.sources.values()) {
    const sd = d.sources?.[p.name];
    if (p.area !== 'work' || !sd || sd.disabled) continue;
    const m = sd.error ? null : hook(p, 'markdown', sd);
    if (sd.error) section(p.label, null, null, sd.error);
    else if (m && !m.hookError && Array.isArray(m.lines)) section(String(m.title || p.label), m.lines, (l) => String(l), null);
  }
  if (jiraOn) section('My Jira issues', j.assigned || [], (i) =>
    `[${i.key}](${i.url}) ${i.summary} [${i.status}${i.priority ? `, ${i.priority}` : ''}${i.due ? `, due ${i.due}` : ''}]`, j.error);
  if (g.assigned?.length) section('GitHub issues assigned to me', g.assigned, (i) =>
    `[${i.repo}#${i.number}](${i.url}) ${i.title}`, null);
  return out.join('\n');
}
