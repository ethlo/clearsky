#!/usr/bin/env node
// clearsky: one view of what needs your attention on GitHub, Jira and Slack.
// Zero dependencies, Node 22+. See README.md.
//
//   clearsky              print a Markdown summary
//   clearsky --json       print the raw data as JSON (for Copilot skills / scripts)
//   clearsky serve        serve the dashboard on http://127.0.0.1:7777

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync, statSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { delimiter } from 'node:path';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import * as settings from '../lib/settings.mjs';
import * as localState from '../lib/state.mjs';
import * as copilot from '../lib/copilot.mjs';
import { AcpAgent, chatEvent } from '../lib/acp.mjs';
import { sessionEvents, sessionUsage } from '../lib/copilot-events.mjs';
import { branchesFor } from '../lib/branches.mjs';
import { sandboxedCommand, sandboxEnded, stopSandbox, githubLogin, DEFAULT_DOMAINS, READ_DEFAULT, parseDomains } from '../lib/sandbox.mjs';
import { serveBroker, brokerSocket } from '../lib/broker.mjs';
import { mavenSandbox, sandboxCa } from '../lib/maven.mjs';
import { githubFilter } from '../lib/github-gate.mjs';
import { attentionItems, diffAttention, desktopNotify, DbusNotifier } from '../lib/notify.mjs';
import { loadSources, makeContext, hook, asList } from '../lib/sources.mjs';
import { pluginItems } from '../lib/items.mjs';
import { manifest as slackManifest, createSlack, workItems as slackItems } from '../lib/modules/slack.mjs';
import { findBrowser, BROWSERS } from '../lib/browser.mjs';
import { manifest as calendarManifest, createCalendar } from '../lib/modules/calendar.mjs';
import { manifest as githubManifest, createGitHub, workItems as githubItems, PR_FIELDS, ITEM_FIELDS, ciState, isBot, latestReviewsByUser, openThreads, humanReviewers, myPrStatus, reviewerName } from '../lib/modules/github.mjs';
import { manifest as jiraManifest, createJira, workItems as jiraItems, mentionItems as jiraMentionItems, listOf, fieldsOf, nameOf, commentInfo, excerpt, userId, mapLimit, JIRA_WAITING, jiraMentionsByTicket, mergeJira } from '../lib/modules/jira.mjs';

// ---------------------------------------------------------------- config

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let value = m[2];
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

const here = dirname(fileURLToPath(import.meta.url));
export const userEnvFile = join(homedir(), '.config', 'clearsky', '.env');
const stateFile = process.env.CLEARSKY_STATE || join(homedir(), '.config', 'clearsky', 'state.json');
loadEnvFile(join(process.cwd(), '.env'));
loadEnvFile(join(here, '..', '.env'));
loadEnvFile(userEnvFile);

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

// "Mon-Fri", "Sun-Thu" or "Mon,Tue,Thu" -> set of JS weekday numbers.
export function parseWorkdays(spec) {
  const days = new Set();
  for (const part of spec.toLowerCase().split(',').map((p) => p.trim()).filter(Boolean)) {
    const [a, b] = part.split('-').map((x) => DAY_NAMES.indexOf(x.slice(0, 3)));
    if (a < 0 || (b !== undefined && b < 0)) throw new Error(`bad workday "${part}"`);
    if (b === undefined) { days.add(a); continue; }
    for (let d = a; ; d = (d + 1) % 7) { days.add(d); if (d === b) break; }
  }
  return days;
}

const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);

// Built from the environment; rebuilt when settings are saved from the page.
const buildConfig = (env = process.env) => ({
  days: Number(env.CLEARSKY_MENTION_DAYS || 14),
  cacheSeconds: Number(env.CLEARSKY_CACHE_SECONDS || 120),
  port: Number(env.CLEARSKY_PORT || 7777),
  // Where it listens: this machine only. A container sets 0.0.0.0 and publishes the port to
  // the host's 127.0.0.1 (see Dockerfile).
  bind: env.CLEARSKY_BIND || '127.0.0.1',
  github: {
    token: env.GITHUB_TOKEN,
    api: (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, ''),
    orgs: list(env.GITHUB_ORGS),
    ignoreAuthors: list(env.CLEARSKY_IGNORE_AUTHORS),
  },
  jira: {
    acli: env.ACLI_BIN || 'acli',
    url: (env.JIRA_URL || '').replace(/\/$/, ''), // optional: base for browse links
    accountId: env.JIRA_ACCOUNT_ID, // optional: skips the lookup of your account id
    assignedJql: env.JIRA_ASSIGNED_JQL ||
      'assignee = currentUser() AND statusCategory != Done ORDER BY priority DESC, updated DESC',
    mentionsJql: env.JIRA_MENTIONS_JQL,
  },
  calendar: {
    icsUrl: env.CALENDAR_ICS_URL || env.GOOGLE_CALENDAR_ICS, // optional; Google Calendar "secret address in iCal format"
    email: env.CALENDAR_EMAIL, // used to drop events you declined, and to find your Evolution calendar
    evolution: env.EVOLUTION_CALENDARS, // optional; Evolution calendar names or uids to read
  },
  workdayEnd: env.CLEARSKY_WORKDAY_END || '17:00',
  standupTime: env.CLEARSKY_STANDUP_TIME || '09:45', // daily stand-up (local time)
  workdays: parseWorkdays(env.CLEARSKY_WORKDAYS || 'Mon-Fri'),
  slack: {
    token: env.SLACK_TOKEN, // optional; user token (xoxp-) with search:read
    api: (env.SLACK_API_URL || 'https://slack.com/api').replace(/\/$/, ''),
  },
});
const config = buildConfig();

// Extra sources: lib/sources/*.mjs and your own in ~/.config/clearsky/sources/*.mjs.
const builtinSources = join(here, '..', 'lib', 'sources');
const plugins = await loadSources([builtinSources, process.env.CLEARSKY_SOURCES_DIR || join(homedir(), '.config', 'clearsky', 'sources')], { trusted: [builtinSources] });
for (const e of plugins.errors) console.error(`clearsky: ${e}`);
for (const p of plugins.sources.values()) settings.addFields(p.settings);

// ---------------------------------------------------------------- helpers

const daysAgoIso = (d) => new Date(Date.now() - d * 864e5).toISOString().slice(0, 10);

