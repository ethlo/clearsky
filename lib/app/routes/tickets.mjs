// Routes for tickets and pull requests: previews, reviewers and merges, starred projects and
// versions, builds and branches.
import * as localState from '../../state.mjs';
import { branchesFor } from '../../branches.mjs';
import { buildRepos } from '../../builds.mjs';
import { sortVersions } from '../../modules/jira.mjs';
import { PROJECT_KEY, starredProjects, versionSummary } from '../../modules/jira.mjs';
import { stateFile, config, tracker, saveSettings } from '../config.mjs';
import { ghModule, reviewerOptions, requestReviews, mergePr, jiraModule, REPO_NAME, starredRepos, issuePreview, prPreview } from '../services.mjs';
import { sourceCache, source } from '../work.mjs';
import { codeDirs } from '../chat-env.mjs';
import { readJson, json, NEXT } from '../http.mjs';

let jiraProjectsCache = { at: 0, data: null }; // every Jira project you can see, for starring (Versions page)
let ghReposCache = { at: 0, data: null }; // the same with GitHub Issues: repos you can star
let buildsCache = { at: 0, data: null };

// Changes: POST only, and the server has checked the page's token before it asks here.
export async function post({ req, res, url }) {
  // Ask people to review one of your PRs, as you (through your GitHub login).
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
  return NEXT;
}

// Reads.
export async function get({ res, url }) {
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
  return NEXT;
}
