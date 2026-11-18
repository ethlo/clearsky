// GitHub, Jira and the calendar (lib/modules), set up with your settings: what the rest of the
// app calls to read and change things there.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createCalendar } from '../modules/calendar.mjs';
import { createGitHub } from '../modules/github.mjs';
import { createJira } from '../modules/jira.mjs';
import { lendJiraSite } from '../plugins.mjs';
import { ghIssue } from '../tracker.mjs';
import { list, config } from './config.mjs';

const daysAgoIso = (d) => new Date(Date.now() - d * 864e5).toISOString().slice(0, 10);

export async function http(url, { headers = {}, body, method } = {}) {
  const res = await fetch(url, {
    method: method || (body ? 'POST' : 'GET'),
    headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    // An HTML error page (a gateway's 502) says nothing more than its status.
    const body = /^\s*</.test(text) ? '' : `: ${text.slice(0, 300)}`;
    const err = new Error(res.status >= 500 && !body ? `${new URL(url).host} didn't answer (${res.status} ${res.statusText}); trying again at the next refresh` : `${res.status} ${res.statusText} from ${new URL(url).host}${body}`);
    err.status = res.status;
    throw err;
  }
  return text ? JSON.parse(text) : null;
}

// ---------------------------------------------------------------- GitHub and Jira (lib/modules)

export const execFileP = promisify(execFile);
// A source that fails gives { error } instead of taking the others down.
export const settle = (p) => p.catch((e) => ({ error: e.message, ...(e.auth && { needsLogin: true }) }));

export const ghModule = createGitHub({ config, http, execFileP, daysAgoIso });
export const { gql, reviewerOptions, requestReviews, mergePr, ghCliToken } = ghModule;
export const fetchGitHub = ghModule.fetch;

export const jiraModule = createJira({ config, execFileP, settle });
lendJiraSite(() => jiraModule.jiraSite()); // for plugins that reach Jira without acli (lib/plugins.mjs)
export const REPO_NAME = /^[\w-][\w.-]*\/[\w-][\w.-]*$/;
export const starredRepos = () => [...new Set(list(process.env.GITHUB_STARRED_REPOS).filter((r) => REPO_NAME.test(r)))];
export const { acli, jiraSearch, jiraComments, jiraSite, browseUrl, jiraDebug } = jiraModule;
export const fetchJiraWork = jiraModule.fetchWork, fetchJiraMentions = jiraModule.fetchMentions;
export const issuePreview = (key) => jiraModule.issuePreview(key);

// ---------------------------------------------------------------- Calendar (lib/modules)

export const fetchCalendar = createCalendar({ config }).fetch;

// A ticket's goal for `review --ticket`: its title and whole description, nothing else. A Jira
// key, or a GitHub issue (owner/name#12).
export async function ticketGoal(ref) {
  const gi = ghIssue(ref);
  if (!gi) return jiraModule.ticketGoal(ref);
  config.github.token ||= await ghCliToken();
  const [owner, name] = gi.repo.split('/');
  const { repository } = await gql(`query($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) { issue(number: $number) { title body issueType { name } } } }`, { owner, name, number: gi.number })
    .catch(() => gql(`query($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) { issue(number: $number) { title body } } }`, { owner, name, number: gi.number }));
  const i = repository?.issue;
  if (!i) throw new Error(`${ref} not found`);
  return { key: ref, type: i.issueType?.name || 'Issue', summary: i.title || '', description: String(i.body || '').slice(0, 12_000) };
}

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
