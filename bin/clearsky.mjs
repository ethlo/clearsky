#!/usr/bin/env node
// clearsky: one view of what needs your attention on GitHub, Jira and Slack.
// Zero dependencies, Node 22+. See README.md.
//
//   clearsky              print a Markdown summary
//   clearsky --json       print the raw data as JSON (for Copilot skills / scripts)
//   clearsky serve        serve the dashboard on http://127.0.0.1:7777

import { createServer } from 'node:http';
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { eventsBetween } from '../lib/ics.mjs';
import { randomBytes } from 'node:crypto';
import * as settings from '../lib/settings.mjs';

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
    email: env.CALENDAR_EMAIL, // optional; used to drop events you declined
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

// ---------------------------------------------------------------- GitHub

const PR_FIELDS = `
  number title url isDraft createdAt updatedAt reviewDecision mergeable
  additions deletions changedFiles
  repository { nameWithOwner }
  author { login }
  reviews(last: 30) { nodes { state submittedAt author { login } } }
  reviewRequests(first: 20) { nodes { requestedReviewer { __typename ... on User { login } ... on Team { slug } } } }
  reviewThreads(first: 100) { nodes { isResolved } }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
  timelineItems(itemTypes: [REVIEW_REQUESTED_EVENT], last: 10) {
    nodes { ... on ReviewRequestedEvent { createdAt requestedReviewer { __typename ... on User { login } ... on Team { slug } } } }
  }`;

const ITEM_FIELDS = `
  __typename
  ... on Issue { number title url updatedAt repository { nameWithOwner } author { login } labels(first: 10) { nodes { name } } }
  ... on PullRequest { number title url updatedAt repository { nameWithOwner } author { login } }`;

async function gql(query, variables) {
  const { api, token } = config.github;
  const graphqlUrl = api.endsWith('/api/v3') ? api.replace(/\/v3$/, '/graphql') : `${api}/graphql`;
  const res = await http(graphqlUrl, {
    headers: { Authorization: `Bearer ${token}` },
    body: { query, variables },
  });
  if (res.errors?.length) throw new Error(`GitHub: ${res.errors.map((e) => e.message).join('; ')}`);
  return res.data;
}

function ciState(pr) {
  return pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state || null; // SUCCESS FAILURE ERROR PENDING EXPECTED
}

function latestReviewsByUser(pr, me) {
  const byUser = new Map();
  for (const r of pr.reviews?.nodes || []) {
    const who = r.author?.login;
    if (!who || who === me || r.state === 'PENDING') continue;
    // A plain comment does not override an earlier approval / change request.
    if (r.state === 'COMMENTED' && byUser.has(who)) continue;
    byUser.set(who, r);
  }
  return [...byUser.values()];
}

// Who has the ball on one of my PRs, and why.
export function myPrStatus(pr, me) {
  const ci = ciState(pr);
  const reviews = latestReviewsByUser(pr, me);
  const approvals = reviews.filter((r) => r.state === 'APPROVED').length;
  const changes = reviews.filter((r) => r.state === 'CHANGES_REQUESTED').length;
  const unresolved = (pr.reviewThreads?.nodes || []).filter((t) => !t.isResolved).length;
  const approved = pr.reviewDecision === 'APPROVED' || (!pr.reviewDecision && approvals > 0);

  if (pr.isDraft) return { label: 'Draft', owner: 'me', tone: 'neutral' };
  if (pr.mergeable === 'CONFLICTING') return { label: 'Merge conflict', owner: 'me', tone: 'bad' };
  if (ci === 'FAILURE' || ci === 'ERROR') return { label: 'CI failing', owner: 'me', tone: 'bad' };
  if (pr.reviewDecision === 'CHANGES_REQUESTED' || changes > 0) return { label: 'Changes requested', owner: 'me', tone: 'bad' };
  if (unresolved > 0) return { label: `${unresolved} unresolved thread${unresolved > 1 ? 's' : ''}`, owner: 'me', tone: 'warn' };
  if (approved && (ci === 'PENDING' || ci === 'EXPECTED')) return { label: 'Approved, CI running', owner: 'others', tone: 'wait' };
  if (approved) return { label: 'Ready to merge', owner: 'me', tone: 'good' };
  if (reviews.some((r) => r.state === 'COMMENTED')) return { label: 'Has feedback', owner: 'me', tone: 'warn' };
  return { label: 'Waiting for review', owner: 'others', tone: 'wait' };
}

