#!/usr/bin/env node
// clearsky: one view of what needs your attention on GitHub, Jira and Slack.
// Zero dependencies, Node 22+. See README.md.
//
//   clearsky              print a Markdown summary
//   clearsky --json       print the raw data as JSON (for Copilot skills / scripts)
//   clearsky serve        serve the dashboard on http://127.0.0.1:7777

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync, statSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { eventsBetween } from '../lib/ics.mjs';
import { edsCalendars, pickCalendars, ownCalendars, edsCalendarText } from '../lib/eds.mjs';
import { randomBytes } from 'node:crypto';
import * as settings from '../lib/settings.mjs';
import * as localState from '../lib/state.mjs';
import * as copilot from '../lib/copilot.mjs';
import { AcpAgent, chatEvent } from '../lib/acp.mjs';
import { sessionEvents } from '../lib/copilot-events.mjs';
import { branchesFor } from '../lib/branches.mjs';
import { attentionItems, diffAttention, desktopNotify, DbusNotifier } from '../lib/notify.mjs';
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
  number title url state isDraft createdAt updatedAt reviewDecision mergeable headRefName
  additions deletions changedFiles
  repository { nameWithOwner }
  author { login }
  reviews(last: 30) { nodes { state submittedAt author { __typename login } } }
  reviewRequests(first: 20) { nodes { requestedReviewer { __typename ... on User { login } ... on Team { slug } ... on Bot { login } } } }
  reviewThreads(first: 100) { nodes { isResolved isOutdated comments(last: 1) { nodes { author { __typename login } } } } }
  commits(last: 1) { nodes { commit { committedDate statusCheckRollup { state } } } }
  closingIssuesReferences(first: 5) { nodes { number repository { nameWithOwner } } }
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

// Review bots (like Copilot's PR reviewer, which comments on every push) aren't people
// waiting on you: their reviews and threads never make a PR your move.
export const isBot = (a) => !!a && (a.__typename === 'Bot' || /\[bot\]$|^copilot-pull-request-reviewer$|^Copilot$/i.test(a.login || ''));

function latestReviewsByUser(pr, me) {
  const byUser = new Map();
  for (const r of pr.reviews?.nodes || []) {
    const who = r.author?.login;
    if (!who || who === me || r.state === 'PENDING' || isBot(r.author)) continue;
    // A plain comment does not override an earlier approval / change request, but a later one replaces an earlier comment.
    if (r.state === 'COMMENTED' && byUser.has(who) && byUser.get(who).state !== 'COMMENTED') continue;
    byUser.set(who, r);
  }
  return [...byUser.values()];
}

// Open review threads by who has to answer: yours (a person spoke last and it isn't outdated),
// and suggestions from review bots you may want to look at.
export function openThreads(pr, me) {
  const open = (pr.reviewThreads?.nodes || []).filter((t) => !t.isResolved && !t.isOutdated);
  const last = (t) => t.comments?.nodes?.at(-1)?.author;
  return {
    mine: open.filter((t) => !isBot(last(t)) && last(t)?.login !== me).length,
    bot: open.filter((t) => isBot(last(t))).length,
  };
}
const humanReviewers = (pr) => (pr.reviewRequests?.nodes || []).filter((n) => n.requestedReviewer && !isBot(n.requestedReviewer));

// Who has the ball on one of my PRs, and why.
export function myPrStatus(pr, me) {
  const ci = ciState(pr);
  const reviews = latestReviewsByUser(pr, me);
  const approvals = reviews.filter((r) => r.state === 'APPROVED').length;
  const changes = reviews.filter((r) => r.state === 'CHANGES_REQUESTED').length;
  const unresolved = openThreads(pr, me).mine;
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
  // Nobody (but maybe a bot) has been asked to review: the one thing to do is ask someone.
  if (!humanReviewers(pr).length && !reviews.length) return { label: 'No reviewer yet', owner: 'me', tone: 'warn' };
  return { label: 'Waiting for review', owner: 'others', tone: 'wait' };
}