async function http(url, { headers = {}, body, method } = {}) {
  const res = await fetch(url, {
    method: method || (body ? 'POST' : 'GET'),
    headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`${res.status} ${res.statusText} from ${new URL(url).host}: ${text.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return text ? JSON.parse(text) : null;
}

// ---------------------------------------------------------------- GitHub and Jira (lib/modules)

const execFileP = promisify(execFile);
// A source that fails gives { error } instead of taking the others down.
const settle = (p) => p.catch((e) => ({ error: e.message, ...(e.auth && { needsLogin: true }) }));

const ghModule = createGitHub({ config, http, execFileP, daysAgoIso });
const { gql, reviewerOptions, requestReviews, mergePr, ghCliToken } = ghModule;
const fetchGitHub = ghModule.fetch;
export { isBot, openThreads, myPrStatus };

const jiraModule = createJira({ config, execFileP, settle });
const { acli, jiraSearch, jiraComments, jiraSite, browseUrl, jiraDebug } = jiraModule;
const fetchJiraWork = jiraModule.fetchWork, fetchJiraMentions = jiraModule.fetchMentions;
export const issuePreview = (key) => jiraModule.issuePreview(key);

// ---------------------------------------------------------------- Slack and Calendar (lib/modules)

const slackModule = createSlack({ config, http, daysAgoIso });
const fetchSlack = slackModule.fetch;
const fetchCalendar = createCalendar({ config }).fetch;

// ---------------------------------------------------------------- Now / Next

export const hiddenCalendars = () => new Set((process.env.CALENDAR_HIDDEN || '').split(',').map((n) => n.trim().toLowerCase()).filter(Boolean));

// Clock times in 24-hour format unless CLEARSKY_TIME_FORMAT=12.
export const clock = (d) => new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: process.env.CLEARSKY_TIME_FORMAT === '12' ? 'h12' : 'h23' });

function atLocalTime(base, hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date(base); d.setHours(h, m || 0, 0, 0);
  return d.getTime();
}

function reviewMinutes(p) {
  if (p.rerequested) return 15;
  const lines = (p.size?.additions || 0) + (p.size?.deletions || 0);
  return lines < 100 ? 15 : lines < 500 ? 30 : 60;
}

// What to do in the next free slot: the current/next meeting, how long the gap is,
// and up to three tasks that fit it, most urgent first.
export function planNow(d, now = Date.now(), dismissedItems = localState.dismissed(stateFile), mutedItems = localState.muted(stateFile, now),
  doneAt = localState.doneAt(stateFile)) {
  const g = d.github || {}, j = d.jira || {}, s = d.slack || {}, cal = d.calendar || {};
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
    ...(s.mentions || []).filter((m) => recent(m.at, 24))
      .map((m) => ({ title: `Reply to ${m.by} in ${m.channel}`, detail: m.excerpt, url: m.url, stamp: m.stamp, minutes: 5, why: 'Slack mention' })),
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
const SOURCES = { github: fetchGitHub, jira: fetchJiraWork, jiraMentions: fetchJiraMentions, slack: fetchSlack, calendar: fetchCalendar };
for (const p of plugins.sources.values()) {
  SOURCES[p.name] = async () => {
    if (p.enabled && !p.enabled(process.env)) return { disabled: true };
    const data = await p.fetch(makeContext(p));
    // The rows for its panel, worked out here so the page needs no code from the source.
    const items = hook(p, 'items', data);
    return { ...data, ...(items && { items: items.hookError ? [] : asList(items), ...(items.hookError && { error: items.hookError }) }) };
  };
}
// What each module holds and reaches, for Settings → Modules. Secret values never leave here:
// `set` only says whether one is saved.
const BUILTIN_MANIFESTS = [
  githubManifest,
  jiraManifest,
  slackManifest,
  calendarManifest,
  { name: 'copilot', label: 'Copilot', area: 'work', secrets: [{ kind: 'cli-login', note: 'none from Clearsky (its tokens are removed from Copilot\'s environment); Copilot keeps its own login in ~/.copilot or the keyring' }],
    hosts: ['*.githubcopilot.com', 'github.com'], clis: ['copilot'], files: ['~/.copilot', 'your Copilot folders'],
    note: 'Settings → Copilot → Sandbox limits it to your folders and listed hosts.' },
];
export function moduleManifests(env = process.env) {
  const fromPlugin = (p) => ({ name: p.name, label: p.label, area: p.area, ...(p.manifest || {}),
    secrets: p.manifest?.secrets || Object.entries(p.settings || {}).filter(([, f]) => f.secret).map(([key]) => ({ key, kind: 'token' })) });
  return [...BUILTIN_MANIFESTS, ...[...plugins.sources.values()].map(fromPlugin)].map((m) => ({
    hosts: [], clis: [], files: [], ...m,
    secrets: (m.secrets || []).map((x) => ({ ...x, ...(x.key && { set: !!env[x.key] }) })),
  }));
}

// Each source's data as rows of the one item model (lib/items.mjs).
const WORK_ITEMS = { github: githubItems, jira: jiraItems, jiraMentions: jiraMentionItems, slack: slackItems };
function workItemsOf(name, data) {
  try {
    if (WORK_ITEMS[name]) return WORK_ITEMS[name](data);
    const p = plugins.sources.get(name);
    return p ? pluginItems(p, data) : [];
  } catch (e) {
    console.error(`clearsky: items from ${name}: ${e.message}`);
    return [];
  }
}
const pluginData = async (force) => Object.fromEntries(await Promise.all([...plugins.sources.keys()].map(async (n) => [n, await source(n, force)])));
const sourceCache = new Map();

export function source(name, force) {
  const hit = sourceCache.get(name);
  if (hit?.pending) return hit.pending;
  if (!force && hit && Date.now() - hit.at < config.cacheSeconds * 1000) return Promise.resolve(hit.data);
  const pending = settle(SOURCES[name]()).then((data) => {
    sourceCache.set(name, { at: Date.now(), data });
    return data;
  });
  sourceCache.set(name, { ...hit, pending });
  return pending;
}

export async function collect(force) {
  const [github, jiraWork, jiraMentions, slack, calendar] = await Promise.all(
    ['github', 'jira', 'jiraMentions', 'slack', 'calendar'].map((n) => source(n, force)));
  const jira = mergeJira(jiraWork, jiraMentions);
  const needsMe = (github.myPrs || []).filter((p) => p.status.owner === 'me' && !p.draft);
  const extra = await pluginData(force);
  // Events from other sources (school, activities) join your calendar in Now / Next.
  const more = [...plugins.sources.values()].flatMap((p) => (extra[p.name]?.error || extra[p.name]?.disabled ? []
    : asList(hook(p, 'events', extra[p.name])).map((e) => ({ ...e, calendar: e.calendar || p.label }))));
  const cal = more.length ? { ...calendar, events: [...(calendar.events || []), ...more] } : calendar;
  return {
    generatedAt: new Date().toISOString(),
    plan: planNow({ github, jira, slack, calendar: cal }),
    nextStandup: nextStandup().toISOString(),
    summary: {
      reviewsWaiting: github.reviewRequested?.length ?? null,
      myPrsNeedingAction: github.myPrs ? needsMe.length : null,
      myPrsWaitingOnOthers: github.myPrs ? github.myPrs.filter((p) => p.status.owner === 'others').length : null,
      mentions: (github.mentions?.length || 0) + (jira.mentions?.length || 0) + (slack.mentions?.length || 0),
      jiraOpen: jira.assigned?.length ?? null,
      jiraInProgress: jira.assigned ? jira.assigned.filter((i) => i.statusCategory === 'indeterminate').length : null,
    },
    github,
    jira,
    slack,
    calendar: cal,
    sources: extra,
    // Everything that can need you, from every source, with the next step on each.
    items: [['github', github], ['jira', jiraWork], ['jiraMentions', jiraMentions], ['slack', slack], ...Object.entries(extra)].flatMap(([n, d]) => workItemsOf(n, d)),
  };
}

// ---------------------------------------------------------------- Stand-up

const isWorkday = (d) => config.workdays.has(d.getDay());
const sameDay = (a, b) => a.toDateString() === b.toDateString();

function standupOn(day) {
  const [h, m] = config.standupTime.split(':').map(Number);
  const d = new Date(day); d.setHours(h, m || 0, 0, 0);
  return d;
}

// The next stand-up: today's if it hasn't started more than 15 minutes ago, else the next workday's.
export function nextStandup(now = new Date()) {
  let d = standupOn(now);
  if (!config.workdays.size) return d;
  while (!isWorkday(d) || +d + 15 * 6e4 <= +now) { d.setDate(d.getDate() + 1); d = standupOn(d); }
  return d;
}

// The stand-up before the next one; the summary covers everything since then.
export function previousStandup(now = new Date()) {
  const d = nextStandup(now);
  do d.setDate(d.getDate() - 1); while (!isWorkday(d));
  return standupOn(d);
}

async function standupGitHub(since) {
  config.github.token ||= await ghCliToken();
  if (!config.github.token) return { error: 'GITHUB_TOKEN is not set and `gh auth token` gave nothing' };
  const { viewer } = await gql('query { viewer { login } }');
  const me = viewer.login;
  const scope = `${config.github.orgs.map((o) => `org:${o}`).join(' ')} archived:false`;
  const day = since.toISOString().slice(0, 10);
  const data = await gql(
    `query($mine: String!, $reviewed: String!, $me: String!) {
      mine: search(query: $mine, type: ISSUE, first: 50) { nodes { ... on PullRequest {
        number title url state isDraft createdAt mergedAt repository { nameWithOwner }
        commits(last: 100) { nodes { commit { committedDate authors(first: 5) { nodes { email user { login } } } } } } } } }
      reviewed: search(query: $reviewed, type: ISSUE, first: 50) { nodes { ... on PullRequest {
        number title url repository { nameWithOwner } author { login }
        reviews(last: 20, author: $me) { nodes { state submittedAt } } } } }
    }`,
    {
      mine: `is:pr author:${me} updated:>=${day} ${scope}`,
      reviewed: `is:pr reviewed-by:${me} -author:${me} updated:>=${day} ${scope}`,
      me,
    },
  );
  const after = (iso) => iso && Date.parse(iso) >= since.getTime();
  const pr = (p) => ({ repo: p.repository.nameWithOwner, number: p.number, title: p.title, url: p.url });
  const mine = data.mine.nodes.filter((p) => p?.number);
  // Commits are counted from my PRs: GitHub's contribution counts hide private org work
  // ("restricted contributions"), so contributionsCollection reports 0 there.
  const commitsByRepo = new Map();
  for (const p of mine) {
    // On my own PRs, a commit is mine if GitHub links it to me, or if it isn't linked to any
    // account (an email not added to GitHub) and isn't a GitHub noreply address of someone else.
    const mineCommit = (a) => a.user?.login === me || (!a.user && !/@users\.noreply\.github\.com$/i.test(a.email || ''));
    const n = (p.commits?.nodes || []).filter((c) => after(c.commit.committedDate) &&
      c.commit.authors.nodes.some(mineCommit)).length;
    if (n) commitsByRepo.set(p.repository.nameWithOwner, (commitsByRepo.get(p.repository.nameWithOwner) || 0) + n);
  }
  return {
    merged: mine.filter((p) => after(p.mergedAt)).map(pr),
    opened: mine.filter((p) => after(p.createdAt) && !after(p.mergedAt)).map((p) => ({ ...pr(p), draft: p.isDraft })),
    reviewed: data.reviewed.nodes.filter((p) => p?.number).map((p) => {
      const mineNow = p.reviews.nodes.filter((r) => after(r.submittedAt) && r.state !== 'PENDING');
      return mineNow.length ? { ...pr(p), author: p.author?.login, verdict: mineNow.at(-1).state } : null;
    }).filter(Boolean),
    commits: [...commitsByRepo].map(([repo, count]) => ({ repo, count })),
  };
}

async function standupJira(since) {
  await jiraSite();
  const days = Math.max(1, Math.ceil((Date.now() - since.getTime()) / 864e5));
  const fields = ['key', 'summary', 'status'];
  let issues;
  try {
    issues = await jiraSearch(`issuekey IN updatedBy(currentUser(), "-${days}d") ORDER BY updated DESC`, fields, 50);
  } catch {
    // Not every site has updatedBy(); status changes are the next best signal.
    issues = await jiraSearch(`status CHANGED BY currentUser() AFTER -${days}d ORDER BY updated DESC`, fields, 50);
  }
  const shaped = issues.map((i) => {
    const f = fieldsOf(i);
    return { key: i.key, summary: f.summary, url: browseUrl(i), status: nameOf(f.status), done: f.status?.statusCategory?.key === 'done' };
  });
  return { done: shaped.filter((i) => i.done), touched: shaped.filter((i) => !i.done) };
}

const verdictText = { APPROVED: 'approved', CHANGES_REQUESTED: 'requested changes', COMMENTED: 'commented', DISMISSED: 'dismissed' };

export function standupText(s) {
  const out = [];
  const y = s.yesterday, t = s.today;
  const line = (x) => out.push(`- ${x}`);
  out.push(`*Yesterday* (since ${s.sinceLabel})`);
  y.github.merged?.forEach((p) => line(`Merged ${p.repo}#${p.number}: ${p.title}`));
  y.jira.done?.forEach((i) => line(`Finished ${i.key}: ${i.summary}`));
  y.github.opened?.forEach((p) => line(`Opened ${p.draft ? 'draft ' : ''}${p.repo}#${p.number}: ${p.title}`));
  y.github.reviewed?.forEach((p) => line(`Reviewed ${p.repo}#${p.number} by ${p.author} (${verdictText[p.verdict] || p.verdict})`));
  y.jira.touched?.forEach((i) => line(`Worked on ${i.key}: ${i.summary} (${i.status})`));
  const commits = (y.github.commits || []).filter((c) => c.count);
  if (commits.length) line(`Commits: ${commits.map((c) => `${c.count} in ${c.repo.split('/')[1]}`).join(', ')}`);
  s.extra?.forEach((x) => x.yesterday.forEach((t) => line(`${x.label}: ${t}`)));
  y.copilot?.sessions?.forEach((x) => line(`With Copilot: ${x.ticket ? `${x.ticket} ` : ''}${x.title} (${x.repo.split('/')[1]}${x.branch && !/^(main|master)$/.test(x.branch) ? `, ${x.branch}` : ''})`));
  if (out.length === 1) line('Nothing recorded on GitHub, Jira or Copilot.');
  out.push('', '*Today*');
  const before = out.length;
  t.inProgress.forEach((i) => line(`Continue ${i.key}: ${i.summary}`));
  if (t.reviews.length) line(`Review ${t.reviews.map((p) => `${p.repo}#${p.number}`).join(', ')}`);
  t.myPrs.forEach((p) => line(`${p.status.label}: ${p.repo}#${p.number} ${p.title}`));
  s.extra?.forEach((x) => x.today.forEach((t) => line(`${x.label}: ${t}`)));
  if (t.meetings.length) line(`Meetings: ${t.meetings.map((e) => `${clock(e.start)} ${e.title}`).join(', ')}`);
  if (out.length === before) line('Pick up the next item from the queue.');
  out.push('', '*Blockers*');
  if (s.blockers.length) s.blockers.forEach((b) => line(b.text));
  else line('None');
  return out.join('\n');
}

// What to say at stand-up, in your words rather than a list of tickets: Copilot turns the
// stand-up above into a few spoken sentences, grouped by what the work is for. It gets the text
// only, no tools; the answer is kept until the next stand-up or a new one is asked for.
const SAY_PROMPT = `This is my stand-up, as a list from my GitHub, Jira and Copilot work. Write what I'll say in the meeting:
first person, spoken and plain, 4 to 7 short sentences in three short paragraphs (yesterday, today, blockers).
Group the work by what it's for (the feature or problem), not ticket by ticket; name a ticket key only when it helps
people find it, and leave out repo names, PR numbers and statuses unless they matter (say "it's in review" rather
than a status). Don't invent anything that isn't in the list. If there are no blockers, say so in a few words.
Answer with the text only, no headings or bullets.

`;
let sayCache = { key: null, text: null, at: null };
async function standupSay(s, force) {
  const key = `${s.sinceLabel}|${s.text}`;
  if (!force && sayCache.key === key) return sayCache;
  const info = await copilotInfo();
  if (!info.available) throw new Error('Copilot CLI not found');
  const text = await new Promise((done, fail) => {
    let out = '';
    copilot.runCopilot(info.bin, copilot.copilotArgs({ prompt: SAY_PROMPT + s.text, permission: 'read', model: process.env.COPILOT_MODEL || undefined, cwd: copilotCwd() }), {
      env: copilotEnv(), timeoutMs: 120_000, onData: (d) => { out += d; },
      onEnd: ({ code, stderr }) => (code === 0 && out.trim() ? done(out.trim()) : fail(new Error(stderr.trim().split('\n').pop() || `Copilot exited with ${code}`))),
    });
  });
  sayCache = { key, text, at: new Date().toISOString() };
  return sayCache;
}

// Copilot sessions you worked in since the last stand-up: local work that may not be
// on GitHub or Jira yet. Titles are Copilot's own summaries of each session.
async function standupCopilot(since) {
  const info = await copilotInfo();
  if (!info.available) return { sessions: [] };
  const orgs = new Set(config.github.orgs.map((o) => o.toLowerCase()));
  // Only work repositories, and not chats from this panel (they're about the dashboard).
  const sessions = (await copilotSessions(info.bin))
    .filter((x) => x.title && Date.parse(x.updatedAt) >= +since && x.cwd !== copilotCwd())
    .map((x) => ({ ...x, ws: workspaceInfo(x.id) }))
    .filter((x) => orgs.has(x.ws.repository?.split('/')[0]?.toLowerCase()) && !/review/i.test(x.ws.client_name || ''));
  return {
    sessions: sessions.slice(0, 12).map(({ id, title, ws }) => ({
      id, title, repo: ws.repository, branch: ws.branch || null,
      ticket: (ws.branch || '').toUpperCase().match(/\b([A-Z][A-Z0-9_]+-\d+)\b/)?.[1] || null,
    })),
  };
}

function workspaceInfo(id) {
  const out = {};
  try {
    for (const line of readFileSync(join(copilotHome(), 'session-state', id, 'workspace.yaml'), 'utf8').split('\n')) {
      const m = line.match(/^(repository|branch|client_name):\s*["']?([^"'\s]+)["']?\s*$/);
      if (m) out[m[1]] = m[2];
    }
  } catch { /* no workspace file */ }
  return out;
}

// `since` overrides the start of the window (used by tests).
export async function standup(work, since = previousStandup()) {
  const next = nextStandup();
  const [github, jira, copilotWork] = await Promise.all([settle(standupGitHub(since)), settle(standupJira(since)), settle(standupCopilot(since))]);
  const w = work || await collect();
  const today = {
    inProgress: (w.jira.assigned || []).filter((i) => i.statusCategory === 'indeterminate').slice(0, 5),
    reviews: w.github.reviewRequested || [],
    myPrs: (w.github.myPrs || []).filter((p) => p.status.owner === 'me' && !p.draft),
    meetings: (w.plan?.agenda || []).filter((e) => sameDay(new Date(e.start), new Date()) && e.title !== 'Stand-up'),
  };
  const days = (iso) => (Date.now() - Date.parse(iso)) / 864e5;
  const blockers = (w.github.myPrs || [])
    .filter((p) => p.status.owner === 'others' && p.status.label === 'Waiting for review' && days(p.updatedAt) >= 1)
    .map((p) => ({ url: p.url, text: `${p.repo}#${p.number} has waited ${Math.floor(days(p.updatedAt))}d for review` +
      (p.pendingReviewers.length ? ` (${p.pendingReviewers.join(', ')})` : '') }));
  const s = {
    generatedAt: new Date().toISOString(),
    since: since.toISOString(),
    sinceLabel: `${since.toLocaleDateString([], { weekday: 'long' })} ${clock(since)}`,
    nextStandup: next.toISOString(),
    jiraBase: jiraModule.site,
    yesterday: { github, jira, copilot: copilotWork },
    today,
    blockers,
  };
  // Other sources add their own lines, such as what's on at school today.
  const extra = w.sources || await pluginData(false);
  s.extra = [...plugins.sources.values()].map((p) => {
    const r = extra[p.name]?.error || extra[p.name]?.disabled ? null : hook(p, 'standup', extra[p.name], since);
    return r && !r.hookError && { label: p.label, yesterday: asList(r.yesterday).map(String), today: asList(r.today).map(String) };
  }).filter(Boolean);
  s.text = standupText(s);
  return s;
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
  section('Jira mentions', j.mentions, (m) =>
    `[${m.key}](${m.url}) ${m.summary}: ${m.by}, ${ago(m.at)}: "${m.excerpt}"`, j.error);
  if (!d.slack.disabled) section('Slack mentions', d.slack.mentions, (m) =>
    `[${m.channel}](${m.url}) ${m.by}, ${ago(m.at)}: "${m.excerpt}"`, d.slack.error);
  section('My Jira issues', j.assigned, (i) =>
    `[${i.key}](${i.url}) ${i.summary} [${i.status}${i.priority ? `, ${i.priority}` : ''}${i.due ? `, due ${i.due}` : ''}]`, j.error);
  if (g.assigned?.length) section('GitHub issues assigned to me', g.assigned, (i) =>
    `[${i.repo}#${i.number}](${i.url}) ${i.title}`, null);
  return out.join('\n');
}

// ---------------------------------------------------------------- server

let standupCache = { at: 0, data: null };

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

async function readJson(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 64 * 1024) throw new Error('request too large');
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

// Logins that extra sources start from Settings, such as BankID in a browser window. They
// can take minutes, so they run in the background and Settings polls for the outcome.
const sourceLogins = new Map();

async function loginStatus() {
  return Promise.all([...plugins.sources.values()].filter((p) => p.login).map(async (p) => {
    let st = {};
    try { st = (await p.login.status?.(makeContext(p).env)) || {}; } catch (e) { st = { detail: e.message }; }
    const run = sourceLogins.get(p.name);
    return { name: p.name, label: p.label, button: p.login.label || 'Log in', loggedIn: !!st.loggedIn, detail: st.detail || '',
      running: run?.state === 'running', error: run?.state === 'error' ? run.message : null };
  }));
}

const settingsStatus = async () => ({ ...await settings.status(config, { path: userEnvFile }), logins: await loginStatus() });

function startSourceLogin(p) {
  if (sourceLogins.get(p.name)?.state === 'running') return;
  sourceLogins.set(p.name, { state: 'running' });
  Promise.resolve().then(() => p.login.start(makeContext(p).env)).then((r) => {
    // Only the source's own settings, e.g. a school key learned from the login.
    const own = Object.fromEntries(Object.entries(r?.settings || {}).filter(([k, v]) => Object.hasOwn(p.settings || {}, k) && v));
    if (Object.keys(own).length) {
      const values = settings.validate(own);
      settings.writeEnvFile(userEnvFile, values);
      applySettings(values);
    }
    sourceLogins.delete(p.name);
    sourceCache.delete(p.name);
  }).catch((e) => sourceLogins.set(p.name, { state: 'error', message: e.message }));
}

function applySettings(values) {
  for (const [k, v] of Object.entries(values)) {
    if (v) process.env[k] = v;
    else delete process.env[k];
  }
  Object.assign(config, buildConfig());
  sourceCache.clear();
  copilotInfoCache = null;
  standupCache = { at: 0, data: null };
}

// ---------------------------------------------------------------- Copilot chat

const copilotCwd = () => {
  const d = (process.env.COPILOT_CWD || '').replace(/^~(?=\/|$)/, homedir());
  try { if (d && statSync(d).isDirectory()) return d; } catch { /* gone: use Clearsky's folder */ }
  return join(here, '..');
};
let copilotInfoCache = null;

async function copilotInfo(force) {
  if (!force && copilotInfoCache && Date.now() - copilotInfoCache.at < 10 * 6e4) return copilotInfoCache.data;
  const bin = copilot.findCopilot(process.env.COPILOT_BIN);
  let skills = [];
  if (bin) {
    try {
      const { stdout } = await execFileP(bin, ['skill', 'list'], { cwd: copilotCwd(), timeout: 20_000, env: copilotEnv() });
      skills = copilot.parseSkillList(stdout);
    } catch { /* fall back to the files below */ }
  }
  if (!skills.length) skills = copilot.listSkills([join(copilotCwd(), '.github', 'skills'), join(homedir(), '.copilot', 'skills')]);
  const data = {
    available: !!bin, bin, cwd: copilotCwd(), skills,
    models: ['auto', ...copilot.recentModels().filter((m) => m !== 'auto')],
    efforts: copilot.EFFORTS,
    permissions: Object.fromEntries(Object.entries(copilot.PERMISSIONS).map(([k, v]) => [k, v.label])),
    // What a new chat starts with (Settings → Copilot); the chat's pickers override them.
    defaults: { model: process.env.COPILOT_MODEL || '', effort: process.env.COPILOT_EFFORT || '', permission: process.env.COPILOT_PERMISSION || '' },
  };
  copilotInfoCache = { at: Date.now(), data };
  return data;
}

// Copilot signs in on its own; don't hand it Clearsky's tokens.
// copilot and srt start with `#!/usr/bin/env node`, and the app menu's PATH has no nvm Node:
// put this Node and copilot's own folder (often another nvm version) first.
// Copilot's own scratch folder, instead of /tmp: inside its sandbox and its trusted folders, so
// a temporary file doesn't ask. Files older than a week go at startup.
let scratch = null;
function copilotTmp() {
  if (scratch) return scratch;
  scratch = process.env.COPILOT_TMP || join(homedir(), '.cache', 'clearsky', 'tmp');
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  for (const f of readdirSync(scratch)) {
    try { if (Date.now() - statSync(join(scratch, f)).mtimeMs > 7 * 864e5) rmSync(join(scratch, f), { recursive: true, force: true }); } catch { /* in use or gone */ }
  }
  return scratch;
}

function copilotEnv() {
  const env = { ...process.env };
  env.TMPDIR = env.TMP = env.TEMP = copilotTmp();
  // Java ignores TMPDIR (Maven, Gradle, tests)
  env.JAVA_TOOL_OPTIONS = `${env.JAVA_TOOL_OPTIONS ? `${env.JAVA_TOOL_OPTIONS} ` : ''}-Djava.io.tmpdir=${copilotTmp()}`;
  for (const k of ['GITHUB_TOKEN', 'GH_TOKEN', 'SLACK_TOKEN', 'GOOGLE_CALENDAR_ICS', 'CALENDAR_ICS_URL']) delete env[k];
  const bin = copilot.findCopilot(process.env.COPILOT_BIN);
  const dirs = [bin?.includes('/') && dirname(bin), dirname(process.execPath)].filter(Boolean);
  env.PATH = [...new Set([...dirs, ...(env.PATH || '').split(delimiter).filter(Boolean)])].join(delimiter);
  return env;
}

const copilotHome = () => process.env.CLEARSKY_COPILOT_HOME || join(homedir(), '.copilot');

// Slash commands Copilot last offered (its built-ins and your skills).
let copilotCommands = null;

// Ask-mode chats keep a Copilot process running between turns, keyed by Copilot's session id.
const acpChats = new Map();
setInterval(() => {
  for (const [id, c] of acpChats) if (!c.busy && !c.waiting.size && Date.now() - c.lastUsed > 20 * 6e4) { c.agent.close(); acpChats.delete(id); }
}, 60_000).unref();

// Stop a turn on purpose. Closing the page or switching chats leaves it running.
function stopCopilot(chat) {
  const c = acpChats.get(chat);
  if (c) {
    c.agent.cancel();
    for (const r of c.waiting.values()) r({ outcome: 'cancelled' });
    c.waiting.clear(); c.pending.clear();
  }
  return !!c;
}

// Inside the sandbox ssh can't get out, so git talks to GitHub over https, sending the login
// header srt fills in (lib/sandbox.mjs, githubLogin) instead of asking a credential helper.
const SANDBOX_GIT = [['url.https://github.com/.insteadOf', 'git@github.com:'], ['url.https://github.com/.insteadOf', 'ssh://git@github.com/'],
  ['credential.https://github.com.helper', '']];
// What the sandbox may read besides your folders: Settings → Copilot → Also readable, and
// Clearsky's own folder (its acli for the sandbox).
const sandboxOpts = (cwd) => ({ cwd, folders: [...copilotFolders(), copilotTmp()], home: homedir(), read: [...list(process.env.COPILOT_READ), join(here, '..')] });
let broker = null;
function ghToken() {
  try { return execFileSync('gh', ['auth', 'token'], { timeout: 10_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; } catch { return null; }
}
// Start Copilot, inside the sandbox (srt, run by Clearsky itself) when the mode or Settings →
// Copilot says so.
async function startAgent(bin, args, cwd, { sandbox = process.env.COPILOT_SANDBOX === 'srt' } = {}) {
  if (!sandbox) return new AcpAgent(bin, args, { env: copilotEnv() });
  // In Clearsky's container, the container is the sandbox: Copilot sees only what's mounted
  // (git already goes over https there). The network isn't limited to COPILOT_DOMAINS, though.
  if (process.env.CLEARSKY_IN_CONTAINER === '1') return Object.assign(new AcpAgent(bin, args, { env: copilotEnv() }), { sandboxed: true });
  const domains = process.env.COPILOT_DOMAINS ? parseDomains(process.env.COPILOT_DOMAINS) : DEFAULT_DOMAINS;
  const keep = join(dirname(stateFile), 'sandbox');
  // Logins stay out here; srt adds them on the way out. srt reads them from Clearsky's own
  // environment, and the sandbox gets stand-ins: Maven's (lib/maven.mjs) and your gh login.
  let maven = null;
  try { maven = mavenSandbox({ home: homedir(), out: join(dirname(brokerSocket()), 'maven'), keep }); } catch (e) { console.log(`clearsky: Maven logins for the sandbox: ${e.message}`); }
  if (maven) Object.assign(process.env, maven.env);
  const env = copilotEnv();
  const n = Number(env.GIT_CONFIG_COUNT) || 0;
  // A token from Settings → Copilot if you made one, else your gh login.
  const token = process.env.COPILOT_SANDBOX_TOKEN || ghToken();
  const github = token ? githubLogin(token, process.env, n + SANDBOX_GIT.length) : null;
  [...SANDBOX_GIT, ...(github ? [github.git] : [])].forEach(([k, v], i) => { env[`GIT_CONFIG_KEY_${n + i}`] = k; env[`GIT_CONFIG_VALUE_${n + i}`] = v; });
  env.GIT_CONFIG_COUNT = String(n + SANDBOX_GIT.length + (github ? 1 : 0));
  if (maven) {
    env.MAVEN_ARGS = `${env.MAVEN_ARGS ? `${env.MAVEN_ARGS} ` : ''}--settings ${maven.settings}`;
    env.JAVA_TOOL_OPTIONS = `${env.JAVA_TOOL_OPTIONS ? `${env.JAVA_TOOL_OPTIONS} ` : ''}${maven.javaOptions}`;
  }
  // The real values never go in: srt sets the stand-ins.
  for (const c of [...(github?.credentials || []), ...(maven?.credentials || [])]) delete env[c.name];
  // The doors srt's network can't be (lib/broker.mjs): acli and `outside` reach Clearsky, which
  // asks you in this chat. The key tells Clearsky which chat a request comes from.
  const key = randomBytes(16).toString('hex');
  if (process.platform === 'linux') {
    broker ||= serveBroker({ bins: { acli: config.jira.acli }, allow: assistedAllow, ask: brokerAsk, where: brokerWhere, log: console.log });
    Object.assign(env, { CLEARSKY_BROKER_SOCKET: brokerSocket(), CLEARSKY_BROKER_KEY: key });
    env.PATH = `${join(here, '..', 'scripts', 'sandbox-bin')}${delimiter}${env.PATH}`;
  }
  // Copilot's built-in GitHub tools would change GitHub past the gate: off.
  const s = await sandboxedCommand(bin, [...args, '--disable-builtin-mcps', '--acp'], { ...sandboxOpts(cwd), domains, maven, github, ca: sandboxCa(keep) },
    { filterRequest: githubFilter(githubAsk) });
  const agent = new AcpAgent(s.bin, s.args, { env, acp: false });
  agent.child.once('exit', sandboxEnded);
  return Object.assign(agent, { sandboxed: true, brokerKey: key,
    github: github ? `${process.env.COPILOT_SANDBOX_TOKEN ? 'your sandbox token' : 'your gh login'}, added on the way out; changes ask you` : 'not signed in (gh auth login)',
    hosts: [...new Set([...domains, ...(maven?.hosts || []), ...(github?.read || [])])] });
}

// A GitHub change from a sandbox, held at srt's proxy (lib/github-gate.mjs). The proxy can't tell
// which chat sent it, so every sandboxed chat that's working asks; the first answer counts.
// When the only working chat is running a step you just allowed (say `gh pr create`), its
// GitHub changes are part of what you allowed and go through. With two chats working, it asks.
async function githubAsk(what, { repo, nodes = [] } = {}) {
  const chats = askingChats(repo || (what.match(/^git push to (\S+)/) || [])[1] || await nodesRepo(nodes));
  if (!chats.length) return false;
  const shared = chats.length > 1;
  if (chats.length === 1 && chats[0].approved.size) return Promise.resolve(true);
  return new Promise((done) => {
    const id = randomBytes(6).toString('hex');
    const ev = { type: 'permission', id, title: 'Change GitHub as you', kind: 'execute', detail: what,
      options: [{ id: 'allow', name: 'Allow', kind: 'allow_once' },
        ...(repo ? [{ id: 'repo', name: `Allow changes on ${repo} for 15 min`, kind: 'allow_always' }] : []),
        { id: 'deny', name: 'Deny', kind: 'reject_once' }] };
    const finish = (ok) => {
      for (const c of chats) { c.waiting.delete(id); c.pending.delete(id); c.shared.delete(id); c.emit({ type: 'permission-done', id }); }
      done(ok);
    };
    for (const c of chats) {
      if (c.mode === 'full') return finish(true); // Full: you allowed everything
      c.waiting.set(id, (answer) => finish(answer.optionId === 'repo' ? 'repo' : answer.optionId === 'allow'));
      if (shared) c.shared.add(id); // may not be this chat's: it doesn't mark the chat as needing you
      c.pending.set(id, ev);
      c.emit(ev);
    }
  });
}

// Which working chat a GitHub change came from. srt's proxy can't tell, so narrow it down: chats
// running a step right now, then those whose folder is a clone of the repo it goes to. Only
// when that leaves several does every one of them ask (the first answer counts).
function askingChats(repo) {
  let chats = [...acpChats.values()].filter((c) => c.agent.sandboxed && c.busy);
  const narrow = (f) => { const n = chats.filter(f); if (n.length) chats = n; };
  narrow((c) => c.running.size);
  if (repo) narrow((c) => chatRepo(c) === repo.toLowerCase());
  return chats;
}
// The repo of a GraphQL change, from the ids it names (looked up as you, read only).
async function nodesRepo(ids) {
  if (!ids.length) return null;
  try {
    config.github.token ||= await ghCliToken();
    const d = await gql(`query($ids: [ID!]!) { nodes(ids: $ids) { __typename ... on Repository { nameWithOwner }
      ... on PullRequest { repository { nameWithOwner } } ... on Issue { repository { nameWithOwner } }
      ... on PullRequestReview { repository { nameWithOwner } } ... on PullRequestReviewComment { repository { nameWithOwner } }
      ... on PullRequestReviewThread { pullRequest { repository { nameWithOwner } } } ... on IssueComment { repository { nameWithOwner } } } }`, { ids });
    const n = (d.nodes || []).find(Boolean);
    return (n?.nameWithOwner || n?.repository?.nameWithOwner || n?.pullRequest?.repository?.nameWithOwner || '').toLowerCase() || null;
  } catch { return null; }
}
function chatRepo(c) {
  if (c.repo === undefined) {
    try {
      const url = execFileSync('git', ['-C', c.cwd, 'remote', 'get-url', 'origin'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      c.repo = (url.match(/github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/) || [])[1]?.toLowerCase() || null;
    } catch { c.repo = null; }
  }
  return c.repo;
}

// The chat a sandbox door request comes from, by the key its Copilot was given.
const chatByKey = (key) => typeof key === 'string' && key ? [...acpChats.values()].find((c) => c.agent.brokerKey === key) : null;
function brokerWhere(key) {
  const c = chatByKey(key);
  return c && [c.cwd, ...copilotFolders().map((d) => d.replace(/^~(?=\/|$)/, homedir()))];
}
// Ask in the chat, as for any step Copilot wants to take, and wait for your answer.
function brokerAsk({ key, tool, argv, cwd }) {
  const c = chatByKey(key);
  if (!c) return Promise.resolve(false);
  if (c.mode === 'full') return Promise.resolve(true); // Full: you allowed everything
  const line = [tool, ...argv].map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ');
  const title = { git: 'Push from your machine', gh: 'Change GitHub as you', acli: 'Change Jira as you', outside: 'Run on your machine, outside the sandbox' }[tool];
  return new Promise((done) => {
    const id = randomBytes(6).toString('hex');
    // The same command again (a test run after a fix) can be allowed for the rest of this chat.
    const same = `${cwd}\n${line}`;
    if (c.allowedRuns?.has(same)) return done(true);
    const ev = { type: 'permission', id, title, kind: 'execute', detail: `${line}\n(in ${cwd.replace(homedir(), '~')})`,
      options: [{ id: 'allow', name: 'Allow', kind: 'allow_once' }, { id: 'chat', name: 'Allow this command again in this chat', kind: 'allow_always' },
        { id: 'deny', name: 'Deny', kind: 'reject_once' }] };
    c.waiting.set(id, (answer) => {
      c.pending.delete(id);
      if (answer.optionId === 'chat') (c.allowedRuns ||= new Set()).add(same);
      done(answer.optionId === 'allow' || answer.optionId === 'chat');
    });
    c.pending.set(id, ev);
    c.emit(ev);
  });
}

// A short-lived Copilot process, for listing or reading sessions.
async function withAgent(bin, fn) {
  const agent = await startAgent(bin, [], copilotCwd());
  const timer = setTimeout(() => agent.close(), 30_000);
  try { return await fn(agent); } finally { clearTimeout(timer); agent.close(); }
}

// Sessions open in a running Copilot (terminal, editor): the process keeps an
// inuse.<pid>.hold file in the session's folder while it has the session open.
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
// A sandboxed Copilot writes its pid as seen inside the sandbox (17, say), which out here is some
// other process, often a kernel thread that never ends. So on Linux the pid must be a Copilot.
function isCopilot(pid) {
  if (!alive(pid)) return false;
  if (process.platform !== 'linux') return true;
  try { return /copilot/i.test(readFileSync(`/proc/${pid}/cmdline`, 'utf8')); } catch { return false; }
}
function openCopilotSessions() {
  const dir = join(copilotHome(), 'session-state');
  let state = {};
  try { state = JSON.parse(readFileSync(join(copilotHome(), 'open-sessions-state.json'), 'utf8')) || {}; } catch {}
  const open = {};
  let ids = [];
  try { ids = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch {}
  for (const id of ids) {
    let files = [];
    try { files = readdirSync(join(dir, id)); } catch {}
    const pids = files.map((f) => Number(f.match(/^inuse\.(\d+)\.hold$/)?.[1])).filter((n) => n && isCopilot(n));
    if (pids.length) open[id] = { working: !!state[id]?.working && Date.now() - (Date.parse(state[id]?.refreshedAt) || 0) < 15 * 6e4 };
  }
  return open;
}

const CONTEXT_INTRO = 'You are helping me with my work. This is my work dashboard right now:';
// Clearsky shows a ```choices block as buttons (web/js/50-chat.js); a click sends the option.
// PR descriptions are for the human reviewer: after Copilot's review rounds, theirs should be quick.
const PR_HINT = 'When you open a PR or finish a round of work on one, write (or update with `gh pr edit --body-file`) its description '
  + 'for the human reviewer, short and in this shape: "## What and why" (the change and the reason, with the ticket key); '
  + '"## How it was checked" (tests you ran and their result, Copilot review rounds so far and that their findings are addressed); '
  + '"## For the reviewer" (anything still open, decisions worth a second look, where the risk is; "Nothing open" if so). '
  + 'Facts only, no filler; keep any PR template\'s headings and fill them the same way.';
const CHOICES_HINT = 'When you need me to choose (an approach, a next step, yes or no), ask once, at the end of your answer, as a block I can click:\n'
  + '```choices\nThe question, in one line\n- First option (recommended) | what happens if I pick it\n- Second option | what happens\n```\n'
  + 'Two to four options, the one you recommend first. Then stop and wait for my pick.';
// Where my code is, so Copilot looks there first instead of listing my home and asking for it.
function foldersHint() {
  const tilde = (p) => (p.startsWith(homedir()) ? `~${p.slice(homedir().length)}` : p);
  const rw = copilotFolders().map(tilde), ro = list(process.env.COPILOT_READ).map(tilde);
  if (!rw.length && !ro.length) return `For temporary files use $TMPDIR (${tilde(copilotTmp())}), not /tmp.`;
  return `My code is in ${rw.join(', ') || 'this folder'}${ro.length ? ` (and, read only, ${ro.join(', ')})` : ''}. `
    + 'Find repos and files there or in the current folder; don\'t list or search the rest of my home. '
    + 'If you need something outside these folders, say what and why first. '
    + `For temporary files use $TMPDIR (${tilde(copilotTmp())}), not /tmp.`;
}
// How the sandbox works for Copilot, and its doors out (lib/broker.mjs).
const SANDBOX_HINT = 'You run in a sandbox: everything inside it runs without asking me. git and gh work as usual; reading GitHub '
  + 'goes through, while a push or any GitHub change (a PR, a comment, a review) waits at the sandbox\'s network until I click Allow, '
  + 'and fails with "declined" if I don\'t. Jira changes with `acli` ask me the same way. Your built-in GitHub tools are off here. '
  + 'There is no Docker in the sandbox. Tests that need it (Testcontainers) fail with errors like "Ryuk is unreachable" or '
  + '"Could not find a valid Docker environment": run that test command as `outside <command>` (for example '
  + '`outside ./mvnw verify -pl core`), which runs it on my machine after I OK it. Builds and tests run fine in the sandbox '
  + '(Maven, its repository and your JDKs are there): always run them normally first, and use `outside` only after a run in '
  + 'the sandbox failed with one of those Docker errors. Never use it for other failures (fix those, or ask me), and don\'t quote '
  + 'arguments you don\'t need to.';
// What you typed, without the dashboard and references Clearsky added in front.
const MSG_MARK = '\n\n---\nMy message:\n';
export function typedPart(text) {
  const at = text.lastIndexOf(MSG_MARK);
  if (at >= 0 && (text.startsWith(CONTEXT_INTRO) || text.startsWith(REFS_INTRO))) return text.slice(at + MSG_MARK.length);
  if (text.startsWith(CONTEXT_INTRO)) return text.slice(text.lastIndexOf('\n\n---\n\n') + 7); // chats from before the marker
  return text;
}

let sessionsCache = null;
// A session started here is named after the dashboard and items Clearsky put in front of
// your message; show what you typed instead (and never match PRs or tickets on the rest).
export function sessionTitle(title, typed) {
  if (!title || !(title.startsWith(CONTEXT_INTRO.slice(0, 30)) || title.startsWith(REFS_INTRO))) return title || null;
  const own = typed || (title.includes(MSG_MARK) ? typedPart(title) : '');
  return own.trim().split('\n')[0].slice(0, 120) || 'Chat from Clearsky';
}

async function copilotSessions(bin, force) {
  if (!force && sessionsCache && Date.now() - sessionsCache.at < 30_000) return withStatus(sessionsCache.data);
  const list = await withAgent(bin, (a) => a.listSessions());
  const titles = localState.sessionTitles(stateFile), names = localState.sessionNames(stateFile);
  const data = list.map((x) => ({ id: x.sessionId, title: names[x.sessionId] || sessionTitle(x.title, titles[x.sessionId]), cwd: x.cwd || null, updatedAt: x.updatedAt || null }))
    .sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));
  sessionsCache = { at: Date.now(), data };
  return withStatus(data);
}

// Where each session is at, worked out fresh each time:
//   working: Copilot is busy on it (here, or in a terminal or editor);
//   needs-you: it asked to use a tool and waits for your answer (here);
//   waiting: open in a terminal or here, done with its turn, waiting for your next message;
//   closed: not open anywhere.
// Waiting for your answer on something that is this chat's (not a GitHub change that may be another's).
const needsYou = (c) => !!c && [...c.waiting.keys()].some((id) => !c.shared?.has(id));
function withStatus(list) {
  const open = openCopilotSessions();
  return list.map((x) => {
    const c = acpChats.get(x.id);
    const status = needsYou(c) ? 'needs-you' : c?.busy || open[x.id]?.working ? 'working'
      : c || open[x.id] ? 'waiting' : 'closed';
    return { ...x, open: !!open[x.id] && !c, working: status === 'working', here: !!c, status };
  });
}

// Which Copilot sessions belong to which PR or ticket ("pr:org/repo#12", "issue:ABC-1"): the
// items you attached in Clearsky, the branch a terminal session worked on (matched to its
// PR, and the ticket key in its name), and ticket keys in the session's title.
export function linkSessions(sessions, { prs = [], refs = {}, workspace = () => ({}) } = {}) {
  // workspace.yaml may hold "org/repo" or a clone URL.
  const repoOf = (r) => (r || '').replace(/\.git$/i, '').replace(/^.*[:/]([^/:]+\/[^/]+)$/, '$1').toLowerCase();
  const byBranch = new Map(prs.filter((p) => p.branch).map((p) => [`${repoOf(p.repo)}@${p.branch}`, `pr:${p.repo}#${p.number}`]));
  const byNumber = new Map(prs.map((p) => [`${repoOf(p.repo)}#${p.number}`, `pr:${p.repo}#${p.number}`]));
  const links = {};
  for (const x of sessions) {
    const keys = new Set(refs[x.id] || []);
    const ws = workspace(x.id);
    const repo = repoOf(ws.repository);
    for (const branch of ws.branches || [ws.branch]) {
      const pr = repo && branch && byBranch.get(`${repo}@${branch}`);
      if (pr) keys.add(pr);
    }
    // A PR named in the title: its URL anywhere, or "#123" / "PR 123" in a session in that repo.
    for (const m of (x.title || '').matchAll(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/gi)) {
      const pr = byNumber.get(`${m[1].toLowerCase()}#${m[2]}`);
      if (pr) keys.add(pr);
    }
    for (const m of (x.title || '').matchAll(/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)/gi)) keys.add(`gh:${m[1]}#${m[2]}`);
    if (repo) for (const m of (x.title || '').matchAll(/(?:#|\bPR\s*#?)(\d+)\b/gi)) {
      const pr = byNumber.get(`${repo}#${m[1]}`);
      if (pr) keys.add(pr);
    }
    for (const m of `${(ws.branches || [ws.branch]).join(' ')} ${x.title || ''}`.toUpperCase().matchAll(/\b([A-Z][A-Z0-9_]+-\d+)\b/g)) keys.add(`issue:${m[1]}`);
    for (const k of keys) (links[k] ||= []).push({ id: x.id, title: x.title || 'Untitled session', updatedAt: x.updatedAt, cwd: x.cwd, status: x.status || 'closed' });
  }
  // A PR, its Jira ticket (the key in its title or branch) and the GitHub issues it closes are
  // one piece of work: a session linked to any of them shows on all of them.
  for (const p of prs) {
    const keys = [`pr:${p.repo}#${p.number}`,
      ...[...`${p.title || ''} ${p.branch || ''}`.toUpperCase().matchAll(/\b([A-Z][A-Z0-9_]+-\d+)\b/g)].map((m) => `issue:${m[1]}`),
      ...(p.issues || []).map((i) => `gh:${i}`)];
    const all = keys.flatMap((k) => links[k] || []).filter((x, i, a) => a.findIndex((y) => y.id === x.id) === i);
    if (all.length) for (const k of keys) links[k] = all;
  }
  for (const k of Object.keys(links)) links[k] = links[k].sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0)).slice(0, 3);
  return links;
}

function ticketPr(ref) {
  if (!ref) return null;
  const gh = sourceCache.get('github')?.data || {};
  return [...(gh.myPrs || []), ...(gh.reviewRequested || [])].find((p) => new RegExp(`\\b${ref.key}\\b`, 'i').test(`${p.title} ${p.branch || ''}`)) || null;
}

// The name a chat started on an item gets: "ABC-6519 · Fix capture timeout", or for a PR
// without a ticket key "abc#1187 · Fix capture timeout". Continuing work then finds it again.
export function itemSessionName(ref, cache = (n) => sourceCache.get(n)?.data || {}) {
  const gh = cache('github'), jira = cache('jira'), jm = cache('jiraMentions');
  if (ref.kind === 'pr') {
    const p = [...(gh.myPrs || []), ...(gh.reviewRequested || [])].find((x) => x.repo === ref.repo && x.number === Number(ref.number));
    const key = `${p?.title || ''} ${p?.branch || ''}`.toUpperCase().match(/\b([A-Z][A-Z0-9_]+-\d+)\b/)?.[1];
    const title = (p?.title || '').replace(new RegExp(`\\[?${key}\\]?:?\\s*`, 'i'), '').trim();
    return `${key ? `${key} · ` : ''}${ref.repo.split('/').pop()}#${ref.number}${title ? ` · ${title}` : ''}`.slice(0, 100);
  }
  if (ref.kind === 'gh') {
    const i = [...(gh.assigned || []), ...(gh.mentions || [])].find((x) => x.repo === ref.repo && x.number === Number(ref.number));
    return `${ref.repo.split('/').pop()}#${ref.number}${i?.title ? ` · ${i.title}` : ''}`.slice(0, 100);
  }
  const t = (jira.assigned || []).find((x) => x.key === ref.key) || (jm.tickets || []).find((x) => x.key === ref.key);
  return `${ref.key}${t?.summary ? ` · ${t.summary}` : ''}`.slice(0, 100);
}

async function copilotLinks(bin) {
  const sessions = await copilotSessions(bin);
  const recent = sessions.filter((x) => x.status !== 'closed' || Date.now() - (Date.parse(x.updatedAt) || 0) < 60 * 864e5);
  const gh = sourceCache.get('github')?.data || {};
  // Copilot's own log: every branch a session worked on (workspace.yaml only has the one it
  // started or last resumed on), and the steps it took, for sessions from the last two weeks.
  const events = new Map(recent.filter((x) => Date.now() - (Date.parse(x.updatedAt) || 0) < 14 * 864e5).map((x) => [x.id, sessionEvents(copilotHome(), x.id)]));
  const workspace = (id) => { const ws = workspaceInfo(id); return { ...ws, branches: [...new Set([...(events.get(id)?.branches || []), ws.branch].filter(Boolean))] }; };
  const links = linkSessions(recent, { prs: [...(gh.myPrs || []), ...(gh.reviewRequested || [])], refs: localState.sessionRefs(stateFile), workspace });
  // The latest step Copilot took on each item, from any session linked to it.
  const actions = {};
  for (const [k, list] of Object.entries(links)) {
    for (const x of list) for (const a of events.get(x.id)?.actions || []) {
      if ((a.key && a.key !== k) || (actions[k] && actions[k].at >= a.at)) continue;
      actions[k] = { text: a.text, at: a.at, session: x.id };
    }
  }
  // Every session that is busy or waiting on you, linked to an item or not.
  const live = sessions.filter((x) => x.status !== 'closed').map(({ id, title, updatedAt, cwd, status }) => ({ id, title: title || 'Untitled session', updatedAt, cwd, status }));
  // Chats running here that Copilot doesn't list yet (before their first answer is saved).
  const titles = localState.sessionTitles(stateFile), names = localState.sessionNames(stateFile);
  for (const [id, c] of acpChats) if (!sessions.some((x) => x.id === id)) {
    live.push({ id, title: names[id] || titles[id] || 'New chat', updatedAt: new Date(c.lastUsed).toISOString(), cwd: c.cwd || null,
      status: needsYou(c) ? 'needs-you' : c.busy ? 'working' : 'waiting' });
  }
  return { links, live, actions };
}

const refKey = (r) => (r.kind === 'issue' ? `issue:${r.key}` : `${r.kind}:${r.repo}#${r.number}`);

async function copilotHistory(bin, id, cwd) {
  const messages = await withAgent(bin, (a) => a.history(id, cwd));
  for (const m of messages) if (m.role === 'me') m.text = typedPart(m.text);
  return messages;
}

// The local clone of a GitHub repository, so Copilot can work in it: a folder under
// CLEARSKY_CODE_DIRS (default ~/dev), up to three levels down, whose origin is that repo.
const codeDirs = () => (process.env.CLEARSKY_CODE_DIRS || join(homedir(), 'dev')).split(':').filter(Boolean);
export function findCheckout(repo, roots = codeDirs()) {
  const name = repo.split('/')[1]?.toLowerCase();
  const matches = (dir) => {
    try { return new RegExp(`[:/]${repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\.git)?\\s*$`, 'im').test(readFileSync(join(dir, '.git', 'config'), 'utf8')); } catch { return false; }
  };
  const walk = (dir, depth) => {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules'); } catch { return null; }
    for (const e of entries) if (e.name.toLowerCase() === name && matches(join(dir, e.name))) return join(dir, e.name);
    if (depth > 0) for (const e of entries) { const hit = walk(join(dir, e.name), depth - 1); if (hit) return hit; }
    return null;
  };
  for (const root of roots) { const hit = walk(root, 2); if (hit) return hit; }
  return null;
}

// The worktree of a clone that has this branch checked out, if there is one
// (read from .git/worktrees/*/HEAD and gitdir, so no git process is needed).
export function worktreeFor(clone, branch) {
  if (!branch) return null;
  const base = join(clone, '.git', 'worktrees');
  let names = [];
  try { names = readdirSync(base); } catch { return null; }
  for (const n of names) {
    try {
      if (readFileSync(join(base, n, 'HEAD'), 'utf8').trim() !== `ref: refs/heads/${branch}`) continue;
      const dir = dirname(resolve(base, n, readFileSync(join(base, n, 'gitdir'), 'utf8').trim()));
      if (statSync(dir).isDirectory()) return dir;
    } catch { /* a stale worktree entry */ }
  }
  return null;
}

// The head branch of a PR, from what the GitHub source last fetched.
function prBranch(ref) {
  if (ref.branch) return ref.branch;
  const gh = sourceCache.get('github')?.data || {};
  return [...(gh.myPrs || []), ...(gh.reviewRequested || [])].find((p) => p.repo === ref.repo && p.number === ref.number)?.branch || null;
}

const isDir = (d) => { try { return typeof d === 'string' && d.startsWith('/') && statSync(d).isDirectory(); } catch { return false; } };

// Fuller details of the PRs and tickets you attach to a Copilot message.
const REFS_INTRO = 'I am asking about these items:';
async function referenceText(ref) {
  if (ref.kind === 'issue') {
    await jiraSite();
    const [out, comments] = await Promise.all([
      acli(['workitem', 'view', ref.key, '--fields', 'summary,status,assignee,reporter,priority,issuetype,description,labels', '--json']),
      jiraComments(ref.key).catch(() => []),
    ]);
    const f = out?.fields || out || {};
    const desc = f.description ? excerpt(commentInfo(f.description).text, null, 4000) : '';
    return [`## Jira ${ref.key}: ${f.summary || ''}`, browseUrl({ key: ref.key, self: out?.self }),
      `Type: ${nameOf(f.issuetype) || '?'} · Status: ${nameOf(f.status) || '?'} · Priority: ${nameOf(f.priority) || '-'} · Assignee: ${f.assignee?.displayName || 'unassigned'} · Reporter: ${f.reporter?.displayName || '?'}`,
      desc && `Description: ${desc}`,
      comments.length && `Latest comments:\n${comments.slice(-5).map((c) => `- ${c.author?.displayName || '?'} (${String(c.created || '').slice(0, 10)}): ${excerpt(commentInfo(c.body).text, null, 600)}`).join('\n')}`,
    ].filter(Boolean).join('\n');
  }
  config.github.token ||= await ghCliToken();
  const [owner, name] = ref.repo.split('/');
  if (ref.kind === 'gh') {
    const { repository } = await gql(`query($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) { issue(number: $number) {
        title url state bodyText author { login } assignees(first: 5) { nodes { login } } labels(first: 10) { nodes { name } }
        comments(last: 5) { nodes { author { login } createdAt bodyText } } } } }`, { owner, name, number: Number(ref.number) });
    const i = repository?.issue;
    if (!i) throw new Error(`${ref.repo}#${ref.number} not found`);
    return [`## GitHub issue ${ref.repo}#${ref.number}: ${i.title}`, i.url,
      `By ${i.author?.login || '?'} · ${i.state.toLowerCase()} · assignees: ${i.assignees.nodes.map((a) => a.login).join(', ') || 'none'}${i.labels.nodes.length ? ` · labels: ${i.labels.nodes.map((l) => l.name).join(', ')}` : ''}`,
      i.bodyText && `Description: ${i.bodyText.trim().slice(0, 4000)}`,
      i.comments.nodes.length && `Latest comments:\n${i.comments.nodes.map((c) => `- ${c.author?.login || '?'} (${String(c.createdAt).slice(0, 10)}): ${c.bodyText.replace(/\s+/g, ' ').slice(0, 600)}`).join('\n')}`,
    ].filter(Boolean).join('\n');
  }
  const { repository } = await gql(`query($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) { pullRequest(number: $number) {
      title url state isDraft reviewDecision bodyText headRefName baseRefName author { login }
      files(first: 60) { nodes { path additions deletions } }
      latestReviews(first: 10) { nodes { author { login } state bodyText } } } } }`,
  { owner, name, number: Number(ref.number) });
  const pr = repository?.pullRequest;
  if (!pr) throw new Error(`${ref.repo}#${ref.number} not found`);
  return [`## Pull request ${ref.repo}#${ref.number}: ${pr.title}`, pr.url,
    `By ${pr.author?.login || '?'} · ${pr.isDraft ? 'draft' : pr.state.toLowerCase()} · review: ${(pr.reviewDecision || 'none').toLowerCase().replace(/_/g, ' ')} · ${pr.headRefName} → ${pr.baseRefName}`,
    pr.bodyText && `Description: ${pr.bodyText.trim().slice(0, 4000)}`,
    pr.files?.nodes?.length && `Files:\n${pr.files.nodes.map((x) => `- ${x.path} (+${x.additions} -${x.deletions})`).join('\n')}`,
    pr.latestReviews?.nodes?.length && `Reviews:\n${pr.latestReviews.nodes.map((r) => `- ${r.author?.login}: ${r.state.toLowerCase()}${r.bodyText ? ` "${r.bodyText.replace(/\s+/g, ' ').slice(0, 300)}"` : ''}`).join('\n')}`,
  ].filter(Boolean).join('\n');
}

export function validRefs(refs) {
  return (Array.isArray(refs) ? refs : []).slice(0, 8).map((r) => (
    r?.kind === 'issue' && /^[A-Z][A-Z0-9_]+-\d+$/.test(r.key) ? { kind: 'issue', key: r.key }
      : (r?.kind === 'pr' || r?.kind === 'gh') && /^[\w.-]+\/[\w.-]+$/.test(r.repo) && /^\d+$/.test(String(r.number)) ? { kind: r.kind, repo: r.repo, number: Number(r.number) }
        : null)).filter(Boolean);
}

function toolDetail(call = {}) {
  const input = call.rawInput;
  if (!input || typeof input !== 'object') return '';
  const text = input.command || input.path || input.url || JSON.stringify(input);
  return String(text).slice(0, 400);
}

// Folders Copilot chats may use without asking: Settings, else your code folders (~/dev).
// Commands the sandbox's doors run without asking, like a Jira transition (Settings → Copilot).
const assistedAllow = () => list(process.env.COPILOT_ASSISTED_ALLOW);
const copilotFolders = () => (process.env.COPILOT_FOLDERS ? list(process.env.COPILOT_FOLDERS) : codeDirs());

async function acpTurn({ chat, options, prompt, resumeId, cwd, emit, res, bin }) {
  // Changing the folders in Settings starts the chat's Copilot again (resuming it) on its next turn.
  const args = [...copilot.optionArgs(options), ...copilot.folderArgs([...copilotFolders(), copilotTmp()])];
  // Sandboxed mode always runs in srt; the others when Settings → Copilot → Sandbox says so.
  const sandbox = !!copilot.PERMISSIONS[options.permission]?.sandbox || process.env.COPILOT_SANDBOX === 'srt';
  const sig = JSON.stringify([args, sandbox, process.env.COPILOT_DOMAINS, process.env.COPILOT_FOLDERS]);
  let c = acpChats.get(chat);
  if (c && (c.sig !== sig || c.agent.closed)) { resumeId = c.agent.sessionId; c.agent.close(); acpChats.delete(chat); c = null; }
  if (!c) {
    const agent = await startAgent(bin, args, cwd, { sandbox });
    c = { agent, sig, cwd, waiting: new Map(), pending: new Map(), approved: new Set(), running: new Set(), shared: new Set(), emit: () => {}, lastUsed: Date.now() };
    const id = await agent.start(cwd, resumeId);
    acpChats.set(id, c);
    // A new chat gets Copilot's own session id; the panel keeps using that from now on.
    if (id !== chat) emit({ type: 'session', id });
  }
  c.lastUsed = Date.now();
  c.mode = options.permission;
  const { agent } = c;
  // Events go to whichever page is watching this chat; none while you look at another one.
  c.emit = emit;
  if (agent.commands) { copilotCommands = agent.commands; emit({ type: 'commands', commands: agent.commands }); }
  agent.onUpdate = (u) => {
    if (u.sessionUpdate === 'available_commands_update') { copilotCommands = agent.commands; c.emit({ type: 'commands', commands: agent.commands }); return; }
    // A step you allowed has finished: its GitHub changes ask again (see githubAsk).
    if (u.sessionUpdate === 'tool_call_update' && ['completed', 'failed'].includes(u.status)) { c.approved.delete(u.toolCallId); c.running.delete(u.toolCallId); }
    else if (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') c.running.add(u.toolCallId);
    const e = chatEvent(u); if (e && (e.type !== 'text' || e.text)) c.emit(e);
  };
  const autoAllow = copilot.PERMISSIONS[options.permission]?.autoAllow || [];
  agent.onPermission = (p) => new Promise((done) => {
    // One log line per question, without its content: the mode, the kind of step, the input's
    // field names and how it was answered, to see why something did or didn't ask.
    const resolve = (answer) => {
      console.log(`clearsky: permission mode=${options.permission || 'ask'} kind=${p.toolCall?.kind || '?'} input=${Object.keys(p.toolCall?.rawInput || {}).join('+') || '-'} -> ${answer.rule || 'you'}`);
      done(answer.rule ? { outcome: answer.outcome, optionId: answer.optionId } : answer);
    };
    const once = (p.options || []).find((o) => o.kind === 'allow_once');
    if (once && (autoAllow.includes('*') || autoAllow.includes(p.toolCall?.kind))) return resolve({ outcome: 'selected', optionId: once.optionId, rule: 'mode' });
    // Sandboxed: srt is the fence, so every step inside it runs. What leaves it (a push, a GitHub
    // or Jira change, `outside`) goes through Clearsky's doors, which ask you (lib/broker.mjs).
    if (once && options.permission === 'sandboxed' && c.agent.sandboxed) return resolve({ outcome: 'selected', optionId: once.optionId, rule: 'sandboxed' });
    const id = randomBytes(6).toString('hex');
    const ev = { type: 'permission', id, title: p.toolCall?.title || 'Copilot wants to use a tool', kind: p.toolCall?.kind,
      detail: toolDetail(p.toolCall), options: (p.options || []).map((o) => ({ id: o.optionId, name: o.name, kind: o.kind })) };
    c.waiting.set(id, (answer) => {
      c.pending.delete(id);
      const opt = (p.options || []).find((o) => o.optionId === answer.optionId);
      if (/^allow/.test(opt?.kind || '') && p.toolCall?.toolCallId) c.approved.add(p.toolCall.toolCallId);
      resolve(answer);
    });
    c.pending.set(id, ev);
    c.emit(ev);
  });
  // Switching chats or reloading the page leaves the turn running; Stop ends it.
  res.on('close', () => { if (c.emit === emit) c.emit = () => {}; });
  c.busy = true;
  const r = await agent.prompt(prompt).finally(() => { c.busy = false; c.approved.clear(); c.running.clear(); });
  c.emit({ type: 'done', stopReason: r?.stopReason });
  c.emit = () => {};
}

// Watch a chat that is still running (after switching back to it): its open questions, then
// what it does from now on, until the turn ends.
function attachCopilot(chat, req, res) {
  const c = acpChats.get(chat);
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  const send = (e) => { if (!res.writableEnded && !res.destroyed) res.write(`${JSON.stringify(e)}\n`); };
  if (!c?.busy) { send({ type: 'done' }); return res.end(); }
  for (const ev of c.pending.values()) send(ev);
  const emit = (e) => { send(e); if (e.type === 'done') res.end(); };
  c.emit = emit;
  res.on('close', () => { if (c.emit === emit) c.emit = () => {}; });
}

// A compact view of what's on the dashboard right now, from the cache (no new fetches).
function copilotContext() {
  const get = (n) => sourceCache.get(n)?.data || {};
  const g = get('github'), j = get('jira'), jm = get('jiraMentions'), cal = get('calendar');
  const pr = (p) => `${p.repo}#${p.number} ${p.title}`;
  const lines = [
    `Now: ${new Date().toString()}`,
    g.reviewRequested?.length && `Reviews requested from me:\n${g.reviewRequested.map((p) => `- ${pr(p)} (by ${p.author}, ${p.url})`).join('\n')}`,
    g.myPrs?.length && `My open PRs:\n${g.myPrs.map((p) => `- ${pr(p)}: ${p.status.label} (${p.url})`).join('\n')}`,
    jm.tickets?.length && `Jira tickets where I was mentioned:\n${jm.tickets.map((t) => `- ${t.key} ${t.summary}: ${t.people.join(', ')} said "${t.excerpt}"`).join('\n')}`,
    j.assigned?.length && `My Jira issues:\n${j.assigned.slice(0, 40).map((i) => `- ${i.key} ${i.summary} [${i.status}${i.priority ? `, ${i.priority}` : ''}]`).join('\n')}`,
    cal.events?.length && `Calendar (today and tomorrow):\n${cal.events.map((e) => `- ${e.start} to ${e.end} ${e.title}`).join('\n')}`,
  ].filter(Boolean);
  return lines.join('\n\n');
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

// ---------------------------------------------------------------- notifications

const ATTENTION_SOURCES = ['github', 'jiraMentions', 'slack'];
const poller = { lastPoll: null, notifier: null, timer: null };

// Desktop banners come from notify-send when it's there; otherwise the open page shows them.
// Desktop banners go over D-Bus with gdbus (clicks work), else through notify-send, else the
// open page shows them. CLEARSKY_NOTIFY=notify-send forces the old way.
let dbusNotifier = null;
function hasNotifySend() {
  if (process.env.CLEARSKY_NOTIFY === 'off') return Promise.resolve('off');
  if (process.env.CLEARSKY_NOTIFY === 'browser') return Promise.resolve('browser');
  const notifySend = () => execFileP(process.env.NOTIFY_SEND_BIN || 'notify-send', ['--version'], { timeout: 5000 }).then(() => 'desktop', () => 'browser');
  if (process.env.CLEARSKY_NOTIFY === 'notify-send' || process.env.NOTIFY_SEND_BIN) return notifySend();
  const bin = process.env.GDBUS_BIN || 'gdbus';
  return execFileP(bin, ['call', '--session', '--dest', 'org.freedesktop.Notifications', '--object-path', '/org/freedesktop/Notifications',
    '--method', 'org.freedesktop.Notifications.GetServerInformation'], { timeout: 5000 })
    .then(() => { dbusNotifier = new DbusNotifier({ bin }); dbusNotifier.start(); return 'desktop'; }, notifySend);
}
const sendBanner = (item) => (dbusNotifier ? dbusNotifier.notify(item) : desktopNotify(item, { bin: process.env.NOTIFY_SEND_BIN || 'notify-send' }));

// Banners only during working hours on workdays (07:00 until two hours after the workday ends).
function notifyNow(now = new Date()) {
  const end = atLocalTime(now, config.workdayEnd);
  return isWorkday(now) && now.getHours() >= 7 && +now < +end + 2 * 36e5;
}

export async function pollAttention(force = true) {
  // One poll at a time: two overlapping ones would both see the same item as new.
  if (poller.running) return poller.running;
  poller.running = pollOnce(force).finally(() => { poller.running = null; });
  return poller.running;
}

async function pollOnce(force) {
  const data = Object.fromEntries(await Promise.all(ATTENTION_SOURCES.map(async (n) => [n, await source(n, force)])));
  const items = [...attentionItems(data), ...await pluginAttention(force)];
  const before = localState.seen(stateFile);
  const { seen, fresh } = diffAttention(items, before, {
    dismissed: localState.dismissed(stateFile), muted: localState.muted(stateFile), first: !Object.keys(before).length,
  });
  if (fresh.length || Object.keys(seen).length !== Object.keys(before).length) localState.setSeen(stateFile, seen);
  poller.lastPoll = new Date().toISOString();
  if (fresh.length && poller.notifier === 'desktop' && notifyNow()) {
    // More than two at once (say after the laptop wakes up) become one banner.
    if (fresh.length > 2) sendBanner({ key: 'clearsky:summary', title: `${fresh.length} new things need you`, body: fresh.slice(0, 4).map((x) => x.title).join('\n'), url: `http://127.0.0.1:${config.port}/` });
    else for (const it of fresh) sendBanner(it);
  }
  if (fresh.length) localState.logNotified(stateFile, fresh.map((x) => ({ key: x.key, kind: x.kind, stamp: String(x.stamp ?? ''), title: x.title, body: (x.body || '').slice(0, 200), url: x.url, at: new Date().toISOString(), via: poller.notifier, quiet: !notifyNow() })));
  return { items, seen, fresh };
}

async function pluginAttention(force) {
  const extra = await pluginData(force);
  const reads = localState.readMarks(stateFile);
  return [...plugins.sources.values()].flatMap((p) => (extra[p.name]?.error || extra[p.name]?.disabled ? []
    : asList(hook(p, 'attention', extra[p.name])).filter((x) => x?.key && x.title).map((x) => ({ kind: p.name, ...x, key: `${p.name}:${x.key}` }))
      // Something you've read here doesn't need you, until there's something new on it.
      .filter((x) => !(x.at && reads[x.key] === String(x.at)))));
}

// A source's items with your read marks applied: `unread` is what's still unread to you,
// `unreadAtSource` what the source itself says.
function withReads(name, data) {
  if (!plugins.sources.has(name) || !Array.isArray(data?.items)) return data;
  const reads = localState.readMarks(stateFile);
  return { ...data, items: data.items.map((i) => {
    if (!i?.unread) return i;
    const here = i.at != null && reads[`${name}:${i.key}`] === String(i.at);
    return { ...i, unreadAtSource: true, unread: !here, readHere: here };
  }) };
}

function startPolling() {
  const every = Math.max(1, Number(process.env.CLEARSKY_POLL_MINUTES) || 3) * 6e4;
  hasNotifySend().then((n) => { poller.notifier = n; });
  const tick = () => pollAttention(true).catch((e) => console.error(`clearsky: poll failed: ${e.message}`));
  setTimeout(tick, 2000).unref?.();
  poller.timer = setInterval(tick, every);
  poller.timer.unref?.();
}

// Restart without cutting off Copilot: wait until no chat here is working or waiting for an OK,
// then start a fresh server (or, under systemd, exit for it to restart us). Idle chats carry on
// after the restart, because a new message reopens the session.
const restart = { pending: null, timer: null, server: null };
// A restart waits for chats started here that are mid-answer or waiting on your Allow/Deny.
// Chats done with their turn, and Copilot in a terminal or editor, don't hold it up.
const chatsBusy = () => [...acpChats.values()].filter((c) => c.busy || c.waiting.size).length;
function busyChats() {
  const names = localState.sessionNames(stateFile), titles = new Map((sessionsCache?.data || []).map((x) => [x.id, x.title]));
  return [...acpChats.entries()].filter(([, c]) => c.busy || c.waiting.size)
    .map(([id, c]) => ({ id, title: names[id] || titles.get(id) || 'Copilot chat', status: needsYou(c) ? 'needs-you' : 'working' }));
}
// The page: web/index.html with web/css/app.css and web/js/*.js (in name order, one shared
// scope) put inline, so it stays one request and works offline.
export function buildPage(csrf, web = join(here, '..', 'web')) {
  const css = readFileSync(join(web, 'css', 'app.css'), 'utf8');
  const js = readdirSync(join(web, 'js')).filter((n) => n.endsWith('.js')).sort()
    .map((n) => readFileSync(join(web, 'js', n), 'utf8')).join('\n');
  return readFileSync(join(web, 'index.html'), 'utf8').replace('__CSRF__', csrf)
    .replace('/*__CSS__*/', () => css).replace('/*__JS__*/', () => js);
}

// Whether Clearsky's files changed since this process started (a pull), so a restart would update it.
const startedAt = Date.now();
function updateReady() {
  const root = join(here, '..');
  for (const dir of ['bin', 'lib', 'lib/sources', 'lib/modules', 'web', 'web/js', 'web/css']) {
    let names = [];
    try { names = readdirSync(join(root, dir)); } catch { continue; }
    for (const n of names) {
      try { if (/\.(mjs|html|js|css)$/.test(n) && statSync(join(root, dir, n)).mtimeMs > startedAt) return true; } catch { /* gone */ }
    }
  }
  return false;
}
function restartWhenIdle({ maxWaitMinutes = 60, force = false } = {}) {
  // "Restart now" while a restart waits: stop waiting.
  if (restart.pending) { if (force) { restart.pending.force = true; restart.check?.(); } return restart.pending; }
  restart.pending = { since: new Date().toISOString(), until: new Date(Date.now() + maxWaitMinutes * 6e4).toISOString(), busy: chatsBusy(), force };
  const check = restart.check = () => {
    if (!restart.pending.force && chatsBusy()) {
      if (Date.now() > Date.parse(restart.pending.until)) { console.log('clearsky: restart given up, Copilot is still working'); clearInterval(restart.timer); restart.pending = null; }
      return;
    }
    clearInterval(restart.timer);
    console.log('clearsky: restarting');
    for (const c of acpChats.values()) c.agent.close();
    stopSandbox().catch(() => {});
    restart.server?.close();
    if (process.env.CLEARSKY_SUPERVISED === '1') process.exit(75); // a supervisor (systemd) starts us again
    spawn(process.execPath, process.argv.slice(1), { detached: true, stdio: 'inherit', env: process.env, cwd: process.cwd() }).unref();
    setTimeout(() => process.exit(0), 200);
  };
  restart.timer = setInterval(check, 3000);
  check();
  return restart.pending;
}

function serve() {
  // A bug in a library (srt's proxy, say) shouldn't take the dashboard and every chat down with it.
  process.on('uncaughtException', (e) => console.error(`clearsky: unexpected error, still running: ${e?.stack || e}`));
  // Every state-changing request must carry this token and come from this origin, so other
  // websites open in the browser can't change settings or start logins. It's kept across
  // restarts so an open page keeps working.
  const csrf = localToken(join(dirname(userEnvFile), 'csrf'));
  const page = buildPage(csrf);
  const settingsPage = readFileSync(join(here, '..', 'web', 'settings.html'), 'utf8').replace('__CSRF__', csrf)
    .replace('/*__CSS__*/', () => readFileSync(join(here, '..', 'web', 'css', 'app.css'), 'utf8'));
  // A container publishes its port to another one on the host (CLEARSKY_PUBLIC_PORT), and the
  // browser then names that port.
  const ports = [...new Set([config.port, Number(process.env.CLEARSKY_PUBLIC_PORT) || config.port])];
  const origins = new Set(ports.flatMap((p) => [`http://127.0.0.1:${p}`, `http://localhost:${p}`]));
  const json = (res, code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  // Only answer to this machine's own names, so a web page can't reach the API through a
  // DNS name it controls that points here.
  const hosts = new Set(ports.flatMap((p) => [`127.0.0.1:${p}`, `localhost:${p}`]));

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (!hosts.has(req.headers.host)) return json(res, 421, { error: 'wrong host' });
    try {
      if (req.method === 'POST') {
        if (req.headers['x-clearsky-token'] !== csrf || (req.headers.origin && !origins.has(req.headers.origin))) {
          return json(res, 403, { error: 'forbidden' });
        }
        if (url.pathname === '/api/restart') {
          const { maxWaitMinutes, force } = await readJson(req).catch(() => ({}));
          if (force === true) console.log(`clearsky: restart now, stopping ${chatsBusy()} busy chat(s)`);
          return json(res, 200, { restart: restartWhenIdle({ maxWaitMinutes: Math.min(Math.max(Number(maxWaitMinutes) || 60, 1), 240), force: force === true }) });
        }
        // End a chat's Copilot. Its conversation stays; the next message resumes it in a new one.
        if (url.pathname === '/api/copilot/close') {
          const { chat } = await readJson(req);
          const c = acpChats.get(String(chat || ''));
          if (c) { stopCopilot(String(chat)); c.agent.close(); acpChats.delete(String(chat)); }
          return json(res, 200, { closed: !!c });
        }
        if (url.pathname === '/api/copilot/stop') {
          const { chat } = await readJson(req);
          return json(res, 200, { stopped: stopCopilot(String(chat || '')) });
        }
        // Your own name for a Copilot session; it wins over the title Copilot gave it.
        if (url.pathname === '/api/copilot/rename') {
          const { id, title } = await readJson(req);
          if (!/^[\w-]{8,64}$/.test(String(id || '')) || typeof title !== 'string' || !title.trim()) return json(res, 400, { error: 'bad session or title' });
          localState.setSessionName(stateFile, id, title.trim().split('\n')[0]);
          sessionsCache = null;
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
        if (url.pathname === '/api/copilot') {
          const body = await readJson(req);
          const info = await copilotInfo();
          if (!info.available) return json(res, 400, { error: 'GitHub Copilot CLI not found; install it or set COPILOT_BIN' });
          const message = String(body.message || '').slice(0, 20_000);
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
          // A PR or ticket chat with no clone found starts in your first folder (Settings → Copilot).
          const cwd = checkout || (body.cwd && isDir(body.cwd) ? body.cwd : (refs.length && !body.resume && copilotFolders().map((d) => d.replace(/^~(?=\/|$)/, homedir())).find(isDir)) || copilotCwd());
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
          const sandboxHint = process.env.COPILOT_SANDBOX === 'srt' || body.permission === 'sandboxed' ? `\n\n${SANDBOX_HINT}` : '';
          const folders = foldersHint();
          const prefix = [!body.resume && `${CONTEXT_INTRO}\n\n${copilotContext()}\n\n${CHOICES_HINT}\n\n${PR_HINT}${folders && `\n\n${folders}`}${sandboxHint}`, refText].filter(Boolean).join('\n\n---\n\n');
          const prompt = prefix ? `${prefix}${MSG_MARK}${message}` : message;
          // Answers stream back as one JSON event per line: text, tool, permission, done, error.
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
          let sessionId = body.session;
          const emit = (e) => {
            if (e.type === 'session') { sessionId = e.id; linkRefs(); }
            if (!res.writableEnded && !res.destroyed) res.write(`${JSON.stringify(e)}\n`);
          };
          // A new chat about one item is named after it. (Copilot 1.0.105 ignores /rename over ACP, so the name lives here.)
          const itemName = !body.resume && refs.length === 1 ? itemSessionName(refs[0]) : null;
          // Remember which PRs and tickets this session is about, for the links on the page.
          const linkRefs = () => {
            if (refs.length) localState.addSessionRefs(stateFile, sessionId, refs.map(refKey));
            if (prefix && !body.resume) localState.setSessionTitle(stateFile, sessionId, message.trim().split('\n')[0]);
            if (itemName) localState.setSessionName(stateFile, sessionId, itemName);
          };
          res.on('close', linkRefs);
          if (cwd !== (body.cwd || copilotCwd())) emit({ type: 'cwd', cwd });
          if (itemName) emit({ type: 'title', title: itemName });
          sessionsCache = null;
          try {
            await acpTurn({ chat: body.session, options, prompt, resumeId: body.resume ? body.session : null, cwd, emit, res, bin: info.bin });
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
        if (url.pathname === '/api/dismiss') {
          return json(res, 200, { dismissed: localState.setDismissed(stateFile, await readJson(req)) });
        }
        if (url.pathname === '/api/settings') {
          const values = settings.validate(await readJson(req));
          settings.writeEnvFile(userEnvFile, values);
          applySettings(values);
          return json(res, 200, await settingsStatus());
        }
        // Show or hide one calendar's events; saved like a setting, without refetching everything.
        if (url.pathname === '/api/calendar/hidden') {
          const { name, hidden } = await readJson(req);
          if (typeof name !== 'string' || !name.trim() || /[,\r\n]/.test(name)) return json(res, 400, { error: 'bad calendar name' });
          const now = hiddenCalendars();
          if (hidden) now.add(name.trim().toLowerCase()); else now.delete(name.trim().toLowerCase());
          const values = settings.validate({ CALENDAR_HIDDEN: [...now].join(',') });
          settings.writeEnvFile(userEnvFile, values);
          if (values.CALENDAR_HIDDEN) process.env.CALENDAR_HIDDEN = values.CALENDAR_HIDDEN; else delete process.env.CALENDAR_HIDDEN;
          return json(res, 200, { hidden: [...now] });
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
      if (url.pathname === '/settings') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(settingsPage);
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
          if (part[2] === 'detail') return json(res, 200, await p.detail(key, makeContext(p), data));
          return sendFile(res, await p.attachment(key, url.searchParams.get('id') || '', makeContext(p), data));
        } catch (e) {
          return json(res, e.auth ? 401 : 502, { error: e.message, ...(e.auth && { needsLogin: true }) });
        }
      }
      const src = url.pathname.match(/^\/api\/source\/(\w+)$/)?.[1];
      if (src) {
        if (!SOURCES[src]) return json(res, 404, { error: 'unknown source' });
        const data = await source(src, url.searchParams.has('refresh'));
        const shown = withReads(src, data);
        return json(res, 200, { ...shown, work: workItemsOf(src, shown), fetchedAt: new Date(sourceCache.get(src)?.at || Date.now()).toISOString() });
      }
      // The app window's manifest and icons (Clearsky in its own window: `clearsky app`).
      const asset = { '/manifest.webmanifest': 'application/manifest+json', '/icon.svg': 'image/svg+xml', '/icon-192.png': 'image/png', '/icon-512.png': 'image/png' }[url.pathname];
      if (asset) {
        res.writeHead(200, { 'Content-Type': asset, 'Cache-Control': 'max-age=3600' });
        return res.end(readFileSync(join(here, '..', 'web', url.pathname.slice(1))));
      }
      if (url.pathname === '/favicon.ico') { res.writeHead(302, { Location: '/icon.svg' }); return res.end(); }
      if (url.pathname === '/api/modules') return json(res, 200, { modules: moduleManifests() });
      if (url.pathname === '/api/sources') {
        return json(res, 200, { sources: [...plugins.sources.values()].map((p) => ({ name: p.name, label: p.label, area: p.area, panel: p.panel || null })), errors: plugins.errors });
      }
      // What needs you, with when each first showed up, so the page can mark what's new.
      // What was notified lately, to find out why something came twice.
      if (url.pathname === '/api/notifications/log') return json(res, 200, { log: localState.notifiedLog(stateFile), pollMinutes: Math.max(1, Number(process.env.CLEARSKY_POLL_MINUTES) || 3), notifier: poller.notifier, pid: process.pid });
      if (url.pathname === '/api/attention') {
        const data = Object.fromEntries(await Promise.all(ATTENTION_SOURCES.map(async (n) => [n, await source(n, false)])));
        const seen = localState.seen(stateFile);
        return json(res, 200, { lastPoll: poller.lastPoll, notifier: poller.notifier,
          items: [...attentionItems(data), ...await pluginAttention(false)].map((it) => ({ ...it, at: seen[it.key]?.stamp === String(it.stamp ?? '') ? seen[it.key].at : null })) });
      }
      if (url.pathname === '/api/copilot') return json(res, 200, { ...await copilotInfo(url.searchParams.has('refresh')), commands: copilotCommands });
      // What one chat runs with, for the panel beside it.
      if (url.pathname === '/api/copilot/chat') {
        const id = url.searchParams.get('id') || '';
        const c = acpChats.get(id);
        const tilde = (p) => (p.startsWith(homedir()) ? `~${p.slice(homedir().length)}` : p);
        return json(res, 200, {
          running: !!c && !c.agent.closed, busy: !!c?.busy, sandboxed: c ? !!c.agent.sandboxed : null, hosts: c?.agent.hosts || null, github: c?.agent.github || null,
          cwd: c?.cwd ? tilde(c.cwd) : null,
          folders: copilotFolders().map(tilde), read: list(process.env.COPILOT_READ).map(tilde),
          sandbox: process.env.COPILOT_SANDBOX === 'srt',
          usage: /^[\w-]{8,64}$/.test(id) ? sessionUsage(join(homedir(), '.copilot'), id) : null,
        });
      }
      if (url.pathname === '/api/copilot/sessions') {
        const info = await copilotInfo();
        if (!info.available) return json(res, 400, { error: 'GitHub Copilot CLI not found' });
        return json(res, 200, { cwd: copilotCwd(), sessions: await copilotSessions(info.bin, url.searchParams.has('refresh')) });
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
        return json(res, 200, { id: histId, cwd, here: !!c, busy, messages, title: localState.sessionNames(stateFile)[histId] || null });
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
      const prsFor = url.pathname.match(/^\/api\/issue\/([A-Z][A-Z0-9_]+-\d+)\/prs$/)?.[1];
      if (prsFor) return json(res, 200, await ghModule.ticketPrs(prsFor));
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
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        return res.end(JSON.stringify(data));
      }
      if (url.pathname === '/' || url.pathname === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(page);
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
  });
  server.listen(config.port, config.bind);
}

// `clearsky restart`: ask the running server to restart once Copilot is idle.
async function restartCommand(args) {
  const csrf = readFileSync(join(dirname(userEnvFile), 'csrf'), 'utf8').trim();
  const base = `http://127.0.0.1:${config.port}`;
  const res = await fetch(`${base}/api/restart`, { method: 'POST', headers: { 'X-Clearsky-Token': csrf, 'Content-Type': 'application/json' },
    body: JSON.stringify({ force: args.includes('--now'), maxWaitMinutes: Number(args[args.indexOf('--wait') + 1]) || undefined }) });
  const { restart: r } = await res.json();
  console.log(r.busy && !args.includes('--now') ? `Restarting once Copilot is done (${r.busy} chat${r.busy > 1 ? 's' : ''} working; gives up at ${r.until}).` : 'Restarting now.');
}

export { findBrowser };

// Your default browser, as the desktop opens links.
function openInBrowser(u) {
  // Windows' start would read & as a command separator; rundll32 takes the URL as it is.
  const [cmd, ...pre] = process.platform === 'darwin' ? ['open'] : process.platform === 'win32' ? ['rundll32', 'url.dll,FileProtocolHandler'] : ['xdg-open'];
  spawn(cmd, [...pre, u], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}
// The launcher's StartupWMClass, so GNOME files the window under Clearsky (icon, Alt+Tab, and a
// click on the icon brings it back): on Wayland Chrome names an --app window by its address and
// profile (chrome-127.0.0.1__-Default) and ignores --class, which only X11 uses.
function fixLauncher(env = process.env) {
  const file = join(env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'applications', 'clearsky.desktop');
  const wm = env.XDG_SESSION_TYPE === 'wayland' ? 'chrome-127.0.0.1__-Default' : 'Clearsky';
  try {
    const text = readFileSync(file, 'utf8');
    const next = text.replace(/^StartupWMClass=.*$/m, `StartupWMClass=${wm}`);
    if (next !== text) writeFileSync(file, next);
  } catch { /* no launcher installed */ }
}

// `clearsky app`: Clearsky in a window of its own (Chromium's app mode: no tabs or address bar),
// starting the server first when it isn't running. Links elsewhere open in your default browser.
async function appCommand() {
  const base = `http://127.0.0.1:${config.port}`;
  const up = () => fetch(`${base}/api/restart`).then((r) => r.ok, () => false);
  if (!(await up())) {
    // Clearsky runs in Docker once `clearsky docker up` has run (until `clearsky docker down`):
    // start that container, else Clearsky here.
    if (existsSync(join(dirname(userEnvFile), 'docker-mounts.yml'))) await dockerCommand(['start']);
    else spawn(process.execPath, [fileURLToPath(import.meta.url), 'serve', '--port', String(config.port)], { detached: true, stdio: 'ignore', env: process.env, cwd: join(here, '..') }).unref();
    for (let i = 0; i < 50 && !(await up()); i++) await new Promise((r) => setTimeout(r, 200));
  }
  const browser = findBrowser();
  if (!browser) { console.error(`No Chromium-based browser found (tried ${BROWSERS.join(', ')}). Set CLEARSKY_BROWSER, or open ${base}`); process.exit(1); }
  // A size that fits a laptop screen (CLEARSKY_WINDOW_SIZE=1600,1000 for another); the page
  // shrinks the window too when the browser remembers one taller than the screen.
  const size = /^\d+,\d+$/.test(process.env.CLEARSKY_WINDOW_SIZE || '') ? process.env.CLEARSKY_WINDOW_SIZE : '1280,860';
  // A browser profile of its own: in your running browser the window would be filed under the
  // browser (Wayland ignores --class there), so it couldn't be found as Clearsky in the dock or
  // Alt+Tab. No logins needed in it: links open in your default browser.
  const profile = join(dirname(userEnvFile), 'app-window');
  if (process.platform === 'linux') fixLauncher();
  spawn(browser, [`--app=${base}/?app=1`, '--class=Clearsky', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', `--window-size=${size}`],
    { detached: true, stdio: 'ignore' }).unref();
}

// `clearsky docker …`: Clearsky's container, with the folders from Settings → Copilot mounted
// (see lib/docker.mjs). Runs on your machine, not in the container.
async function dockerCommand([sub = 'up', ...rest]) {
  const { dockerMounts, writeMountsFile } = await import('../lib/docker.mjs');
  if (process.env.CLEARSKY_IN_CONTAINER === '1') { console.error('Run this on your machine, not in the container.'); process.exitCode = 1; return; }
  const repo = join(here, '..');
  for (const d of [dirname(userEnvFile), join(homedir(), '.copilot')]) mkdirSync(d, { recursive: true, mode: 0o700 });
  const mounts = dockerMounts({ folders: copilotFolders(), cwd: process.env.COPILOT_CWD, home: homedir() });
  const file = writeMountsFile(join(dirname(userEnvFile), 'docker-mounts.yml'), mounts);
  if (sub === 'mounts') { for (const m of mounts) console.log(`${m.path}${m.ro ? ' (read-only)' : ''}`); return; }
  const files = [join(repo, 'docker-compose.yml'), file, join(repo, 'docker-compose.override.yml')].filter((f) => existsSync(f)).flatMap((f) => ['-f', f]);
  const compose = { up: ['up', '-d', '--build', ...rest], start: ['up', '-d', ...rest], down: ['down', ...rest], logs: ['logs', '--tail', '50', ...rest], login: ['exec', '-it', 'clearsky', 'clearsky-login', ...rest] }[sub];
  if (!compose) { console.error('usage: clearsky docker [up|start|down|logs|login|mounts]'); process.exitCode = 1; return; }
  const env0 = { ...process.env, HOME_DIR: homedir(), UID: String(process.getuid?.() ?? 1000), GID: String(process.getgid?.() ?? 1000), PORT: String(config.port) };
  // Logging in: bring over the logins this machine already has (gh, and Copilot with gh's
  // token; acli with an API token, as its own login can't be copied), the rest in the browser.
  if (sub === 'login' && !rest.length) {
    const inside = (cmd, input) => new Promise((done) => {
      const p = spawn('docker', ['compose', ...files, 'exec', '-T', 'clearsky', 'sh', '-c', `. ~/.session-bus; ${cmd}`], { stdio: ['pipe', 'inherit', 'inherit'], env: env0, cwd: repo });
      p.on('exit', (c) => done(c === 0)).on('error', () => done(false));
      p.stdin.end(input || '');
    });
    const left = [];
    const gh = await execFileP('gh', ['auth', 'token'], { timeout: 10_000 }).then((r) => r.stdout.trim()).catch(() => '');
    if (gh && await inside('gh auth login --with-token', `${gh}\n`)) console.log('gh: logged in with this machine\'s login');
    else left.push('gh');
    if (gh && await inside('copilot login --with-token', `${gh}\n`)) console.log('Copilot: logged in with gh\'s login');
    else left.push('copilot');
    // acli's web login calls back to a port on 127.0.0.1, which your browser can only reach
    // when acli shares this machine's network: a one-off container that does, with the same
    // folders and keyring (Clearsky's container stops meanwhile, so one keyring is in use).
    const acliOk = await inside('acli jira auth status >/dev/null 2>&1');
    if (acliOk) console.log('acli: logged in already');
    else if (process.stdin.isTTY) {
      console.log('acli: logging in through your browser (Clearsky pauses for it)…');
      const compose = (...a) => new Promise((done) => spawn('docker', ['compose', ...files, ...a], { stdio: 'inherit', env: env0, cwd: repo }).on('exit', done).on('error', done));
      await compose('stop', 'clearsky');
      const home = homedir(), ids = `${env0.UID}:${env0.GID}`;
      const tmp = (p, exec) => ['--tmpfs', `${p}:uid=${env0.UID},gid=${env0.GID},mode=0700${exec ? ',exec' : ''}`];
      // acli only opens a browser when it sees a display; the "browser" in there is the shim.
      const args = ['run', '--rm', '-it', '--network', 'host', '--user', ids, '-e', `HOME=${home}`, '-e', 'DISPLAY=:0', '-e', 'WAYLAND_DISPLAY=wayland-0',
        ...tmp(home, true), ...tmp(join(home, '.config')), ...tmp(join(home, '.cache'), true),
        ...mounts.flatMap((m) => ['-v', `${m.path}:${m.path}${m.ro ? ':ro' : ''}`]),
        'clearsky:local', '--run', 'acli jira auth login --web'];
      // The container leaves the login link in a file; open it here, in your own browser.
      const urlFile = join(dirname(userEnvFile), 'container', 'open-url');
      try { rmSync(urlFile, { force: true }); } catch {}
      const watch = setInterval(() => {
        let u = '';
        try { u = readFileSync(urlFile, 'utf8').trim(); rmSync(urlFile, { force: true }); } catch { return; }
        if (!/^https:\/\//.test(u)) return;
        process.stderr.write(`\nOpening ${u}\n`);
        openInBrowser(u);
      }, 300);
      const ok = await new Promise((done) => spawn('docker', args, { stdio: 'inherit' }).on('exit', (c) => done(c === 0)).on('error', () => done(false)));
      clearInterval(watch);
      await compose('up', '-d');
      if (!ok) left.push('acli');
    } else left.push('acli');
    if (!left.length) return;
    if (left.includes('acli')) console.log('acli: not logged in; run `clearsky docker login` again in a terminal to log in through the browser.');
    if (!left.some((x) => x !== 'acli')) return;
    console.log(`Now in the browser: ${left.filter((x) => x !== 'acli').join(', ')}`);
    for (const t of left.filter((x) => x !== 'acli')) await new Promise((done) => spawn('docker', ['compose', ...files, 'exec', '-it', 'clearsky', 'clearsky-login', t], { stdio: 'inherit', env: env0, cwd: repo }).on('exit', done).on('error', done));
    return;
  }
  if (sub === 'up') console.log(`Mounting ${mounts.length} folders (clearsky docker mounts lists them).`);
  const code = await new Promise((done) => spawn('docker', ['compose', ...files, ...compose], { stdio: 'inherit', env: env0, cwd: repo }).on('exit', done).on('error', (e) => { console.error(e.message); done(1); }));
  process.exitCode = code || 0;
  // Back to running natively: the app window starts Clearsky here again.
  if (sub === 'down' && !code) rmSync(file, { force: true });
}

// ---------------------------------------------------------------- main

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const args = process.argv.slice(2);
  if (args.includes('-h') || args.includes('--help')) {
    console.log('usage: clearsky [--json] | clearsky standup [--json] | clearsky serve [--port N] | clearsky restart [--now] [--wait MIN] [--port N] | clearsky app [--port N] | clearsky docker [up|start|down|logs|login|mounts] [--port N] | clearsky school-handover | clearsky jira-debug');
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
  } else if (args[0] === 'docker') {
    const p = args.indexOf('--port');
    if (p > -1) { config.port = Number(args[p + 1]); args.splice(p, 2); }
    await dockerCommand(args.slice(1));
  } else if (args[0] === 'school-handover') {
    const { handOverLogin } = await import('../lib/flyt.mjs');
    const where = await handOverLogin();
    console.log(where ? `School login moved to ${where}; Clearsky's container takes it from there.` : 'No school login here to hand over.');
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