function reviewerName(r) {
  return r?.login || (r?.slug ? `team:${r.slug}` : null);
}

// Without GITHUB_TOKEN, borrow the GitHub CLI's login if there is one.
async function ghCliToken() {
  try {
    return (await execFileP('gh', ['auth', 'token'], { timeout: 10_000 })).stdout.trim() || null;
  } catch {
    return null;
  }
}

async function fetchGitHub() {
  config.github.token ||= await ghCliToken();
  const { token, orgs, ignoreAuthors } = config.github;
  if (!token) return { error: 'GITHUB_TOKEN is not set and `gh auth token` gave nothing' };

  const { viewer } = await gql('query { viewer { login } }');
  const me = viewer.login;
  const scope = `${orgs.map((o) => `org:${o}`).join(' ')} archived:false`;
  const since = daysAgoIso(config.days);

  const data = await gql(
    `query($rr: String!, $mine: String!, $ment: String!, $asg: String!) {
      reviewRequested: search(query: $rr, type: ISSUE, first: 50) { nodes { ... on PullRequest { ${PR_FIELDS} } } }
      myPrs: search(query: $mine, type: ISSUE, first: 50) { nodes { ... on PullRequest { ${PR_FIELDS} } } }
      mentions: search(query: $ment, type: ISSUE, first: 30) { nodes { ${ITEM_FIELDS} } }
      assigned: search(query: $asg, type: ISSUE, first: 50) { nodes { ${ITEM_FIELDS} } }
    }`,
    {
      rr: `is:pr is:open review-requested:${me} ${scope}`,
      mine: `is:pr is:open author:${me} ${scope}`,
      ment: `mentions:${me} updated:>=${since} ${scope} sort:updated-desc`,
      asg: `is:issue is:open assignee:${me} ${scope} sort:updated-desc`,
    },
  );

  const keep = (n) => n && n.number && !ignoreAuthors.includes(n.author?.login);
  const base = (n) => ({
    repo: n.repository.nameWithOwner,
    number: n.number,
    title: n.title,
    url: n.url,
    author: n.author?.login || 'ghost',
    updatedAt: n.updatedAt,
  });

  const reviewRequested = data.reviewRequested.nodes.filter(keep).map((pr) => {
    const requests = (pr.timelineItems?.nodes || []).filter((e) => reviewerName(e.requestedReviewer));
    const mine = requests.filter((e) => e.requestedReviewer?.login === me);
    const requestedAt = (mine.at(-1) || requests.at(-1))?.createdAt || pr.createdAt;
    const reviewedBefore = (pr.reviews?.nodes || []).some((r) => r.author?.login === me && r.state !== 'PENDING');
    return {
      ...base(pr),
      draft: pr.isDraft,
      requestedAt,
      viaTeam: mine.length === 0,
      rerequested: reviewedBefore,
      ci: ciState(pr),
      size: { additions: pr.additions, deletions: pr.deletions, files: pr.changedFiles },
    };
  });

  const myPrs = data.myPrs.nodes.filter((n) => n && n.number).map((pr) => {
    const reviews = latestReviewsByUser(pr, me);
    return {
      ...base(pr),
      draft: pr.isDraft,
      status: myPrStatus(pr, me),
      ci: ciState(pr),
      approvals: reviews.filter((r) => r.state === 'APPROVED').map((r) => r.author.login),
      changesRequested: reviews.filter((r) => r.state === 'CHANGES_REQUESTED').map((r) => r.author.login),
      commented: reviews.filter((r) => r.state === 'COMMENTED').map((r) => r.author.login),
      unresolvedThreads: (pr.reviewThreads?.nodes || []).filter((t) => !t.isResolved).length,
      pendingReviewers: (pr.reviewRequests?.nodes || []).map((n) => reviewerName(n.requestedReviewer)).filter(Boolean),
    };
  });

  const mentions = data.mentions.nodes.filter(keep).map((n) => ({
    ...base(n),
    kind: n.__typename === 'PullRequest' ? 'PR' : 'Issue',
  }));

  const assigned = data.assigned.nodes.filter((n) => n && n.number).map((n) => ({
    ...base(n),
    labels: (n.labels?.nodes || []).map((l) => l.name),
  }));

  return { login: me, orgs, reviewRequested, myPrs, mentions, assigned };
}