// Who could review a PR: people with write access to the repo, GitHub's suggestions first,
// marked with who is already asked and who has reviewed, so nobody is asked twice by accident.
async function reviewerOptions(repo, number) {
  config.github.token ||= await ghCliToken();
  const [owner, name] = repo.split('/');
  const d = await gql(`query($o: String!, $n: String!, $num: Int!) {
    viewer { login }
    repository(owner: $o, name: $n) {
      assignableUsers(first: 100) { nodes { login name } }
      pullRequest(number: $num) {
        author { login }
        suggestedReviewers { reviewer { login name } }
        reviewRequests(first: 30) { nodes { requestedReviewer { __typename ... on User { login } ... on Bot { login } } } }
        reviews(last: 50) { nodes { state submittedAt author { __typename login } } }
      }
    }
  }`, { o: owner, n: name, num: number });
  const pr = d.repository?.pullRequest;
  if (!pr) throw new Error(`${repo}#${number} not found`);
  const me = d.viewer.login, author = pr.author?.login;
  const requested = new Set((pr.reviewRequests?.nodes || []).map((n) => n.requestedReviewer?.login).filter(Boolean));
  const reviewed = new Map();
  for (const r of pr.reviews?.nodes || []) if (r.author?.login && r.state !== 'PENDING') reviewed.set(r.author.login, r.state);
  const suggested = new Set((pr.suggestedReviewers || []).map((s) => s.reviewer?.login));
  const people = new Map();
  for (const u of [...(pr.suggestedReviewers || []).map((s) => s.reviewer), ...(d.repository.assignableUsers?.nodes || [])]) {
    if (!u?.login || u.login === me || u.login === author || isBot(u) || people.has(u.login)) continue;
    people.set(u.login, { login: u.login, name: u.name || null, suggested: suggested.has(u.login), requested: requested.has(u.login), reviewed: reviewed.get(u.login) || null });
  }
  const rank = (p) => (p.requested ? 0 : p.reviewed ? 1 : p.suggested ? 2 : 3);
  return { repo, number, people: [...people.values()].sort((a, b) => rank(a) - rank(b) || a.login.localeCompare(b.login)) };
}

