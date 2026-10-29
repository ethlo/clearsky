#!/usr/bin/env node
// clearsky: one view of what needs your attention on GitHub, Jira and Slack.
// Zero dependencies, Node 22+. See README.md.
//
//   clearsky              print a Markdown summary
//   clearsky --json       print the raw data as JSON (for Copilot skills / scripts)
//   clearsky serve        serve the dashboard on http://127.0.0.1:7777

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync, statSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { eventsBetween } from '../lib/ics.mjs';
import { edsCalendars, pickCalendars, ownCalendars, edsCalendarText } from '../lib/eds.mjs';
import { randomBytes } from 'node:crypto';
import * as settings from '../lib/settings.mjs';
import * as localState from '../lib/state.mjs';
import * as copilot from '../lib/copilot.mjs';
import { AcpAgent, chatEvent } from '../lib/acp.mjs';
import { attentionItems, diffAttention, desktopNotify } from '../lib/notify.mjs';
import { loadSources, makeContext, hook, asList } from '../lib/sources.mjs';

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

// ---------------------------------------------------------------- GitHub

const PR_FIELDS = `
  number title url isDraft createdAt updatedAt reviewDecision mergeable headRefName
  additions deletions changedFiles
  repository { nameWithOwner }
  author { login }
  reviews(last: 30) { nodes { state submittedAt author { login } } }
  reviewRequests(first: 20) { nodes { requestedReviewer { __typename ... on User { login } ... on Team { slug } } } }
  reviewThreads(first: 100) { nodes { isResolved } }
  commits(last: 1) { nodes { commit { committedDate statusCheckRollup { state } } } }
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
  // Review comments count only when they came after your latest commit; once you've pushed, the ball is theirs.
  const lastCommit = Date.parse(pr.commits?.nodes?.at(-1)?.commit?.committedDate || 0) || 0;
  if (reviews.some((r) => r.state === 'COMMENTED' && Date.parse(r.submittedAt) > lastCommit)) return { label: 'Has feedback', owner: 'me', tone: 'warn' };
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
    stamp: n.updatedAt, // a dismissed item comes back when this changes
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
      branch: pr.headRefName || null,
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
      branch: pr.headRefName || null,
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

function excerpt(text, myId, max = 220) {
  const plain = (text || '')
    .replaceAll(`[~accountid:${myId}]`, '@you').replaceAll(`[~${myId}]`, '@you')
    .replace(/\[~[^\]]+\]/g, '@someone')
    .replace(/\{(code|noformat|quote|panel)[^}]*\}/g, '')
    .replace(/\[([^|\]]+)\|[^\]]+\]/g, '$1')
    .replace(/[*_]{1,2}([^*_]+)[*_]{1,2}/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > max ? `${plain.slice(0, max - 3)}...` : plain;
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

// The site to link to. acli's `self` URLs point at an internal API host (*.atl-paas.net),
// so ask `acli jira auth status`, which names the real site (xyz.atlassian.net).
let jiraBase = null;
let jiraSitePending = null;
function jiraSite() {
  if (config.jira.url) return Promise.resolve(config.jira.url);
  jiraSitePending ||= execFileP(config.jira.acli, ['jira', 'auth', 'status'], { timeout: 15_000 })
    .then(({ stdout, stderr }) => `${stdout}\n${stderr}`, (e) => `${e.stdout || ''}\n${e.stderr || ''}`)
    .then((out) => {
      const site = out.match(/[\w-]+\.atlassian\.net/)?.[0];
      if (site) jiraBase = `https://${site}`;
      else jiraSitePending = null; // try again next time
      return jiraBase;
    });
  return jiraSitePending;
}

function browseUrl(issue) {
  const self = issue.self ? new URL(issue.self).origin : null;
  const base = config.jira.url || jiraBase || (self && /\.atlassian\.net$/.test(self) ? self : '');
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

async function fetchJiraWork() {
  await jiraSite();
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
      // acli often refuses `updated`, so fall back to the status.
      stamp: f.updated || nameOf(f.status) || '',
    };
  });
  return { assigned };
}

// The slow part: one acli call per candidate issue, so it's loaded separately.
async function fetchJiraMentions() {
  await jiraSite();
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
        stamp: c.id || c.created,
        excerpt: excerpt(text, me.id),
      });
    }
    return found;
  });
  const mentions = perIssue.flat().sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

  return { user: me.name, mentions, tickets: jiraMentionsByTicket(mentions) };
}