// ---------------------------------------------------------------- Jira (via acli)
//
// All Jira access goes through the Atlassian CLI, so authentication is whatever
// `acli jira auth login` set up. acli's JSON mirrors the Jira REST shapes, but the
// readers below are tolerant of small differences (wrappers, flat fields).

const execFileP = promisify(execFile);

async function acli(args) {
  try {
    const { stdout } = await execFileP(config.jira.acli, ['jira', ...args], { maxBuffer: 32 * 1024 * 1024, timeout: 60_000 });
    return stdout.trim() ? JSON.parse(stdout) : null;
  } catch (e) {
    if (e.code === 'ENOENT') throw new Error(`acli not found (looked for "${config.jira.acli}"); install it or set ACLI_BIN`);
    if (e instanceof SyntaxError) throw new Error(`acli returned non-JSON output for "jira ${args.slice(0, 2).join(' ')}"`);
    const msg = (e.stderr || e.message || '').toString().trim().split('\n').slice(-3).join(' ');
    throw new Error(`acli jira ${args.slice(0, 2).join(' ')} failed: ${msg}`);
  }
}

const listOf = (out, ...keys) => {
  if (Array.isArray(out)) return out;
  for (const k of keys) if (Array.isArray(out?.[k])) return out[k];
  return [];
};
const fieldsOf = (i) => i.fields || i;
const nameOf = (v) => (v && typeof v === 'object' ? v.name ?? v.displayName ?? v.value : v) ?? null;

// acli only accepts some fields in search (e.g. it rejects duedate, updated, project).
// Drop whatever it refuses and remember that for later searches.
const refusedFields = new Set();

async function jiraSearch(jql, fields, limit = 50) {
  const wanted = fields.filter((f) => !refusedFields.has(f));
  try {
    const out = await acli(['workitem', 'search', '--jql', jql, '--fields', wanted.join(','), '--limit', String(limit), '--json']);
    return listOf(out, 'issues', 'workItems', 'values', 'results');
  } catch (e) {
    const m = e.message.match(/fields? '([^']+)' (?:are|is) not allowed/);
    const refused = m ? m[1].split(',').map((f) => f.trim()).filter((f) => wanted.includes(f)) : [];
    if (!refused.length) throw e;
    refused.forEach((f) => refusedFields.add(f));
    return jiraSearch(jql, fields, limit);
  }
}

// `workitem comment list` flattens bodies to plain text and drops @mentions, so read the
// comments through `workitem view`, which keeps the rich-text (ADF) body and author objects.
async function jiraComments(key) {
  const out = await acli(['workitem', 'view', key, '--fields', 'comment', '--json']);
  const f = out?.fields || out || {};
  return listOf(f.comment, 'comments', 'values');
}

// Comment bodies are either wiki text or Atlassian Document Format (ADF).
function commentInfo(body) {
  if (typeof body === 'string') {
    const ids = [...body.matchAll(/\[~(?:accountid:)?([^\]]+)\]/gi)].map((m) => m[1]);
    return { ids, text: body };
  }
  const ids = [], parts = [];
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (n.type === 'mention') { ids.push(n.attrs?.id); parts.push(`[~accountid:${n.attrs?.id}]`); }
    else if (n.type === 'text') parts.push(n.text);
    else if (n.type === 'hardBreak' || n.type === 'paragraph') parts.push(' ');
    walk(n.content);
  };
  walk(body);
  return { ids: ids.filter(Boolean), text: parts.join('') };
}