async function requestReviews(repo, number, logins) {
  config.github.token ||= await ghCliToken();
  const { api, token } = config.github;
  await http(`${api}/repos/${repo}/pulls/${number}/requested_reviewers`, { headers: { Authorization: `Bearer ${token}` }, body: { reviewers: logins } });
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

  // GitHub's search index lags a few minutes behind a merge, so check each PR's own state too.
  const open = (n) => n && n.number && (!n.state || n.state === 'OPEN');
  const keep = (n) => open(n) && !ignoreAuthors.includes(n.author?.login);
  const base = (n) => ({
    repo: n.repository.nameWithOwner,
    number: n.number,
    title: n.title,
    url: n.url,
    author: n.author?.login || 'ghost',
    updatedAt: n.updatedAt,
    stamp: n.updatedAt, // a dismissed item comes back when this changes
    // GitHub issues a PR closes ("Fixes #12"): the same piece of work.
    ...(n.closingIssuesReferences ? { issues: n.closingIssuesReferences.nodes.map((i) => `${i.repository.nameWithOwner}#${i.number}`) } : {}),
  });

  const reviewRequested = data.reviewRequested.nodes.filter(keep).map((pr) => {
    const requests = (pr.timelineItems?.nodes || []).filter((e) => reviewerName(e.requestedReviewer));
    const mine = requests.filter((e) => e.requestedReviewer?.login === me);
    const requestedAt = (mine.at(-1) || requests.at(-1))?.createdAt || pr.createdAt;
    const reviewedBefore = (pr.reviews?.nodes || []).some((r) => r.author?.login === me && r.state !== 'PENDING');
    return {
      ...base(pr),
      stamp: requestedAt, // Done hides it until you're asked again
      draft: pr.isDraft,
      requestedAt,
      viaTeam: mine.length === 0,
      rerequested: reviewedBefore,
      branch: pr.headRefName || null,
      ci: ciState(pr),
      size: { additions: pr.additions, deletions: pr.deletions, files: pr.changedFiles },
    };
  });

  const myPrs = data.myPrs.nodes.filter(open).map((pr) => {
    const reviews = latestReviewsByUser(pr, me);
    const status = myPrStatus(pr, me);
    // Done hides it until its state changes or a person reviews again, not when a bot comments or you push.
    const lastHuman = reviews.map((r) => r.submittedAt || '').sort().at(-1) || '';
    return {
      ...base(pr),
      stamp: `${status.label}|${lastHuman}|${openThreads(pr, me).mine}`,
      draft: pr.isDraft,
      status,
      branch: pr.headRefName || null,
      ci: ciState(pr),
      approvals: reviews.filter((r) => r.state === 'APPROVED').map((r) => r.author.login),
      changesRequested: reviews.filter((r) => r.state === 'CHANGES_REQUESTED').map((r) => r.author.login),
      commented: reviews.filter((r) => r.state === 'COMMENTED').map((r) => r.author.login),
      unresolvedThreads: openThreads(pr, me).mine,
      botSuggestions: openThreads(pr, me).bot,
      pendingReviewers: humanReviewers(pr).map((n) => reviewerName(n.requestedReviewer)).filter(Boolean),
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

// Statuses where a ticket waits on someone else (a reviewer, QA, another team), not on you.
const JIRA_WAITING = /review|\bqa\b|verif|test|blocked|waiting|on hold|pending/i;

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
      waiting: f.status?.statusCategory?.key === 'indeterminate' && JIRA_WAITING.test(nameOf(f.status) || ''),
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
    text: await edsCalendarText(c.cacheDb), name: c.name, work: own.has(c.uid),
    shared: !own.has(c.uid) && c.name.toLowerCase() !== c.account.toLowerCase(),
  })));
}

// Reads the iCal link and GNOME Online Accounts side by side and merges them, so one
// broken source doesn't hide the other. It only fails when every configured source fails.
async function fetchCalendar() {
  const { icsUrl, email } = config.calendar;
  const tries = [];
  const urls = (icsUrl || '').split(/\s+/).filter(Boolean);
  urls.forEach((url, i) => tries.push([urls.length > 1 ? `iCal link ${i + 1}` : 'iCal link', icsText(url).then((text) => [{ text, name: 'Google Calendar', work: true }])]));
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
    .map((e) => ({ ...e, calendar: c.name || 'Calendar', work: !!c.work, shared: !!c.shared,
      fyi: !!c.shared && !e.withMe && !names.some((n) => e.title.toLowerCase().includes(n)) })))
    // The same event on your own calendar and a shared one: keep your copy, which blocks time.
    .sort((a, b) => a.fyi - b.fyi)
    .filter((e) => !e.declined && !seen.has(`${e.uid}@${e.start}`) && !seen.has(`${e.title}@${e.start}`)
      && seen.add(`${e.uid}@${e.start}`) && seen.add(`${e.title}@${e.start}`))
    .map(({ declined, withMe, ...e }) => e)
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const sources = used.map((r) => r.name);
  return { source: sources.join(' + '), sources, ...(Object.keys(errors).length && { errors }), events };
}

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
  if (t.meetings.length) line(`Meetings: ${t.meetings.map((e) => `${clock(e.start)} ${e.title}`).join(', ')}`);
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
    sinceLabel: `${since.toLocaleDateString([], { weekday: 'long' })} ${clock(since)}`,
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
function withStatus(list) {
  const open = openCopilotSessions();
  return list.map((x) => {
    const c = acpChats.get(x.id);
    const status = c?.waiting.size ? 'needs-you' : c?.busy || open[x.id]?.working ? 'working'
      : c || open[x.id] ? 'waiting' : 'closed';
    return { ...x, open: !!open[x.id] && !c, working: status === 'working', here: !!c, status };
  });
}