async function fetchJira() {
  const [work, mentions] = await Promise.all([settle(fetchJiraWork()), settle(fetchJiraMentions())]);
  return mergeJira(work, mentions);
}

// One entry per ticket, from its newest mention. Its stamp is that comment's id, so a dismissed
// ticket comes back only when someone mentions you there again.
export function jiraMentionsByTicket(mentions = []) {
  const byKey = new Map();
  for (const m of [...mentions].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))) {
    const t = byKey.get(m.key);
    if (t) { t.count++; if (!t.people.includes(m.by)) t.people.push(m.by); continue; }
    byKey.set(m.key, { ...m, count: 1, people: [m.by], dismissKey: `jira-mention:${m.key}` });
  }
  return [...byKey.values()];
}

function mergeJira(work, mentions) {
  const error = work.error || mentions.error;
  return { ...mentions, ...work, error: error || undefined, mentionsError: mentions.error };
}

// Hover-card details for one issue.
const issueCache = new Map();
export async function issuePreview(key) {
  const hit = issueCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 6e4) return hit.data;
  await jiraSite();
  const out = await acli(['workitem', 'view', key, '--fields', 'summary,status,assignee,reporter,priority,issuetype,description', '--json']);
  const f = out?.fields || out || {};
  const text = f.description ? commentInfo(f.description).text : '';
  const data = {
    key,
    url: browseUrl({ key, self: out?.self }),
    summary: f.summary || '',
    status: nameOf(f.status),
    statusCategory: f.status?.statusCategory?.key || null,
    type: nameOf(f.issuetype),
    priority: nameOf(f.priority),
    assignee: f.assignee?.displayName || null,
    reporter: f.reporter?.displayName || null,
    description: excerpt(text, null, 600),
  };
  issueCache.set(key, { at: Date.now(), data });
  return data;
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
      stamp: m.ts,
      excerpt: slackText(m.text, me),
    }));
  return { user: auth.user, team: auth.team, mentions };
}

// ---------------------------------------------------------------- Calendar

async function icsText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`calendar feed returned ${res.status} ${res.statusText}`);
  const text = await res.text();
  if (!text.includes('BEGIN:VCALENDAR')) {
    throw new Error('the calendar link returned a web page, not an iCal feed; in Settings, paste the "Secret address in iCal format" (ends in basic.ics)');
  }
  return text;
}

// Calendars synced by GNOME Online Accounts / Evolution, matched by CALENDAR_EMAIL
// or named in EVOLUTION_CALENDARS.
async function evolutionTexts() {
  const { email, evolution } = config.calendar;
  const all = edsCalendars();
  const picked = pickCalendars(all, { wanted: evolution, email });
  if (!picked.length) return null;
  const synced = picked.filter((c) => c.cacheDb);
  if (!synced.length) throw new Error(`Evolution has ${picked.map((c) => c.name).join(', ')} but hasn't synced it yet; open GNOME Calendar once`);
  // Your own calendars block your time. A shared one (say the family calendar) only blocks
  // for events you put there or were invited to; the rest just show.
  const own = new Set(ownCalendars(all, email).map((c) => c.uid));
  return Promise.all(synced.map(async (c) => ({
    text: await edsCalendarText(c.cacheDb), name: c.name,
    shared: !own.has(c.uid) && c.name.toLowerCase() !== c.account.toLowerCase(),
  })));
}