function excerpt(text, myId) {
  const plain = (text || '')
    .replaceAll(`[~accountid:${myId}]`, '@you').replaceAll(`[~${myId}]`, '@you')
    .replace(/\[~[^\]]+\]/g, '@someone')
    .replace(/\{(code|noformat|quote|panel)[^}]*\}/g, '')
    .replace(/\[([^|\]]+)\|[^\]]+\]/g, '$1')
    .replace(/[*_]{1,2}([^*_]+)[*_]{1,2}/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > 220 ? `${plain.slice(0, 217)}...` : plain;
}

const userId = (u) => u?.accountId || u?.name || u?.key || null;

// acli has no JSON "whoami", so find myself on an issue I'm assigned to or reported.
async function jiraMe() {
  if (config.jira.accountId) return { id: config.jira.accountId, name: null };
  for (const [jql, field] of [['assignee = currentUser() ORDER BY updated DESC', 'assignee'], ['reporter = currentUser() ORDER BY updated DESC', 'reporter']]) {
    const [issue] = await jiraSearch(jql, ['key', field], 1).catch(() => []);
    const u = issue && fieldsOf(issue)[field];
    if (userId(u)) return { id: userId(u), name: u.displayName || null };
  }
  throw new Error('could not work out your Jira account id; set JIRA_ACCOUNT_ID');
}

function browseUrl(issue) {
  const base = config.jira.url || (issue.self ? new URL(issue.self).origin : '');
  return base ? `${base}/browse/${issue.key}` : null;
}

// Run fn over items with limited parallelism (acli is a process per call).
async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

async function fetchJira() {
  const assigned = (await jiraSearch(config.jira.assignedJql,
    ['key', 'summary', 'status', 'priority', 'duedate', 'updated', 'issuetype', 'project'], 100)).map((i) => {
    const f = fieldsOf(i);
    return {
      key: i.key,
      summary: f.summary,
      url: browseUrl(i),
      status: nameOf(f.status),
      statusCategory: f.status?.statusCategory?.key || null, // new | indeterminate | done
      priority: nameOf(f.priority),
      type: nameOf(f.issuetype),
      project: f.project?.key || i.key?.split('-')[0] || null,
      due: f.duedate || null,
      updatedAt: f.updated || null,
    };
  });

  // Find candidate issues, then confirm the mention by reading their comments.
  const me = await jiraMe();
  const days = config.days;
  const involved = 'watcher = currentUser() OR assignee = currentUser() OR reporter = currentUser()';
  const fields = ['key', 'summary', 'status'];
  let candidates;
  try {
    candidates = await jiraSearch(config.jira.mentionsJql ||
      `comment ~ currentUser() AND updated >= -${days}d ORDER BY updated DESC`, fields, 40);
  } catch (e) {
    if (config.jira.mentionsJql) throw e;
    // Some Jira sites reject `comment ~ currentUser()`; fall back to issues I'm involved in.
    candidates = await jiraSearch(`updated >= -${days}d AND (${involved}) ORDER BY updated DESC`, fields, 40);
  }

  const cutoff = Date.now() - days * 864e5;
  const perIssue = await mapLimit(candidates, 4, async (issue) => {
    const f = fieldsOf(issue);
    const found = [];
    for (const c of await jiraComments(issue.key)) {
      if (userId(c.author) === me.id || Date.parse(c.created) < cutoff) continue;
      const { ids, text } = commentInfo(c.body);
      if (!ids.some((id) => id.toLowerCase() === me.id.toLowerCase())) continue;
      const url = browseUrl(issue);
      found.push({
        key: issue.key,
        summary: f.summary,
        status: nameOf(f.status),
        url: url && c.id ? `${url}?focusedCommentId=${c.id}` : url,
        by: c.author?.displayName || 'someone',
        at: c.created,
        excerpt: excerpt(text, me.id),
      });
    }
    return found;
  });
  const mentions = perIssue.flat().sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

  return { user: me.name, assigned, mentions };
}