// Which Copilot sessions belong to which PR or ticket ("pr:org/repo#12", "issue:SSP-1"): the
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

// The name a chat started on an item gets: "SSP-6519 · Fix capture timeout", or for a PR
// without a ticket key "ssp#1187 · Fix capture timeout". Continuing work then finds it again.
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
      status: c.waiting.size ? 'needs-you' : c.busy ? 'working' : 'waiting' });
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

async function acpTurn({ chat, options, prompt, resumeId, cwd, emit, res, bin }) {
  const sig = JSON.stringify(copilot.optionArgs(options));
  let c = acpChats.get(chat);
  if (c && (c.sig !== sig || c.agent.closed)) { resumeId = c.agent.sessionId; c.agent.close(); acpChats.delete(chat); c = null; }
  if (!c) {
    const agent = new AcpAgent(bin, copilot.optionArgs(options), { env: copilotEnv() });
    c = { agent, sig, cwd, waiting: new Map(), pending: new Map(), emit: () => {}, lastUsed: Date.now() };
    const id = await agent.start(cwd, resumeId);
    acpChats.set(id, c);
    // A new chat gets Copilot's own session id; the panel keeps using that from now on.
    if (id !== chat) emit({ type: 'session', id });
  }
  c.lastUsed = Date.now();
  const { agent } = c;
  // Events go to whichever page is watching this chat; none while you look at another one.
  c.emit = emit;
  if (agent.commands) { copilotCommands = agent.commands; emit({ type: 'commands', commands: agent.commands }); }
  agent.onUpdate = (u) => {
    if (u.sessionUpdate === 'available_commands_update') { copilotCommands = agent.commands; c.emit({ type: 'commands', commands: agent.commands }); return; }
    const e = chatEvent(u); if (e && (e.type !== 'text' || e.text)) c.emit(e);
  };
  const autoAllow = copilot.PERMISSIONS[options.permission]?.autoAllow || [];
  agent.onPermission = (p) => new Promise((resolve) => {
    const once = (p.options || []).find((o) => o.kind === 'allow_once');
    if (once && autoAllow.includes(p.toolCall?.kind)) return resolve({ outcome: 'selected', optionId: once.optionId });
    const id = randomBytes(6).toString('hex');
    const ev = { type: 'permission', id, title: p.toolCall?.title || 'Copilot wants to use a tool', kind: p.toolCall?.kind,
      detail: toolDetail(p.toolCall), options: (p.options || []).map((o) => ({ id: o.optionId, name: o.name, kind: o.kind })) };
    c.waiting.set(id, (answer) => { c.pending.delete(id); resolve(answer); });
    c.pending.set(id, ev);
    c.emit(ev);
  });
  // Switching chats or reloading the page leaves the turn running; Stop ends it.
  res.on('close', () => { if (c.emit === emit) c.emit = () => {}; });
  c.busy = true;
  const r = await agent.prompt(prompt).finally(() => { c.busy = false; });
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
const chatsBusy = () => [...acpChats.values()].filter((c) => c.busy || c.waiting.size).length;
function restartWhenIdle({ maxWaitMinutes = 60, force = false } = {}) {
  if (restart.pending) return restart.pending;
  restart.pending = { since: new Date().toISOString(), until: new Date(Date.now() + maxWaitMinutes * 6e4).toISOString(), busy: chatsBusy() };
  const check = () => {
    if (!force && chatsBusy()) {
      if (Date.now() > Date.parse(restart.pending.until)) { console.log('clearsky: restart given up, Copilot is still working'); clearInterval(restart.timer); restart.pending = null; }
      return;
    }
    clearInterval(restart.timer);
    console.log('clearsky: restarting');
    for (const c of acpChats.values()) c.agent.close();
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

  // Only answer to this machine's own names, so a web page can't reach the API through a
  // DNS name it controls that points here.
  const hosts = new Set([`127.0.0.1:${config.port}`, `localhost:${config.port}`]);

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
          return json(res, 200, { restart: restartWhenIdle({ maxWaitMinutes: Math.min(Math.max(Number(maxWaitMinutes) || 60, 1), 240), force: force === true }) });
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
        if (url.pathname === '/api/pr/request-review') {
          const { repo, number, logins } = await readJson(req);
          if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '') || !/^\d+$/.test(String(number)) || !Array.isArray(logins) || !logins.length || logins.length > 15
            || !logins.every((l) => /^[A-Za-z\d](?:[A-Za-z\d-]{0,38})$/.test(l))) return json(res, 400, { error: 'bad request' });
          if (!config.github.orgs.includes(repo.split('/')[0])) return json(res, 400, { error: 'not one of your work repos' });
          await requestReviews(repo, Number(number), logins);
          localState.logAction(stateFile, `https://github.com/${repo}/pull/${number}`, `Asked ${logins.join(', ')} to review`);
          sourceCache.delete('github');
          return json(res, 200, { ok: true });
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
          const clone = repoRef ? findCheckout(repoRef.repo) : null;
          const checkout = clone && (worktreeFor(clone, prBranch(repoRef)) || clone);
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
          if (checkout) emit({ type: 'cwd', cwd: checkout });
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
        return json(res, 200, { ...withReads(src, data), fetchedAt: new Date(sourceCache.get(src)?.at || Date.now()).toISOString() });
      }
      if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
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
      if (url.pathname === '/api/pr') {
        const repo = url.searchParams.get('repo') || '', number = url.searchParams.get('number') || '';
        if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !/^\d+$/.test(number)) return json(res, 400, { error: 'bad PR reference' });
        return json(res, 200, await prPreview(repo, number));
      }
      if (url.pathname === '/api/pr/reviewers') {
        const repo = url.searchParams.get('repo') || '', number = url.searchParams.get('number') || '';
        if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !/^\d+$/.test(number)) return json(res, 400, { error: 'bad PR reference' });
        return json(res, 200, await reviewerOptions(repo, Number(number)));
      }
      // Branches in your clones carrying the key of a ticket you have.
      if (url.pathname === '/api/branches') {
        const j = sourceCache.get('jira')?.data || {}, jm = sourceCache.get('jiraMentions')?.data || {};
        const keys = [...new Set([...(j.assigned || []), ...(jm.tickets || [])].map((t) => t.key).filter(Boolean))];
        return json(res, 200, { branches: await branchesFor(keys, codeDirs()) });
      }
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
    setTimeout(() => server.listen(config.port, '127.0.0.1'), 500);
  });
  server.once('listening', () => {
    console.log(`clearsky: http://127.0.0.1:${config.port}  (settings and logins: http://127.0.0.1:${config.port}/settings)`);
    if (process.env.CLEARSKY_POLL_MINUTES !== '0') startPolling();
  });
  server.listen(config.port, '127.0.0.1');
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

// ---------------------------------------------------------------- main

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const args = process.argv.slice(2);
  if (args.includes('-h') || args.includes('--help')) {
    console.log('usage: clearsky [--json] | clearsky standup [--json] | clearsky serve [--port N] | clearsky restart [--now] [--wait MIN] [--port N] | clearsky jira-debug');
  } else if (args[0] === 'standup') {
    const s = await standup();
    console.log(args.includes('--json') ? JSON.stringify(s, null, 2) : s.text);
  } else if (args[0] === 'restart') {
    const p = args.indexOf('--port');
    if (p > -1) config.port = Number(args[p + 1]);
    await restartCommand(args);
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