// Reads the iCal link and GNOME Online Accounts side by side and merges them, so one
// broken source doesn't hide the other. It only fails when every configured source fails.
async function fetchCalendar() {
  const { icsUrl, email } = config.calendar;
  const tries = [];
  const urls = (icsUrl || '').split(/\s+/).filter(Boolean);
  urls.forEach((url, i) => tries.push([urls.length > 1 ? `iCal link ${i + 1}` : 'iCal link', icsText(url).then((text) => [{ text }])]));
  tries.push(['GNOME Online Accounts', evolutionTexts()]);
  const results = await Promise.all(tries.map(([name, p]) => p.then((texts) => ({ name, texts }), (e) => ({ name, error: e.message }))));
  const used = results.filter((r) => r.texts);
  const errors = Object.fromEntries(results.filter((r) => r.error).map((r) => [r.name, r.error]));
  if (!used.length) {
    const msgs = Object.entries(errors);
    if (!msgs.length) return { disabled: true };
    return { error: msgs.map(([n, m]) => (msgs.length > 1 ? `${n}: ${m}` : m)).join('; '), errors };
  }
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const seen = new Set();
  // All your addresses: the work one and the accounts of the calendars you picked.
  const me = [email, ...pickCalendars(edsCalendars(), { wanted: config.calendar.evolution, email }).map((c) => c.account),
    ...(process.env.CALENDAR_MY_EMAILS || '').split(/[\s,]+/)].filter((m) => /@/.test(m || ''));
  // Your name in a shared event's title also makes it yours (say "Dentist (Morten)").
  const names = (process.env.CALENDAR_MY_NAMES || '').split(',').map((n) => n.trim().toLowerCase()).filter(Boolean);
  const events = used.flatMap((r) => r.texts).flatMap((c) => eventsBetween(c.text, today.getTime(), today.getTime() + 2 * 864e5, me)
    .map((e) => ({ ...e, calendar: c.shared ? c.name : undefined,
      fyi: !!c.shared && !e.withMe && !names.some((n) => e.title.toLowerCase().includes(n)) })))
    // The same event on your own calendar and a shared one: keep your copy, which blocks time.
    .sort((a, b) => a.fyi - b.fyi)
    .filter((e) => !e.declined && !seen.has(`${e.uid}@${e.start}`) && !seen.has(`${e.title}@${e.start}`)
      && seen.add(`${e.uid}@${e.start}`) && seen.add(`${e.title}@${e.start}`))
    .map(({ declined, withMe, organizer, ...e }) => e)
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const sources = used.map((r) => r.name);
  return { source: sources.join(' + '), sources, ...(Object.keys(errors).length && { errors }), events };
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
export function planNow(d, now = Date.now(), dismissedItems = localState.dismissed(stateFile), mutedItems = localState.muted(stateFile, now),
  doneAt = localState.doneAt(stateFile)) {
  const g = d.github || {}, j = d.jira || {}, s = d.slack || {}, cal = d.calendar || {};
  const shown = (cal.events || []).filter((e) => !e.allDay && !e.transparent)
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
    ...(j.assigned || []).filter((i) => i.statusCategory === 'indeterminate')
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
    suggestions,
  };
}

// ---------------------------------------------------------------- collect