// Print raw acli output, to check the shapes if Jira data looks wrong.
async function jiraDebug() {
  const [first] = await jiraSearch(config.jira.assignedJql, ['key', 'summary', 'status', 'assignee'], 1);
  console.log('workitem search --json (first item):\n', JSON.stringify(first, null, 2));
  if (first) console.log(`\nview ${first.key} --fields comment --json (first 2 comments):\n`,
    JSON.stringify((await jiraComments(first.key)).slice(0, 2), null, 2));
}

// ---------------------------------------------------------------- Slack

async function slack(method, params = {}) {
  const url = new URL(`${config.slack.api}/${method}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await http(url, { headers: { Authorization: `Bearer ${config.slack.token}` } });
  if (!res.ok) throw new Error(`Slack ${method}: ${res.error}${res.needed ? ` (needs scope ${res.needed})` : ''}`);
  return res;
}

function slackText(text, me) {
  const plain = (text || '')
    .replaceAll(`<@${me}>`, '@you')
    .replace(/<@[A-Z0-9]+(?:\|([^>]+))?>/g, (_, name) => `@${name || 'someone'}`)
    .replace(/<#[A-Z0-9]+\|([^>]*)>/g, '#$1')
    .replace(/<!(here|channel|everyone)[^>]*>/g, '@$1')
    .replace(/<([^|>]+)\|([^>]+)>/g, '$2')
    .replace(/<([^>]+)>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > 220 ? `${plain.slice(0, 217)}...` : plain;
}

async function fetchSlack() {
  if (!config.slack.token) return { disabled: true };
  const auth = await slack('auth.test');
  const me = auth.user_id;
  // Slack's `after:` is exclusive, so go one day further back to cover the whole window.
  const res = await slack('search.messages', {
    query: `<@${me}> after:${daysAgoIso(config.days + 1)}`, sort: 'timestamp', sort_dir: 'desc', count: 50,
  });
  const cutoff = Date.now() - config.days * 864e5;
  const mentions = (res.messages?.matches || [])
    .filter((m) => m.user !== me && Number(m.ts) * 1000 >= cutoff)
    .map((m) => ({
      channel: m.channel?.is_im ? 'DM' : m.channel?.is_mpim ? 'Group DM' : `#${m.channel?.name || '?'}`,
      by: m.username || 'someone',
      at: new Date(Number(m.ts) * 1000).toISOString(),
      url: m.permalink,
      excerpt: slackText(m.text, me),
    }));
  return { user: auth.user, team: auth.team, mentions };
}

// ---------------------------------------------------------------- Calendar

async function fetchCalendar() {
  const { icsUrl, email } = config.calendar;
  if (!icsUrl) return { disabled: true };
  const res = await fetch(icsUrl);
  if (!res.ok) throw new Error(`calendar feed returned ${res.status} ${res.statusText}`);
  const text = await res.text();
  if (!text.includes('BEGIN:VCALENDAR')) throw new Error('CALENDAR_ICS_URL did not return an iCal feed');
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const events = eventsBetween(text, today.getTime(), today.getTime() + 2 * 864e5, email)
    .filter((e) => !e.declined)
    .map(({ declined, ...e }) => e);
  return { events };
}

// ---------------------------------------------------------------- Now / Next

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
export function planNow(d, now = Date.now()) {
  const g = d.github || {}, j = d.jira || {}, s = d.slack || {}, cal = d.calendar || {};
  const timed = (cal.events || []).filter((e) => !e.allDay && !e.transparent)
    .map((e) => ({ ...e, s: Date.parse(e.start), e: Date.parse(e.end) }));
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
  const candidates = [
    ...(g.myPrs || []).filter((p) => p.status.label === 'Ready to merge')
      .map((p) => ({ title: `Merge ${p.repo}#${p.number}`, detail: p.title, url: p.url, minutes: 5, why: 'approved and green' })),
    ...(s.mentions || []).filter((m) => recent(m.at, 24))
      .map((m) => ({ title: `Reply to ${m.by} in ${m.channel}`, detail: m.excerpt, url: m.url, minutes: 5, why: 'Slack mention' })),
    ...(j.mentions || []).filter((m) => recent(m.at, 48))
      .map((m) => ({ title: `Answer ${m.by} on ${m.key}`, detail: m.excerpt, url: m.url, minutes: 10, why: 'Jira mention' })),
    ...[...(g.reviewRequested || [])].filter((p) => !p.draft)
      .sort((a, b) => (b.rerequested - a.rerequested) || Date.parse(a.requestedAt) - Date.parse(b.requestedAt))
      .map((p) => ({ title: `${p.rerequested ? 'Re-review' : 'Review'} ${p.repo}#${p.number}`, detail: p.title, url: p.url,
        minutes: reviewMinutes(p), why: `someone is waiting, requested ${Math.max(1, Math.round((Date.now() - Date.parse(p.requestedAt)) / 36e5))}h ago` })),
    ...(g.myPrs || []).filter((p) => p.status.owner === 'me' && !p.draft && p.status.label !== 'Ready to merge')
      .map((p) => ({ title: `${p.status.label}: ${p.repo}#${p.number}`, detail: p.title, url: p.url, minutes: 30, why: 'your PR is blocked on you' })),
    ...(j.assigned || []).filter((i) => i.statusCategory === 'indeterminate')
      .map((i) => ({ title: `Continue ${i.key}`, detail: i.summary, url: i.url, minutes: 90, why: 'in progress' })),
    ...(j.assigned || []).filter((i) => i.statusCategory !== 'indeterminate').slice(0, 3)
      .map((i) => ({ title: `Start ${i.key}`, detail: i.summary, url: i.url, minutes: 90, why: i.priority ? `${i.priority} priority` : 'next in your queue' })),
  ];

  const suggestions = [];
  let left = freeMinutes;
  for (const c of candidates) {
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
    now: current && strip(current),
    next: next && strip(next),
    freeFrom: new Date(freeFrom).toISOString(),
    freeUntil: new Date(freeUntil).toISOString(),
    freeMinutes,
    afterHours: now >= workdayEnd,
    agenda: timed.filter((e) => e.e > now && e.s < atLocalTime(now, '23:59')).map(strip),
    suggestions,
  };
}

// ---------------------------------------------------------------- collect

const settle = (p) => p.catch((e) => ({ error: e.message }));

export async function collect() {
  const [github, jira, slack, calendar] = await Promise.all(
    [settle(fetchGitHub()), settle(fetchJira()), settle(fetchSlack()), settle(fetchCalendar())]);
  const needsMe = (github.myPrs || []).filter((p) => p.status.owner === 'me' && !p.draft);
  return {
    generatedAt: new Date().toISOString(),
    plan: planNow({ github, jira, slack, calendar }),
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
    calendar,
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
        commits(last: 100) { nodes { commit { committedDate authors(first: 5) { nodes { user { login } } } } } } } } }
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
    const n = (p.commits?.nodes || []).filter((c) => after(c.commit.committedDate) &&
      c.commit.authors.nodes.some((a) => a.user?.login === me)).length;
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
  if (out.length === 1) line('Nothing recorded on GitHub or Jira.');
  out.push('', '*Today*');
  const before = out.length;
  t.inProgress.forEach((i) => line(`Continue ${i.key}: ${i.summary}`));
  if (t.reviews.length) line(`Review ${t.reviews.map((p) => `${p.repo}#${p.number}`).join(', ')}`);
  t.myPrs.forEach((p) => line(`${p.status.label}: ${p.repo}#${p.number} ${p.title}`));
  if (t.meetings.length) line(`Meetings: ${t.meetings.map((e) => `${new Date(e.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} ${e.title}`).join(', ')}`);
  if (out.length === before) line('Pick up the next item from the queue.');
  out.push('', '*Blockers*');
  if (s.blockers.length) s.blockers.forEach((b) => line(b.text));
  else line('None');
  return out.join('\n');
}

export async function standup(work) {
  const since = previousStandup();
  const next = nextStandup();
  const [github, jira] = await Promise.all([settle(standupGitHub(since)), settle(standupJira(since))]);
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
    sinceLabel: `${since.toLocaleDateString([], { weekday: 'long' })} ${since.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
    nextStandup: next.toISOString(),
    yesterday: { github, jira },
    today,
    blockers,
  };
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
  const out = [`# Clearsky (${new Date(d.generatedAt).toLocaleString()})`, ''];
  const section = (title, items, line, error) => {
    out.push(`## ${title}${items ? ` (${items.length})` : ''}`);
    if (error) out.push(`_Unavailable: ${error}_`);
    else if (!items.length) out.push('_Nothing here._');
    else for (const i of items) out.push(`- ${line(i)}`);
    out.push('');
  };
  const g = d.github, j = d.jira, p = d.plan;
  const hm = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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

let cache = { at: 0, data: null, pending: null };
let standupCache = { at: 0, data: null };

async function cached(force) {
  if (!force && cache.data && Date.now() - cache.at < config.cacheSeconds * 1000) return cache.data;
  cache.pending ||= collect().then((data) => {
    cache = { at: Date.now(), data, pending: null };
    return data;
  }).catch((e) => { cache.pending = null; throw e; });
  return cache.pending;
}

async function readJson(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 64 * 1024) throw new Error('request too large');
  }
  return body ? JSON.parse(body) : {};
}