const settle = (p) => p.catch((e) => ({ error: e.message, ...(e.auth && { needsLogin: true }) }));

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
  const cal = more.length && !calendar.error ? { ...calendar, events: [...(calendar.events || []), ...more] } : calendar;
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
    calendar,
    sources: extra,
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
  if (t.meetings.length) line(`Meetings: ${t.meetings.map((e) => `${new Date(e.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} ${e.title}`).join(', ')}`);
  if (out.length === before) line('Pick up the next item from the queue.');
  out.push('', '*Blockers*');
  if (s.blockers.length) s.blockers.forEach((b) => line(b.text));
  else line('None');
  return out.join('\n');
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
    sinceLabel: `${since.toLocaleDateString([], { weekday: 'long' })} ${since.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
    nextStandup: next.toISOString(),
    jiraBase: config.jira.url || jiraBase,
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
  standupCache = { at: 0, data: null };
}

// ---------------------------------------------------------------- Copilot chat

const copilotCwd = () => process.env.COPILOT_CWD || join(here, '..');
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
  };
  copilotInfoCache = { at: Date.now(), data };
  return data;
}

// Copilot signs in on its own; don't hand it Clearsky's tokens.
function copilotEnv() {
  const env = { ...process.env };
  for (const k of ['GITHUB_TOKEN', 'GH_TOKEN', 'SLACK_TOKEN', 'GOOGLE_CALENDAR_ICS', 'CALENDAR_ICS_URL']) delete env[k];
  return env;
}

const copilotHome = () => process.env.CLEARSKY_COPILOT_HOME || join(homedir(), '.copilot');

// Slash commands Copilot last offered (its built-ins and your skills).
let copilotCommands = null;

// Ask-mode chats keep a Copilot process running between turns, keyed by Copilot's session id.
const acpChats = new Map();
setInterval(() => {
  for (const [id, c] of acpChats) if (Date.now() - c.lastUsed > 20 * 6e4) { c.agent.close(); acpChats.delete(id); }
}, 60_000).unref();

// A short-lived Copilot process, for listing or reading sessions.
async function withAgent(bin, fn) {
  const agent = new AcpAgent(bin, [], { env: copilotEnv() });
  const timer = setTimeout(() => agent.close(), 30_000);
  try { return await fn(agent); } finally { clearTimeout(timer); agent.close(); }
}

// Sessions open in a running Copilot (terminal, editor): the process keeps an
// inuse.<pid>.hold file in the session's folder while it has the session open.
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
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
    const pids = files.map((f) => Number(f.match(/^inuse\.(\d+)\.hold$/)?.[1])).filter((n) => n && alive(n));
    if (pids.length) open[id] = { working: !!state[id]?.working && Date.now() - (Date.parse(state[id]?.refreshedAt) || 0) < 15 * 6e4 };
  }
  return open;
}

const CONTEXT_INTRO = 'You are helping me with my work. This is my work dashboard right now:';
// What you typed, without the dashboard and references Clearsky added in front.
const MSG_MARK = '\n\n---\nMy message:\n';
export function typedPart(text) {
  const at = text.lastIndexOf(MSG_MARK);
  if (at >= 0 && (text.startsWith(CONTEXT_INTRO) || text.startsWith(REFS_INTRO))) return text.slice(at + MSG_MARK.length);
  if (text.startsWith(CONTEXT_INTRO)) return text.slice(text.lastIndexOf('\n\n---\n\n') + 7); // chats from before the marker
  return text;
}

let sessionsCache = null;
async function copilotSessions(bin, force) {
  if (!force && sessionsCache && Date.now() - sessionsCache.at < 30_000) return withStatus(sessionsCache.data);
  const list = await withAgent(bin, (a) => a.listSessions());
  const data = list.map((x) => ({ id: x.sessionId, title: x.title || null, cwd: x.cwd || null, updatedAt: x.updatedAt || null }))
    .sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));
  sessionsCache = { at: Date.now(), data };
  return withStatus(data);
}

// Chats in this panel that are running a one-shot turn right now.
const oneShotRunning = new Set();

// Where each session is at, worked out fresh each time:
//   working: Copilot is busy on it (here, or in a terminal or editor);
//   needs-you: it asked to use a tool and waits for your answer (Ask mode here);
//   waiting: open in a terminal or here, done with its turn, waiting for your next message;
//   closed: not open anywhere.
function withStatus(list) {
  const open = openCopilotSessions();
  return list.map((x) => {
    const c = acpChats.get(x.id);
    const status = c?.waiting.size ? 'needs-you' : c?.busy || oneShotRunning.has(x.id) || open[x.id]?.working ? 'working'
      : c || open[x.id] ? 'waiting' : 'closed';
    return { ...x, open: !!open[x.id] && !c, working: status === 'working', here: !!c, status };
  });
}

// Which Copilot sessions belong to which PR or ticket ("pr:org/repo#12", "issue:SSP-1"): the
// items you attached in Clearsky, the branch a terminal session worked on (matched to its
// PR, and the ticket key in its name), and ticket keys in the session's title.
export function linkSessions(sessions, { prs = [], refs = {}, workspace = () => ({}) } = {}) {
  const byBranch = new Map(prs.filter((p) => p.branch).map((p) => [`${p.repo.toLowerCase()}@${p.branch}`, `pr:${p.repo}#${p.number}`]));
  const links = {};
  for (const x of sessions) {
    const keys = new Set(refs[x.id] || []);
    const ws = workspace(x.id);
    if (ws.repository && ws.branch) {
      const pr = byBranch.get(`${ws.repository.toLowerCase()}@${ws.branch}`);
      if (pr) keys.add(pr);
    }
    for (const m of `${ws.branch || ''} ${x.title || ''}`.toUpperCase().matchAll(/\b([A-Z][A-Z0-9_]+-\d+)\b/g)) keys.add(`issue:${m[1]}`);
    for (const k of keys) (links[k] ||= []).push({ id: x.id, title: x.title || 'Untitled session', updatedAt: x.updatedAt, cwd: x.cwd, status: x.status || 'closed' });
  }
  for (const k of Object.keys(links)) links[k] = links[k].sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0)).slice(0, 3);
  return links;
}

async function copilotLinks(bin) {
  const sessions = await copilotSessions(bin);
  const recent = sessions.filter((x) => x.status !== 'closed' || Date.now() - (Date.parse(x.updatedAt) || 0) < 60 * 864e5);
  const gh = sourceCache.get('github')?.data || {};
  const links = linkSessions(recent, { prs: [...(gh.myPrs || []), ...(gh.reviewRequested || [])], refs: localState.sessionRefs(stateFile), workspace: workspaceInfo });
  // Every session that is busy or waiting on you, linked to an item or not.
  const live = sessions.filter((x) => x.status !== 'closed').map(({ id, title, updatedAt, cwd, status }) => ({ id, title: title || 'Untitled session', updatedAt, cwd, status }));
  return { links, live };
}

const refKey = (r) => (r.kind === 'pr' ? `pr:${r.repo}#${r.number}` : `issue:${r.key}`);

async function copilotHistory(bin, id, cwd) {
  const messages = await withAgent(bin, (a) => a.history(id, cwd));
  for (const m of messages) if (m.role === 'me') m.text = typedPart(m.text);
  return messages;
}

// The local clone of a GitHub repository, so Copilot can work in it: a folder under
// CLEARSKY_CODE_DIRS (default ~/dev), up to three levels down, whose origin is that repo.
export function findCheckout(repo, roots = (process.env.CLEARSKY_CODE_DIRS || join(homedir(), 'dev')).split(':').filter(Boolean)) {
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
      : r?.kind === 'pr' && /^[\w.-]+\/[\w.-]+$/.test(r.repo) && /^\d+$/.test(String(r.number)) ? { kind: 'pr', repo: r.repo, number: Number(r.number) }
        : null)).filter(Boolean);
}

function toolDetail(call = {}) {
  const input = call.rawInput;
  if (!input || typeof input !== 'object') return '';
  const text = input.command || input.path || input.url || JSON.stringify(input);
  return String(text).slice(0, 400);
}