function applySettings(values) {
  for (const [k, v] of Object.entries(values)) {
    if (v) process.env[k] = v;
    else delete process.env[k];
  }
  Object.assign(config, buildConfig());
  cache = { at: 0, data: null, pending: null };
}

function serve() {
  const page = readFileSync(join(here, '..', 'web', 'index.html'));
  // Every state-changing request must carry this per-run token and come from this origin,
  // so other websites open in the browser can't change settings or start logins.
  const csrf = randomBytes(18).toString('hex');
  const settingsPage = readFileSync(join(here, '..', 'web', 'settings.html'), 'utf8').replace('__CSRF__', csrf);
  const origins = new Set([`http://127.0.0.1:${config.port}`, `http://localhost:${config.port}`]);
  const json = (res, code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (req.method === 'POST') {
        if (req.headers['x-clearsky-token'] !== csrf || (req.headers.origin && !origins.has(req.headers.origin))) {
          return json(res, 403, { error: 'forbidden' });
        }
        if (url.pathname === '/api/settings') {
          const values = settings.validate(await readJson(req));
          settings.writeEnvFile(userEnvFile, values);
          applySettings(values);
          return json(res, 200, await settings.status(config, { path: userEnvFile }));
        }
        if (url.pathname === '/api/login/github') return json(res, 200, await settings.githubLogin());
        if (url.pathname === '/api/login/jira') return json(res, 200, await settings.jiraLogin(config.jira.acli));
        return json(res, 404, { error: 'not found' });
      }
      if (url.pathname === '/api/settings') return json(res, 200, await settings.status(config, { path: userEnvFile }));
      if (url.pathname === '/settings') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(settingsPage);
      }
      if (url.pathname === '/api/standup') {
        const force = url.searchParams.has('refresh');
        if (force || !standupCache.data || Date.now() - standupCache.at > config.cacheSeconds * 1000) {
          standupCache = { at: Date.now(), data: await standup(await cached(force)) };
        }
        return json(res, 200, standupCache.data);
      }
      if (url.pathname === '/api/work') {
        const data = await cached(url.searchParams.has('refresh'));
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
  }).listen(config.port, '127.0.0.1', () => {
    console.log(`clearsky: http://127.0.0.1:${config.port}  (settings and logins: http://127.0.0.1:${config.port}/settings)`);
  });
}

// ---------------------------------------------------------------- main

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const args = process.argv.slice(2);
  if (args.includes('-h') || args.includes('--help')) {
    console.log('usage: clearsky [--json] | clearsky standup [--json] | clearsky serve [--port N] | clearsky jira-debug');
  } else if (args[0] === 'standup') {
    const s = await standup();
    console.log(args.includes('--json') ? JSON.stringify(s, null, 2) : s.text);
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