async function acpTurn({ chat, options, prompt, resumeId, cwd, emit, res, bin }) {
  const sig = JSON.stringify(copilot.optionArgs(options));
  let c = acpChats.get(chat);
  if (c && (c.sig !== sig || c.agent.closed)) { resumeId = c.agent.sessionId; c.agent.close(); acpChats.delete(chat); c = null; }
  if (!c) {
    const agent = new AcpAgent(bin, copilot.optionArgs(options), { env: copilotEnv() });
    c = { agent, sig, waiting: new Map(), lastUsed: Date.now() };
    const id = await agent.start(cwd, resumeId);
    acpChats.set(id, c);
    // A new chat gets Copilot's own session id; the panel keeps using that from now on.
    if (id !== chat) emit({ type: 'session', id });
  }
  c.lastUsed = Date.now();
  const { agent } = c;
  if (agent.commands) { copilotCommands = agent.commands; emit({ type: 'commands', commands: agent.commands }); }
  agent.onUpdate = (u) => {
    if (u.sessionUpdate === 'available_commands_update') { copilotCommands = agent.commands; emit({ type: 'commands', commands: agent.commands }); return; }
    const e = chatEvent(u); if (e && (e.type !== 'text' || e.text)) emit(e);
  };
  agent.onPermission = (p) => new Promise((resolve) => {
    const id = randomBytes(6).toString('hex');
    c.waiting.set(id, resolve);
    emit({ type: 'permission', id, title: p.toolCall?.title || 'Copilot wants to use a tool', kind: p.toolCall?.kind,
      detail: toolDetail(p.toolCall), options: (p.options || []).map((o) => ({ id: o.optionId, name: o.name, kind: o.kind })) });
  });
  res.on('close', () => {
    if (res.writableEnded) return;
    agent.cancel();
    for (const r of c.waiting.values()) r({ outcome: 'cancelled' });
    c.waiting.clear();
  });
  c.busy = true;
  const r = await agent.prompt(prompt).finally(() => { c.busy = false; });
  emit({ type: 'done', stopReason: r?.stopReason });
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
function hasNotifySend() {
  if (process.env.CLEARSKY_NOTIFY === 'off') return Promise.resolve('off');
  if (process.env.CLEARSKY_NOTIFY === 'browser') return Promise.resolve('browser');
  return execFileP(process.env.NOTIFY_SEND_BIN || 'notify-send', ['--version'], { timeout: 5000 }).then(() => 'desktop', () => 'browser');
}

// Banners only during working hours on workdays (07:00 until two hours after the workday ends).
function notifyNow(now = new Date()) {
  const end = atLocalTime(now, config.workdayEnd);
  return isWorkday(now) && now.getHours() >= 7 && +now < +end + 2 * 36e5;
}

export async function pollAttention(force = true) {
  const data = Object.fromEntries(await Promise.all(ATTENTION_SOURCES.map(async (n) => [n, await source(n, force)])));
  const items = [...attentionItems(data), ...await pluginAttention(force)];
  const before = localState.seen(stateFile);
  const { seen, fresh } = diffAttention(items, before, {
    dismissed: localState.dismissed(stateFile), muted: localState.muted(stateFile), first: !Object.keys(before).length,
  });
  if (fresh.length || Object.keys(seen).length !== Object.keys(before).length) localState.setSeen(stateFile, seen);
  poller.lastPoll = new Date().toISOString();
  if (fresh.length && poller.notifier === 'desktop' && notifyNow()) {
    const bin = process.env.NOTIFY_SEND_BIN || 'notify-send';
    if (fresh.length > 4) desktopNotify({ title: `${fresh.length} new things need you`, body: fresh.slice(0, 4).map((x) => x.title).join('\n'), url: `http://127.0.0.1:${config.port}/` }, { bin });
    else for (const it of fresh) desktopNotify(it, { bin });
  }
  return { items, seen, fresh };
}

async function pluginAttention(force) {
  const extra = await pluginData(force);
  return [...plugins.sources.values()].flatMap((p) => (extra[p.name]?.error || extra[p.name]?.disabled ? []
    : asList(hook(p, 'attention', extra[p.name])).filter((x) => x?.key && x.title).map((x) => ({ kind: p.name, ...x, key: `${p.name}:${x.key}` }))));
}

function startPolling() {
  const every = Math.max(1, Number(process.env.CLEARSKY_POLL_MINUTES) || 3) * 6e4;
  hasNotifySend().then((n) => { poller.notifier = n; });
  const tick = () => pollAttention(true).catch((e) => console.error(`clearsky: poll failed: ${e.message}`));
  setTimeout(tick, 2000).unref?.();
  poller.timer = setInterval(tick, every);
  poller.timer.unref?.();
}

function serve() {
  // Every state-changing request must carry this token and come from this origin, so other
  // websites open in the browser can't change settings or start logins. It's kept across
  // restarts so an open page keeps working.
  const csrf = localToken(join(dirname(userEnvFile), 'csrf'));
  const page = readFileSync(join(here, '..', 'web', 'index.html'), 'utf8').replace('__CSRF__', csrf);
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
          const prRef = !body.resume && !body.cwd && refs.find((r) => r.kind === 'pr');
          const checkout = prRef ? findCheckout(prRef.repo) : null;
          const cwd = checkout || (body.cwd && isDir(body.cwd) ? body.cwd : copilotCwd());
          let refText = '';
          if (refs.length) {
            const parts = await Promise.all(refs.map((r) => referenceText(r).catch((e) => `## ${r.key || `${r.repo}#${r.number}`}\n(couldn't load: ${e.message})`)));
            refText = `${REFS_INTRO}\n\n${parts.join('\n\n')}`;
          }
          const list = (v) => (Array.isArray(v) ? v : String(v || '').split(',')).map((x) => String(x).trim()).filter(Boolean);
          const options = { model: body.model, effort: body.effort, permission: copilot.PERMISSIONS[body.permission] ? body.permission : 'ask',
            allow: list(body.allow), deny: list(body.deny) };
          // The first turn carries the dashboard so Copilot knows what you're looking at.
          const prefix = [!body.resume && `${CONTEXT_INTRO}\n\n${copilotContext()}`, refText].filter(Boolean).join('\n\n---\n\n');
          const prompt = prefix ? `${prefix}${MSG_MARK}${message}` : message;
          // Answers stream back as one JSON event per line: text, tool, permission, done, error.
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
          let sessionId = body.session;
          const emit = (e) => {
            if (e.type === 'session') sessionId = e.id;
            if (!res.writableEnded) res.write(`${JSON.stringify(e)}\n`);
          };
          // Remember which PRs and tickets this session is about, for the links on the page.
          const linkRefs = () => { if (refs.length) localState.addSessionRefs(stateFile, sessionId, refs.map(refKey)); };
          res.on('close', linkRefs);
          if (checkout) emit({ type: 'cwd', cwd: checkout });
          sessionsCache = null;
          const live = acpChats.get(body.session);
          if (copilot.PERMISSIONS[options.permission].acp) {
            try {
              await acpTurn({ chat: body.session, options, prompt, resumeId: body.resume ? body.session : null, cwd, emit, res, bin: info.bin });
            } catch (e) { emit({ type: 'error', message: e.message }); }
            return res.end();
          }
          if (live) { live.agent.close(); acpChats.delete(body.session); }
          const args = copilot.copilotArgs({ prompt, session: body.session, resume: !!body.resume, cwd, ...options });
          oneShotRunning.add(body.session);
          res.on('close', () => oneShotRunning.delete(body.session));
          const stop = copilot.runCopilot(info.bin, args, {
            env: copilotEnv(),
            onData: (text) => emit({ type: 'text', text }),
            onEnd: ({ code, stderr }) => {
              if (code !== 0) emit({ type: 'error', message: `Copilot exited with ${code}${stderr ? `: ${stderr.trim().split('\n').slice(-3).join(' ')}` : ''}` });
              else emit({ type: 'done' });
              res.end();
            },
          });
          res.on('close', () => { if (!res.writableEnded) stop(); });
          return;
        }
        if (url.pathname === '/api/mute') {
          const { key, for: span } = await readJson(req);
          return json(res, 200, { muted: localState.setMuted(stateFile, { key, until: muteUntil(span) }) });
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
      if (url.pathname === '/api/standup') {
        const force = url.searchParams.has('refresh');
        if (force || !standupCache.data || Date.now() - standupCache.at > config.cacheSeconds * 1000) {
          standupCache = { at: Date.now(), data: await standup(await collect(force)) };
        }
        return json(res, 200, standupCache.data);
      }
      const src = url.pathname.match(/^\/api\/source\/(\w+)$/)?.[1];
      if (src) {
        if (!SOURCES[src]) return json(res, 404, { error: 'unknown source' });
        const data = await source(src, url.searchParams.has('refresh'));
        return json(res, 200, { ...data, fetchedAt: new Date(sourceCache.get(src)?.at || Date.now()).toISOString() });
      }
      if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
      if (url.pathname === '/api/sources') {
        return json(res, 200, { sources: [...plugins.sources.values()].map((p) => ({ name: p.name, label: p.label, panel: p.panel || null })), errors: plugins.errors });
      }
      // What needs you, with when each first showed up, so the page can mark what's new.
      if (url.pathname === '/api/attention') {
        const data = Object.fromEntries(await Promise.all(ATTENTION_SOURCES.map(async (n) => [n, await source(n, false)])));
        const seen = localState.seen(stateFile);
        return json(res, 200, { lastPoll: poller.lastPoll, notifier: poller.notifier,
          items: [...attentionItems(data), ...await pluginAttention(false)].map((it) => ({ ...it, at: seen[it.key]?.stamp === String(it.stamp ?? '') ? seen[it.key].at : null })) });
      }
      if (url.pathname === '/api/copilot') return json(res, 200, { ...await copilotInfo(url.searchParams.has('refresh')), commands: copilotCommands });
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
        return json(res, 200, { id: histId, cwd, here: acpChats.has(histId), messages: await copilotHistory(info.bin, histId, cwd) });
      }
      if (url.pathname === '/api/dismissed') return json(res, 200, { dismissed: localState.dismissed(stateFile) });
      if (url.pathname === '/api/plan') {
        // Waits for every source (from cache when fresh); the page asks for it alongside them.
        const { plan, nextStandup: next, summary, generatedAt } = await collect(false);
        return json(res, 200, { plan, nextStandup: next, summary, generatedAt });
      }
      const issueKey = url.pathname.match(/^\/api\/issue\/([A-Z][A-Z0-9_]+-\d+)$/)?.[1];
      if (issueKey) return json(res, 200, await issuePreview(issueKey));
      if (url.pathname === '/api/pr') {
        const repo = url.searchParams.get('repo') || '', number = url.searchParams.get('number') || '';
        if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !/^\d+$/.test(number)) return json(res, 400, { error: 'bad PR reference' });
        return json(res, 200, await prPreview(repo, number));
      }
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
  }).listen(config.port, '127.0.0.1', () => {
    console.log(`clearsky: http://127.0.0.1:${config.port}  (settings and logins: http://127.0.0.1:${config.port}/settings)`);
    if (process.env.CLEARSKY_POLL_MINUTES !== '0') startPolling();
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
