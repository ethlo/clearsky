#!/usr/bin/env node
// clearsky: one view of what needs your attention on GitHub and Jira, and in what plugins add (Slack, School…).
// Zero dependencies, Node 22+. See README.md.
//
//   clearsky              print a Markdown summary
//   clearsky --json       print the raw data as JSON (for Copilot skills / scripts)
//   clearsky serve        serve the dashboard on http://127.0.0.1:7777

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync, statSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir, availableParallelism, totalmem } from 'node:os';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { delimiter, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import * as settings from '../lib/settings.mjs';
import * as localState from '../lib/state.mjs';
import * as copilot from '../lib/copilot.mjs';
import { AcpAgent, chatEvent } from '../lib/acp.mjs';
import { sessionEvents, sessionUsage } from '../lib/copilot-events.mjs';
import { branchesFor } from '../lib/branches.mjs';
import { sandboxedCommand, sandboxEnded, stopSandbox, sandboxProxy, sandboxProxyLogin, sandboxNetwork, githubLogin, maskedEnv, DEFAULT_DOMAINS, parseDomains } from '../lib/sandbox.mjs';
import { HostDoor, ruleMatches } from '../lib/host-door.mjs';
import { closeCards } from '../lib/chat-cards.mjs';
import { VmImage, ChatVm, vmSupport, VM_DOMAINS, reapOrphans, vmsLoad } from '../lib/vm.mjs';
import { mirrorStats, pruneMirror, cacheCapBytes } from '../lib/registry-mirror.mjs';
import { VmQueue } from '../lib/vm-queue.mjs';
import { TreeLoad } from '../lib/proc-load.mjs';
import { Jobs, jobReport, jobView, shellLine, tailOf } from '../lib/jobs.mjs';
import { Watchdog, watchdogSettings, nudgeText, REASONS as NUDGE_REASONS, AUTO_MARK } from '../lib/watchdog.mjs';
import { logWrite, readWrites } from '../lib/agent-log.mjs';
import { redact } from '../lib/redact.mjs';
import { checkFolder } from '../lib/chat-folders.mjs';
import { checkFileRef, findFiles, fileRefLine } from '../lib/file-refs.mjs';
import * as memory from '../lib/memory.mjs';
import { sshHosts } from '../lib/ssh-hosts.mjs';
import { buildRepos } from '../lib/builds.mjs';
import { allCreditRecords, creditTotals, costRates, costOf, liveRate } from '../lib/credit-usage.mjs';
import { disclosureLine, disclosureFields, creditSplit } from '../lib/disclosure.mjs';
import { parseReviewArgs, changeOf, reviewPrompt, writeBaseFiles, reviewDecision, USAGE as REVIEW_USAGE } from '../lib/review.mjs';
import { buildMap, buildKind } from '../lib/map.mjs';
import { serveBroker, brokerSocket } from '../lib/broker.mjs';
import { mavenSandbox, sandboxCa, plainMaven, withSandboxProxy, PROXY_TOKEN_ENV } from '../lib/maven.mjs';
import { githubFilter, REGISTRY_HOSTS, GITHUB_LOG_HOSTS, SHARED_BRANCH, NODES_REPO_QUERY, repoFromNodes } from '../lib/github-gate.mjs';
import { githubAdvice, jiraAdvice, outsideAdvice, parseRules, ruleLabel } from '../lib/advice.mjs';
import { attentionItems, diffAttention, desktopNotify, DbusNotifier } from '../lib/notify.mjs';
import { makeContext, hook, asList } from '../lib/sources.mjs';
import { listPlugins, preparePlugin, removePlugin, updatePlugin, checkPlugin, readRegistry, withRef, changesText, catalogEntry, bundledDir, codeDir, retiredText } from '../lib/plugins.mjs';
import { srtCli } from '../lib/plugin-sandbox.mjs';
import { findBrowser, BROWSERS, openCommand } from '../lib/browser.mjs';
import { wslInfo, isWindowsExe, windowsProfileDir, loginEnv } from '../lib/wsl.mjs';
import { readLinks, saveLinks, parseBookmarks, mergeLinks } from '../lib/links.mjs';
import { logEvent } from '../lib/event-log.mjs';
import { startDemo, demoPort, isDemo } from '../lib/demo.mjs';
import { checks as doctorChecks, suggestions as doctorSuggestions, doctorText, ready as doctorReady } from '../lib/doctor.mjs';
import { edsCalendars } from '../lib/eds.mjs';
import { joinPack, joinSummary, readTeam, exportPack, TEAM_KEYS, applyWaiting, pluginOffers } from '../lib/team.mjs';
import { scaffoldPack, writeScaffold, nextSteps } from '../lib/team-scaffold.mjs';
import { NEW_TASK_HINT, cleanNewTask, newTaskPrompt } from '../lib/new-task.mjs';
import { TRACKERS } from '../lib/tracker.mjs';
import { reviewGate } from '../lib/review-gate.mjs';
import { SAFE_GIT, SAFE_DIFF, localPrograms } from '../lib/safe-git.mjs';
import * as chatScope from '../lib/chat-scope.mjs';
import { untilde } from '../lib/util.mjs';
import { pageHeaders, COMMON_HEADERS, crossSite } from '../lib/page-security.mjs';
import { AGENTS } from '../lib/agents.mjs';
import { readHandoffs, saveHandoffs, addHandoff, nextHandoff, settleAfterRestart, handoffPrompt, handoffResult, updateHandoff } from '../lib/handoff.mjs';
import { srtInstalled } from '../lib/doctor.mjs';
import { groupStandup } from '../lib/standup.mjs';
import { ciState, isBot, openThreads, myPrStatus } from '../lib/modules/github.mjs';
import { sortVersions } from '../lib/modules/jira.mjs';
import { fieldsOf, nameOf, PROJECT_KEY, starredProjects, versionSummary } from '../lib/modules/jira.mjs';
import { appDir, userEnvFile, stateFile, agentLogFile, scopesFile, agentFilesFile, vpn, list, config, tracker, backend, installedAgents, whenSettingsChange, applySettings, saveSettings, pluginDirs, plugins, clock, atLocalTime, isWorkday, sameDay, standupOn, nextStandup, previousStandup } from '../lib/app/config.mjs';
import { http, execFileP, settle, ghModule, gql, reviewerOptions, requestReviews, mergePr, ghCliToken, jiraModule, REPO_NAME, starredRepos, jiraSearch, jiraSite, browseUrl, jiraDebug, issuePreview, ticketGoal } from '../lib/app/services.mjs';
import { hiddenCalendars, SOURCES, BUILTIN_MANIFESTS, linksFile, moduleManifests, workItemsOf, pluginData, sourceCache, STALE_MAX, dataVersion, source, loadSourceCache, withOwn, collect, toMarkdown } from '../lib/app/work.mjs';
import { sessionAgent, chatAgent, workspaceInfo, copilotCwd, copilotInfo, copilotTmp, copilotEnv, copilotHome, acpChats, SANDBOX_GIT, folderNotes, chatFolders, chatReadRoots, sandboxOpts, ghToken, chatRef, gitRepos, gitReposLater, cloneDirs, chatRepos, tildeHome, chatByKey, sessionsCache, keepSessions, forgetSessions, codeDirs, findCheckout, worktreeFor, prBranch, isDir, assistedAllow, copilotFolders } from '../lib/app/chat-env.mjs';
import { doorsByName, CONTEXT_INTRO, UPDATE_INTRO, PR_HINT, trackerHints, CHOICES_HINT, memoryHint, foldersHint, buildsWhere, sandboxHintFor, MSG_MARK, typedPart, REFS_INTRO, referenceText, validRefs, copilotContext } from '../lib/app/chat-hints.mjs';
export { userEnvFile, parseWorkdays, tracker, backend, clock, nextStandup, previousStandup } from '../lib/app/config.mjs';
export { issuePreview } from '../lib/app/services.mjs';
export { hiddenCalendars, planNow, moduleManifests, source, prReadKey, collect, toMarkdown } from '../lib/app/work.mjs';
export { remoteRepo, findCheckout, worktreeFor } from '../lib/app/chat-env.mjs';
export { JIRA_HINT, buildsWhere, buildsHint, typedPart, validRefs } from '../lib/app/chat-hints.mjs';
export { isBot, openThreads, myPrStatus };
let jiraProjectsCache = { at: 0, data: null }; // every Jira project you can see, for starring (Versions page)
let ghReposCache = { at: 0, data: null }; // the same with GitHub Issues: repos you can star

// ---------------------------------------------------------------- Stand-up

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
        number title url state isDraft createdAt mergedAt headRefName repository { nameWithOwner }
        closingIssuesReferences(first: 3) { nodes { number title repository { nameWithOwner } } }
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
  const closes = (p) => (p.closingIssuesReferences?.nodes || []).map((i) => ({ ref: `${i.repository.nameWithOwner}#${i.number}`, title: i.title }));
  const minePr = (p) => ({ ...pr(p), branch: p.headRefName || null, commits: commitsByPr.get(p.url) || 0, issues: closes(p).map((i) => i.ref) });
  const mine = data.mine.nodes.filter((p) => p?.number);
  // Commits are counted from my PRs: GitHub's contribution counts hide private org work
  // ("restricted contributions"), so contributionsCollection reports 0 there.
  const commitsByRepo = new Map(), commitsByPr = new Map();
  for (const p of mine) {
    // On my own PRs, a commit is mine if GitHub links it to me, or if it isn't linked to any
    // account (an email not added to GitHub) and isn't a GitHub noreply address of someone else.
    const mineCommit = (a) => a.user?.login === me || (!a.user && !/@users\.noreply\.github\.com$/i.test(a.email || ''));
    const n = (p.commits?.nodes || []).filter((c) => after(c.commit.committedDate) &&
      c.commit.authors.nodes.some(mineCommit)).length;
    if (n) commitsByRepo.set(p.repository.nameWithOwner, (commitsByRepo.get(p.repository.nameWithOwner) || 0) + n);
    if (n) commitsByPr.set(p.url, n);
  }
  return {
    merged: mine.filter((p) => after(p.mergedAt)).map(minePr),
    opened: mine.filter((p) => after(p.createdAt) && !after(p.mergedAt)).map((p) => ({ ...minePr(p), draft: p.isDraft })),
    reviewed: data.reviewed.nodes.filter((p) => p?.number).map((p) => {
      const mineNow = p.reviews.nodes.filter((r) => after(r.submittedAt) && r.state !== 'PENDING');
      return mineNow.length ? { ...pr(p), author: p.author?.login, verdict: mineNow.at(-1).state } : null;
    }).filter(Boolean),
    commits: [...commitsByRepo].map(([repo, count]) => ({ repo, count })),
  };
}

// GitHub issues for the stand-up, when they are the tracker: the ones of yours closed since the
// last stand-up, and the open ones you opened or commented on.
async function standupIssues(since) {
  config.github.token ||= await ghCliToken();
  if (!config.github.token) return { error: 'GITHUB_TOKEN is not set and `gh auth token` gave nothing' };
  const { viewer } = await gql('query { viewer { login } }');
  const me = viewer.login, day = since.toISOString().slice(0, 10);
  const scope = `${config.github.orgs.map((o) => `org:${o}`).join(' ')} archived:false`;
  const fields = '... on Issue { number title url state updatedAt closedAt repository { nameWithOwner } }';
  const d = await gql(`query($closed: String!, $touched: String!) {
      closed: search(query: $closed, type: ISSUE, first: 30) { nodes { ${fields} } }
      touched: search(query: $touched, type: ISSUE, first: 30) { nodes { ${fields} } }
    }`, {
    closed: `is:issue is:closed assignee:${me} closed:>=${day} ${scope}`,
    touched: `is:issue is:open involves:${me} updated:>=${day} ${scope}`,
  });
  const shape = (i, status) => ({ key: `${i.repository.nameWithOwner}#${i.number}`, summary: i.title, url: i.url, status });
  const done = (d.closed?.nodes || []).filter((i) => i?.number && Date.parse(i.closedAt) >= +since).map((i) => shape(i, 'Closed'));
  const seen = new Set(done.map((i) => i.key));
  return { done, touched: (d.touched?.nodes || []).filter((i) => i?.number && !seen.has(`${i.repository.nameWithOwner}#${i.number}`)).map((i) => shape(i, 'Open')) };
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

// The stand-up as text, for Slack and for Copilot's "Say this": Yesterday / Today / Blockers,
// one line per ticket or PR (lib/standup.mjs). `details: true` adds the folded-away detail list.
export function standupText(s, { details = false } = {}) {
  const g = s.summary || groupStandup(s, { clock });
  const out = [];
  const section = (title, lines, none) => {
    if (out.length) out.push('');
    out.push(title);
    (lines.length ? lines : none ? [none] : []).forEach((l) => out.push(`- ${l}`));
  };
  section(`*Yesterday* (since ${s.sinceLabel})`, g.yesterday, `Nothing recorded on GitHub${s.tracker === 'jira' || !s.tracker ? ', Jira' : ''} or Copilot.`);
  section('*Today*', g.today, 'Pick up the next item from the queue.');
  section('*Blockers*', g.blockers, 'None');
  if (details && g.details.length) section('*Details*', g.details);
  return out.join('\n');
}

// What to say at stand-up, in your words rather than a list of tickets: Copilot turns the
// stand-up above into a few spoken sentences, grouped by what the work is for. It gets the text
// only, no tools; the answer is kept until the next stand-up or a new one is asked for.
const SAY_PROMPT = `This is my stand-up, as a list from my GitHub, ticket and Copilot work. Write what I'll say in the meeting:
first person, spoken and plain, 4 to 7 short sentences in three short paragraphs (yesterday, today, blockers).
Group the work by what it's for (the feature or problem), not ticket by ticket; name a ticket key only when it helps
people find it, and leave out repo names, PR numbers and statuses unless they matter (say "it's in review" rather
than a status). Say plainly what is merged and ready to test, and what is still in review, since testers listen for that.
Each line is one piece of work with its PRs and status; the Details at the end are background, not a list to read out.
Don't invent anything that isn't in the list. If there are no blockers, say so in a few words.
Answer with the text only, no headings or bullets.

`;
let sayCache = { key: null, text: null, at: null };
async function standupSay(s, force) {
  const input = standupText(s, { details: true });
  const key = `${s.sinceLabel}|${s.text}`;
  if (!force && sayCache.key === key) return sayCache;
  const info = await copilotInfo();
  if (!info.available) throw new Error(`${backend().product} not found`);
  const text = backend().name !== 'copilot' ? await oneShot(info.bin, SAY_PROMPT + input, { model: process.env.AGENT_MODEL || undefined }) : await new Promise((done, fail) => {
    let out = '';
    copilot.runCopilot(info.bin, copilot.copilotArgs({ prompt: SAY_PROMPT + input, permission: 'read', model: process.env.AGENT_MODEL || undefined, cwd: copilotCwd() }), {
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
    .map((x) => ({ ...x, ws: workspaceInfo(x.id, x.cwd) }))
    .filter((x) => orgs.has(x.ws.repository?.split('/')[0]?.toLowerCase()) && !/review/i.test(x.ws.client_name || ''));
  return {
    sessions: sessions.slice(0, 12).map(({ id, title, ws }) => ({
      id, title, repo: ws.repository, branch: ws.branch || null,
      ticket: (ws.branch || '').toUpperCase().match(/\b([A-Z][A-Z0-9_]+-\d+)\b/)?.[1] || null,
    })),
  };
}

// `since` overrides the start of the window (used by tests).
export async function standup(work, since = previousStandup()) {
  const next = nextStandup();
  const t = tracker();
  const ticketsSince = t === 'jira' ? standupJira(since) : t === 'github' ? standupIssues(since) : Promise.resolve({ done: [], touched: [] });
  const [github, tickets, copilotWork] = await Promise.all([settle(standupGitHub(since)), settle(ticketsSince), settle(standupCopilot(since))]);
  const w = work || await collect();
  // GitHub issue titles, for the issues a PR closes.
  const issueTitles = {};
  if (t === 'github') {
    for (const i of w.github?.assigned || []) issueTitles[`${i.repo}#${i.number}`] = i.title;
    for (const i of [...(tickets.done || []), ...(tickets.touched || [])]) issueTitles[i.key] = i.summary;
  }
  const today = {
    inProgress: t === 'jira' ? (w.jira?.assigned || []).filter((i) => i.statusCategory === 'indeterminate').slice(0, 5) : [],
    reviews: w.github.reviewRequested || [],
    myPrs: (w.github.myPrs || []).filter((p) => p.status.owner === 'me' && !p.draft),
    // Out for review, waiting on others: not merged, so not ready to test yet.
    inReview: (w.github.myPrs || []).filter((p) => p.status.owner !== 'me' && !p.draft),
    meetings: (w.plan?.agenda || []).filter((e) => sameDay(new Date(e.start), new Date()) && e.title !== 'Stand-up'),
  };
  const days = (iso) => (Date.now() - Date.parse(iso)) / 864e5;
  const blockers = (w.github.myPrs || [])
    .filter((p) => p.status.owner === 'others' && p.status.label === 'Waiting for review' && days(p.updatedAt) >= 1)
    .map((p) => ({ url: p.url, repo: p.repo, number: p.number, title: p.title, branch: p.branch || null, days: Math.floor(days(p.updatedAt)),
      pendingReviewers: p.pendingReviewers, text: `${p.repo}#${p.number} has waited ${Math.floor(days(p.updatedAt))}d for review` +
      (p.pendingReviewers.length ? ` (${p.pendingReviewers.join(', ')})` : '') }));
  const s = {
    generatedAt: new Date().toISOString(),
    since: since.toISOString(),
    sinceLabel: `${since.toLocaleDateString([], { weekday: 'long' })} ${clock(since)}`,
    nextStandup: next.toISOString(),
    tracker: t,
    jiraBase: t === 'jira' ? jiraModule.site : null,
    // Which "ABC-123" are Jira keys: starred projects and the projects of tickets seen here.
    jiraProjects: t !== 'jira' ? [] : [...new Set([...starredProjects(process.env.JIRA_STARRED_PROJECTS),
      ...[...(tickets.done || []), ...(tickets.touched || []), ...(w.jira?.assigned || [])].map((i) => String(i.key || '').split('-')[0]).filter(Boolean)])],
    issueTitles,
    // `jira` stays for skills and scripts that read it; `tickets` is the same, for any tracker.
    yesterday: { github, tickets, ...(t === 'jira' && { jira: tickets }), copilot: copilotWork },
    today,
    blockers,
  };
  // Plugins add their own lines, such as what's on at school today.
  const extra = w.sources || await pluginData(false);
  s.extra = [...plugins.sources.values()].map((p) => {
    const r = extra[p.name]?.error || extra[p.name]?.disabled ? null : hook(p, 'standup', extra[p.name], since);
    return r && !r.hookError && { label: p.label, yesterday: asList(r.yesterday).map(String), today: asList(r.today).map(String) };
  }).filter(Boolean);
  s.summary = groupStandup(s, { clock });
  s.text = standupText(s);
  return s;
}

// ---------------------------------------------------------------- chat outputs

const safeName = (n) => String(n).split(/[\\/]/).pop().replace(/[^\w.@+-]+/g, '_').replace(/^\.+/, '').slice(0, 120) || 'file';
const stagingDir = () => join(copilotTmp(), 'attachments');
function isStaged(pth) {
  try { const real = realpathSync(pth); return real.startsWith(`${realpathSync(stagingDir())}/`) && statSync(real).isFile(); } catch { return false; }
}
const sessionDir = (id) => join(copilotHome(), 'session-state', id);
// An attachment is copied into the chat's own Copilot folder (files/), which outlives the scratch folder.
function keepAttachment(id, pth) {
  if (!id || !/^[\w-]{8,64}$/.test(id)) return;
  try {
    const dir = join(sessionDir(id), 'files');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    let dest = join(dir, basename(pth));
    for (let i = 2; existsSync(dest) && i < 100; i++) dest = join(dir, basename(pth).replace(/(\.[^.]*)?$/, `-${i}$1`));
    writeFileSync(dest, readFileSync(pth), { mode: 0o600 });
    logWrite(agentFilesFile, { where: 'file', what: dest, kind: 'attached', from: pth, chats: [{ id }], decided: 'done' });
  } catch { /* the message still names the staged file */ }
}
function listDir(dir, max = 200) {
  const out = [];
  const walk = (d, depth) => {
    let ents = [];
    try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (out.length >= max) return;
      const p = join(d, e.name);
      if (e.isDirectory() && depth < 4) walk(p, depth + 1);
      else if (e.isFile()) out.push(p);
    }
  };
  walk(dir, 0);
  return out;
}
const TEXT_EXT = /(\.(txt|log|md|markdown|json|ya?ml|xml|csv|tsv|java|kt|kts|groovy|gradle|scala|js|mjs|cjs|jsx|ts|tsx|py|go|rs|rb|php|c|h|cpp|hpp|cs|swift|sql|sh|bash|zsh|ps1|properties|toml|ini|conf|cfg|env|diff|patch|html?|css|scss|vue|svelte|graphql|proto|tf|hcl)|\/(Dockerfile|Makefile|Jenkinsfile|\.gitignore))$/i;
const fileType = (p) => (/\.pdf$/i.test(p) ? 'application/pdf' : /\.png$/i.test(p) ? 'image/png' : /\.jpe?g$/i.test(p) ? 'image/jpeg' : /\.gif$/i.test(p) ? 'image/gif' : /\.webp$/i.test(p) ? 'image/webp' : TEXT_EXT.test(p) ? 'text/plain' : 'application/octet-stream');
// The files that count as this chat's: its own Copilot folders, and what it wrote or you attached.
function chatFilePaths(id) {
  const own = ['files', 'research'].flatMap((d) => listDir(join(sessionDir(id), d)).map((p) => ({ path: p, kind: d === 'research' ? 'research' : 'file' })));
  const logged = readWrites(agentFilesFile, { chat: id, limit: 2000 }).reverse();
  const by = new Map(own.map((f) => [f.path, f]));
  for (const e of logged) {
    if (e.kind === 'deleted') { by.delete(e.what); continue; }
    by.set(e.what, { path: e.what, kind: e.kind, at: e.at });
  }
  return [...by.values()];
}
function chatFile(id, pth) {
  const f = chatFilePaths(id).find((x) => x.path === pth);
  if (!f) return null;
  try {
    const st = statSync(pth);
    if (!st.isFile() || st.size > 20 * 1024 * 1024) return null;
    return { name: basename(pth), type: fileType(pth), data: readFileSync(pth) };
  } catch { return null; }
}
// What changed in a file on its branch: against where the branch left the default branch
// (origin/HEAD, main or master), uncommitted changes included. Empty outside a git clone.
// The folder is the chat's to write, so git runs in the chat's sandbox while it is up, and
// otherwise never in a repo whose own settings name a program to run (lib/safe-git.mjs).
async function fileDiff(pth, c = null) {
  const dir = dirname(pth);
  const run = c?.agent?.inSandbox && !c.agent.closed ? sandboxRun(c) : execFileP;
  if (run === execFileP && (await localPrograms(dir)).length) return { diff: '', base: null, unsafe: true };
  const git = (...a) => run('git', ['-C', dir, ...SAFE_GIT, ...a], { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 }).then((r) => String(r.stdout).trim(), () => '');
  if (!await git('rev-parse', '--is-inside-work-tree')) return { diff: '', base: null };
  let base = '';
  for (const ref of ['origin/HEAD', 'origin/main', 'origin/master', 'main', 'master']) if ((base = await git('merge-base', 'HEAD', ref))) break;
  const diff = await git('diff', '--no-color', ...SAFE_DIFF, base || 'HEAD', '--', basename(pth));
  const untracked = !diff && await git('ls-files', '--others', '--exclude-standard', '--', basename(pth));
  return { diff: diff.slice(0, 2_000_000), base: base ? base.slice(0, 8) : 'HEAD', new: !!untracked };
}
// The PRs of branches a chat pushed, looked up as you (read only), kept 5 minutes.
const branchPrCache = new Map();
async function branchPrs(repo, branch) {
  const k = `${repo}:${branch}`, hit = branchPrCache.get(k);
  if (hit && Date.now() - hit.at < 5 * 6e4) return hit.prs;
  let prs = [];
  try {
    config.github.token ||= await ghCliToken();
    const r = await fetch(`https://api.github.com/repos/${repo}/pulls?state=all&per_page=5&head=${encodeURIComponent(`${repo.split('/')[0]}:${branch}`)}`, { headers: { Authorization: `Bearer ${config.github.token}`, Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(10_000) });
    if (r.ok) prs = (await r.json()).map((p) => p.number);
  } catch { /* none known */ }
  branchPrCache.set(k, { at: Date.now(), prs });
  return prs;
}
async function chatOutputs(id) {
  const tilde = (p) => (p.startsWith(homedir()) ? `~${p.slice(homedir().length)}` : p);
  const files = chatFilePaths(id).map((f) => {
    let st = null;
    try { st = statSync(f.path); } catch {}
    return { path: f.path, shown: tilde(f.path), name: basename(f.path), kind: f.kind, at: f.at || (st ? new Date(st.mtimeMs).toISOString() : null), size: st?.size ?? null, exists: !!st, type: st ? fileType(f.path) : null };
  }).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 200);
  const [map] = buildMap(readWrites(agentLogFile, { chat: id, limit: 3000 }));
  const jira = (jiraModule.site || '').replace(/\/$/, '');
  const links = [];
  for (const n of map?.nodes || []) {
    const acts = [...new Set(n.acts.map((a) => a.act))];
    const last = n.acts.at(-1)?.at || null;
    if (n.kind === 'repo') {
      const prs = new Set(n.prs);
      for (const b of n.branches) for (const p of await branchPrs(n.key, b)) prs.add(p);
      for (const p of prs) links.push({ kind: 'pr', label: `${n.key}#${p}`, url: `https://github.com/${n.key}/pull/${p}`, pr: `${n.key}#${p}`, acts: n.acts.filter((a) => a.pr === p).map((a) => a.act), at: last });
      for (const b of n.branches) links.push({ kind: 'branch', label: `${n.key} · ${b}`, url: `https://github.com/${n.key}/tree/${encodeURIComponent(b).replace(/%2F/g, '/')}`, acts: acts.filter((a) => /push|branch|tests|build|review/.test(a)), at: last });
      if (n.acts.some((a) => a.act === 'started CI')) links.push({ kind: 'ci', label: `${n.key} · CI runs`, url: `https://github.com/${n.key}/actions`, acts: ['started CI'], at: last });
      if (!prs.size && !n.branches.length) links.push({ kind: 'repo', label: n.key, url: `https://github.com/${n.key}`, acts, at: last });
    } else if (n.kind === 'ticket') links.push({ kind: 'ticket', label: n.key, url: jira ? `${jira}/browse/${n.key}` : null, issue: n.key, acts, at: last });
    else if (n.kind === 'project') links.push({ kind: 'project', label: `Jira ${n.key}`, url: jira ? `${jira}/browse/${n.key}` : null, acts, at: last });
    else if (n.kind === 'env') links.push({ kind: 'env', label: `Grafana ${n.key}`, url: null, acts, at: last });
  }
  return { files, links };
}

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

// Logins that extra sources start from Settings, such as BankID in a browser window. They
// can take minutes, so they run in the background and Settings polls for the outcome.
const sourceLogins = new Map();

async function loginStatus() {
  const many = [...plugins.sources.values()].filter((p) => p.logins?.list).map((p) => {
    let list = [];
    try { list = asList(p.logins.list(makeContext(p).env)); } catch { /* shows none */ }
    return { name: p.name, label: p.label, many: list.map((l) => ({ id: String(l.id), label: String(l.label || l.id), loggedIn: !!l.loggedIn, detail: String(l.detail || ''), canLogOut: !!l.canLogOut })) };
  });
  return [...many, ...await Promise.all([...plugins.sources.values()].filter((p) => p.login).map(async (p) => {
    let st = {};
    try { st = (await p.login.status?.(makeContext(p).env)) || {}; } catch (e) { st = { detail: e.message }; }
    const run = sourceLogins.get(p.name);
    return { name: p.name, label: p.label, button: p.login.label || 'Log in', loggedIn: !!st.loggedIn, detail: st.detail || '',
      running: run?.state === 'running', error: run?.state === 'error' ? run.message : null };
  }))];
}

// Join a team pack (lib/team.mjs): settings through the settings file, links and skills too.
// A plugin's settings it lets a team set (manifest "team": true) count as team settings; the
// pack's values for plugins you haven't added wait until you add them (teamWaiting).
const teamKey = (k) => !!settings.FIELDS[k]?.team;
const teamIo = () => ({
  readEnv: () => Object.fromEntries([...TEAM_KEYS, ...Object.keys(settings.FIELDS).filter(teamKey)].map((k) => [k, process.env[k] || ''])),
  writeEnv: (v) => { settings.writeEnvFile(userEnvFile, v); applySettings(v); }, // already checked by the caller
  validate: (w) => settings.validate(Object.fromEntries(Object.entries(w).filter(([k]) => settings.FIELDS[k]))),
});
function joinTeam(from) {
  return joinPack(from, {
    confDir: dirname(userEnvFile), skillsDir: backend().personalSkills(), ...teamIo(),
    readLinks: () => readLinks(linksFile()), saveLinks: (d) => saveLinks(linksFile(), d),
    teamKey, known: (k) => !!settings.FIELDS[k], added: () => readRegistry(pluginDirs.registry).plugins,
  });
}
function teamWaiting() {
  try { const w = applyWaiting(dirname(userEnvFile), { teamKey, ...teamIo() }); if (w.length) logEvent(`team pack settings filled in for a plugin you added: ${w.join(', ')}`); }
  catch (e) { console.error(`clearsky: team pack settings: ${e.message}`); }
}
// A new team pack repo from your own settings (lib/team-scaffold.mjs): `clearsky team init` and Settings.
function makeTeamPack({ dir, name, repo, jiraSite, links = false, force = false }) {
  if (!dir) throw new Error('say which folder to write it to');
  const env = Object.fromEntries(Object.keys(settings.FIELDS).filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
  const { pack, files, warnings } = scaffoldPack({ name: name || 'Team', repo, jiraSite, env, teamKeys: Object.keys(settings.FIELDS).filter(teamKey),
    links: links ? readLinks(linksFile()) : null, registry: readRegistry(pluginDirs.registry).plugins, catalogFrom: (n) => catalogEntry(n)?.from || null });
  const w = writeScaffold(dir, files, { force });
  return { ...w, pack, warnings, next: nextSteps(w.dir, repo) };
}
// The team pack's plugins next to yours, for Settings → Plugins.
const teamPlugins = () => { const t = readTeam(dirname(userEnvFile)); return t?.plugins?.length ? { name: t.name, plugins: pluginOffers(t.plugins, readRegistry(pluginDirs.registry).plugins) } : null; };

// `clearsky doctor` and the welcome page: what this machine has for Clearsky.
const machineChecks = () => doctorChecks({ acliBin: config.jira.acli, tracker: tracker(), agent: backend(), copilotBin: backend().find(),
  calendars: () => (process.platform === 'linux' && !wslInfo() ? edsCalendars() : []), browser: () => { try { return findBrowser(process.env, { windows: true }); } catch { return null; } },
  vm: () => vmSupport(), folders: [appDir, ...copilotFolders()] });
// Nothing set up yet: no settings file of your own and no organizations from anywhere else.
const firstRun = () => !existsSync(userEnvFile) && !process.env.GITHUB_ORGS && !isDemo();

const settingsStatus = async () => {
  const st = await settings.status(config, { path: userEnvFile });
  return { ...st, tracker: { ...st.tracker, now: TRACKERS[tracker()] }, logins: await loginStatus() };
};

function startSourceLogin(p) {
  if (sourceLogins.get(p.name)?.state === 'running') return;
  sourceLogins.set(p.name, { state: 'running' });
  Promise.resolve().then(() => p.login.start(makeContext(p).env)).then((r) => {
    // Only the source's own settings, e.g. a school key learned from the login.
    const own = Object.fromEntries(Object.entries(r?.settings || {}).filter(([k, v]) => Object.hasOwn(p.settings || {}, k) && v));
    if (Object.keys(own).length) saveSettings(own);
    sourceLogins.delete(p.name);
    sourceCache.delete(p.name);
  }).catch((e) => sourceLogins.set(p.name, { state: 'error', message: e.message }));
}

// ---------------------------------------------------------------- Copilot chat

// Slash commands Copilot last offered (its built-ins and your skills).
let copilotCommands = null;
const hintOwed = new Set(); // resumed chats whose first message was a command: the hint goes with the next one

setInterval(() => {
  // Not one with a background job running (its VM runs it) or a nudge due (lib/watchdog.mjs).
  for (const [id, c] of acpChats) if (!c.busy && !c.waiting.size && Date.now() - c.lastUsed > 20 * 6e4 && !jobs.running(id).length && !watchdog.view(id).due) { c.agent.close(); c.vm?.stop(); acpChats.delete(id); }
}, 60_000).unref();

// Stop a turn on purpose. Closing the page or switching chats leaves it running.
function stopCopilot(chat) {
  const c = acpChats.get(chat);
  if (c) {
    c.userStopped = true; // no nudge for a turn you stopped
    watchdog.cancel(chat);
    autoInbox.delete(chat);
    c.agent.cancel();
    for (const r of c.waiting.values()) r({ outcome: 'cancelled' });
    c.waiting.clear(); c.pending.clear();
  }
  return !!c;
}

let broker = null;
// Start Copilot, inside the sandbox (srt, run by Clearsky itself) when the mode or Settings →
// Copilot says so.
// `permission` and `model` are the chat's (Claude Code takes them as a session mode and an
// environment variable); `dirs`, the folders it may use besides its own (Copilot takes flags).
// `agent`: which one ("copilot", "claude"; the default one if left out). `bin` null: its own.
async function startAgent(bin, args, cwd, { sandbox = process.env.AGENT_SANDBOX === 'srt', folders = [], permission = 'ask', model = null, dirs = [], agent: name = null } = {}) {
  const b = backend(name);
  bin ||= b.find();
  if (!bin) throw new Error(`${b.product} isn't installed here (${b.install.command})`);
  const how = { label: b.label, mode: b.sessionMode(permission), dirs, acp: false };
  const own = () => ({ ...copilotEnv(b), ...b.env({ model }) });
  if (!sandbox) return new AcpAgent(bin, b.acp(args), { env: own(), ...how });
  // In Clearsky's container, the container is the sandbox: Copilot sees only what's mounted
  // (git already goes over https there). The network isn't limited to AGENT_DOMAINS, though.
  if (process.env.CLEARSKY_IN_CONTAINER === '1') return Object.assign(new AcpAgent(bin, b.acp(args), { env: own(), ...how }), { sandboxed: true });
  // The chats' VMs share the sandbox's proxy, so its hosts include what they need (Docker Hub…),
  // and the agent's own service (Claude Code's; Copilot's is in the defaults).
  const domains = [...new Set([...(process.env.AGENT_DOMAINS ? parseDomains(process.env.AGENT_DOMAINS) : DEFAULT_DOMAINS), ...b.hosts, ...(vmSupport().ok ? VM_DOMAINS : [])])];
  const keep = join(dirname(stateFile), 'sandbox');
  // Logins stay out here; srt adds them on the way out. srt reads them from Clearsky's own
  // environment, and the sandbox gets stand-ins: Maven's (lib/maven.mjs) and your gh login.
  let maven = null;
  // The chat's folders' poms name the repositories that settings.xml has only logins for.
  try { maven = mavenSandbox({ home: homedir(), out: join(dirname(brokerSocket()), 'maven'), keep, dirs: [cwd, ...folders] }); } catch (e) {
    console.error(`clearsky: Maven logins for the sandbox: ${e.message}`);
    // Without the logins, Maven still runs from your local repository with a copy minus secrets.
    try { maven = plainMaven(readFileSync(join(homedir(), '.m2', 'settings.xml'), 'utf8'), join(dirname(brokerSocket()), 'maven')); } catch { /* no settings */ }
  }
  // No settings.xml of yours: Maven still needs one, to find srt's proxy (below).
  if (!maven) try { maven = plainMaven('<settings>\n</settings>\n', join(dirname(brokerSocket()), 'maven')); } catch { /* can't write it */ }
  if (maven) Object.assign(process.env, maven.env);
  if (maven?.unmatched?.length) console.error(`clearsky: Maven logins with no repository host found (in settings.xml or the poms under ${cwd}): ${maven.unmatched.join(', ')}`);
  const env = { ...own(), ...b.sandboxEnv() };
  const n = Number(env.GIT_CONFIG_COUNT) || 0;
  // A token from Settings → Agent if you made one, else your gh login.
  const token = process.env.AGENT_SANDBOX_TOKEN || ghToken();
  const github = token ? githubLogin(token, process.env, n + SANDBOX_GIT.length) : null;
  [...SANDBOX_GIT, ...(github ? [github.git] : [])].forEach(([k, v], i) => { env[`GIT_CONFIG_KEY_${n + i}`] = k; env[`GIT_CONFIG_VALUE_${n + i}`] = v; });
  env.GIT_CONFIG_COUNT = String(n + SANDBOX_GIT.length + (github ? 1 : 0));
  if (maven) {
    env.MAVEN_ARGS = `${env.MAVEN_ARGS ? `${env.MAVEN_ARGS} ` : ''}--settings ${maven.settings}`;
    if (maven.javaOptions) env.MAVEN_OPTS = `${env.MAVEN_OPTS ? `${env.MAVEN_OPTS} ` : ''}${maven.javaOptions}`;
  }
  // The real values never go in: srt sets the stand-ins.
  for (const c of [...(github?.credentials || []), ...(maven?.credentials || [])]) delete env[c.name];
  // Under WSL: no way to Windows programs from inside (the interop socket is hidden too, lib/wsl.mjs).
  delete env.WSL_INTEROP;
  // The doors srt's network can't be (lib/broker.mjs): acli and `outside` reach Clearsky, which
  // asks you in this chat. The key tells Clearsky which chat a request comes from.
  const key = randomBytes(16).toString('hex');
  if (process.platform === 'linux') {
    broker ||= serveBroker({ bins: { acli: config.jira.acli }, gate: ({ argv }) => reviewGate(argv, (k) => ghModule.ticketPrs(k, { fresh: true })), allow: assistedAllow, ask: brokerAsk, where: brokerWhere, vm: vmSupport().ok ? vmRun : null, doors: pluginDoor, review: reviewRun, usage: usageRun, jobs: jobsDoor, reads: () => [copilotTmp()], log: console.log });
    Object.assign(env, { CLEARSKY_BROKER_SOCKET: brokerSocket(), CLEARSKY_BROKER_KEY: key });
    env.PATH = `${join(appDir, 'scripts', 'sandbox-bin')}${delimiter}${env.PATH}`;
  }
  // srt hands the sandbox TMPDIR=/tmp/claude unless told otherwise, so $TMPDIR in a chat wasn't
  // the scratch folder Clearsky reads acli's text files from (lib/broker.mjs): its Markdown went
  // to Jira as it was. The same folder inside and out.
  process.env.CLAUDE_CODE_TMPDIR = copilotTmp();
  // Copilot's built-in GitHub tools would change GitHub past the gate: off (b.sandboxArgs).
  const s = await sandboxedCommand(bin, b.acp([...args, ...b.sandboxArgs]), { ...sandboxOpts(cwd, folders), state: b.state, protect: b.protect, run: dirname(brokerSocket()), domains, maven, github, ca: sandboxCa(keep),
    // Read only, so the proxy reads them: CI logs (with GitHub on), Docker Hub (with the VM).
    inspect: [...(github ? GITHUB_LOG_HOSTS : []), ...(vmSupport().ok ? REGISTRY_HOSTS : [])] },
    sandboxGate());
  // Maven reaches the net only through srt's proxy, with its login (lib/maven.mjs): otherwise a
  // download gets the proxy's 407, and the host door never asks about the host.
  const proxy = maven && await sandboxProxyLogin();
  if (proxy) {
    try {
      writeFileSync(maven.settings, withSandboxProxy(readFileSync(maven.settings, 'utf8'), { ...proxy, token: !!proxy.token }), { mode: 0o600 });
      if (proxy.token) env[PROXY_TOKEN_ENV] = proxy.token;
    } catch (e) { console.error(`clearsky: Maven's proxy for the sandbox: ${e.message}`); }
  }
  const agent = new AcpAgent(s.bin, s.args, { env, ...how });
  agent.child.once('exit', sandboxEnded);
  // A background job (`bg <command>`) runs in a sandbox of its own with the same fence: folders,
  // hosts, logins added on the way out, and the GitHub gate.
  agent.inSandbox = async (argv, dir) => ({ env, ...await sandboxedCommand(argv[0], argv.slice(1), { ...sandboxOpts(dir, folders), state: b.state, protect: b.protect, run: dirname(brokerSocket()), domains, maven, github, ca: sandboxCa(keep),
    inspect: [...(github ? GITHUB_LOG_HOSTS : []), ...(vmSupport().ok ? REGISTRY_HOSTS : [])] },
  sandboxGate()) });
  return Object.assign(agent, { sandboxed: true, brokerKey: key, maven,
    github: github ? `${process.env.AGENT_SANDBOX_TOKEN ? 'your sandbox token' : 'your gh login'}, added on the way out; changes ask you` : 'not signed in (gh auth login)',
    hosts: [...new Set([...domains, ...(maven?.hosts || []), ...(github?.read || [])])] });
}

// srt's proxy asks Clearsky about two things: hosts not on its list (the host door, which asks
// you before Copilot reaches a new host) and requests it reads (data sent to such a host, and
// GitHub changes).
function sandboxGate() {
  const github = githubFilter(githubAsk, { told: githubTold, look: githubLook, scope: githubScope });
  const listed = (host) => sandboxNetwork().allowed.some((r) => ruleMatches(r.replace(/:\d+$/, ''), host, 443));
  return { ask: (p) => hostDoor.decide(p), filterRequest: async (req) => (await hostDoor.check(req, { listed })) || github(req) };
}
// The host door (lib/host-door.mjs): a host not on the sandbox's list waits at the proxy for your
// answer in the working chat. Always allowed ones are Settings → Agent → Hosts allowed from a chat.
const hostDoor = new HostDoor({
  chats: () => askingChats(null),
  ask: hostAsk,
  always: () => parseDomains(process.env.AGENT_READ_HOSTS),
  addAlways: (rule) => {
    const hosts = parseDomains(process.env.AGENT_READ_HOSTS);
    if (hosts.includes(rule)) return;
    saveSettings({ AGENT_READ_HOSTS: [...hosts, rule].join(', ') });
  },
  readable: () => sandboxNetwork().readsHttps,
  // You answered after the request gave up (or long enough that it may have): the chat goes on.
  late: (chats, rule) => { for (const c of chats) tellChat(c.id, `Clearsky: ${rule} is allowed now. If a request there failed while you waited, try it again and go on.`); },
});
function hostAsk(card, chats, { rule, write = false }) {
  const shared = chats.length > 1;
  const log = (decided) => logWrite(agentLogFile, { where: 'network', what: write ? card.detail.split('\n')[0] : `reach ${rule}`, target: rule, chats: chats.map(chatRef), decided });
  return new Promise((done) => {
    const id = randomBytes(6).toString('hex');
    const ev = { type: 'permission', id, kind: 'fetch', ...card };
    for (const c of chats) {
      c.waiting.set(id, (answer) => {
        for (const o of chats) { o.waiting.delete(id); o.pending.delete(id); o.shared.delete(id); o.emit({ type: 'permission-done', id }); }
        // Not answered before the turn ended (lib/chat-cards.mjs): taken down, not denied.
        if (answer.expired) { log('expired'); return done(write ? 'deny' : 'expired'); }
        // You stopped the turn: no answer, not a Deny (it would show as one, and count as one).
        if (!answer.optionId) {
          log('stopped');
          for (const o of chats) o.emit({ type: 'note', text: `Network: ${write ? card.detail.split('\n')[0] : rule}: not answered (turn stopped)` });
          return done(write ? 'deny' : 'expired');
        }
        const choice = answer.optionId;
        const name = card.options.find((o) => o.id === choice)?.name || 'Deny';
        log(choice === 'deny' ? 'declined' : choice);
        for (const o of chats) o.emit({ type: 'note', text: `Network: ${write ? card.detail.split('\n')[0] : rule}: ${name}` });
        done(choice);
      });
      if (shared) c.shared.add(id); // may not be this chat's: it doesn't mark the chat as needing you
      c.pending.set(id, ev);
      c.emit(ev);
    }
  });
}

// A GitHub change from a sandbox, held at srt's proxy (lib/github-gate.mjs). The proxy can't tell
// which chat sent it, so every sandboxed chat that's working asks; the first answer counts.
// When the only working chat is running a step you just allowed (say `gh pr create`), its
// GitHub changes are part of what you allowed and go through. With two chats working, it asks.
async function githubAsk(what, { repo, nodes = [], why = null } = {}) {
  repo ||= (what.match(/^git push to (\S+)/) || [])[1] || await nodesRepo(nodes);
  const chats = askingChats(repo);
  if (!chats.length) return false;
  const shared = chats.length > 1;
  const advice = await githubCardAdvice(what, repo, nodes, why, chats).catch(() => null);
  // A kind of change you said to let through from now on (Settings), when it looks fine.
  if (advice?.rule && advice.level === 'fine' && gateRules().has(advice.rule)) {
    logWrite(agentLogFile, { where: 'github', what, target: repo, chats: chats.map(chatRef), decided: `auto (rule ${advice.rule})` });
    for (const c of chats) c.emit({ type: 'note', text: `GitHub: ${what} (let through: ${ruleLabel(advice.rule)})` });
    return true;
  }
  if (chats.length === 1 && chats[0].approved.size) {
    logWrite(agentLogFile, { where: 'github', what, target: repo, chats: chats.map(chatRef), decided: 'allowed with a step' });
    return Promise.resolve(true);
  }
  return new Promise((done) => {
    const id = randomBytes(6).toString('hex');
    const title = /\/actions\/(workflows\/[^/]+\/dispatches|runs\/\d+\/rerun)/.test(what) ? 'Start a CI run as you' : 'Change GitHub as you';
    const ev = { type: 'permission', id, title, kind: 'execute', detail: what, advice,
      options: [{ id: 'allow', name: 'Allow', kind: 'allow_once' }, ...ruleOption(advice), { id: 'deny', name: 'Deny', kind: 'reject_once' }] };
    const finish = (ok, rule = false, expired = false) => {
      if (ok && rule && advice?.rule) addGateRule(advice.rule);
      for (const c of chats) { c.waiting.delete(id); c.pending.delete(id); c.shared.delete(id); c.emit({ type: 'permission-done', id }); }
      const target = repo || (what.match(/^git push to (\S+)/) || [])[1] || null;
      // Allowed in the one chat it came from: that repo is part of this chat's work from now on.
      if (ok && !shared && target && why?.startsWith('goes to ')) { chats[0].repos.add(target.toLowerCase()); chatScope.addScopeRepo(scopesFile, chats[0].id, target); }
      logWrite(agentLogFile, { where: 'github', what, target, chats: chats.map(chatRef), decided: ok ? 'allowed' : expired ? 'expired' : 'declined' });
      done(ok);
    };
    for (const c of chats) {
      if (c.mode === 'full') return finish(true); // Full: you allowed everything (logged as allowed)
      c.waiting.set(id, (answer) => finish(answer.optionId === 'allow' || answer.optionId === 'rule', answer.optionId === 'rule', !!answer.expired));
      if (shared) c.shared.add(id); // may not be this chat's: it doesn't mark the chat as needing you
      c.pending.set(id, ev);
      c.emit(ev);
    }
  });
}

// Kinds of change you let through from now on, from a card's "always" button (Settings → Agent).
const gateRules = () => parseRules(process.env.AGENT_GATE_RULES);
function addGateRule(rule) {
  const rules = gateRules();
  if (rules.has(rule)) return;
  rules.add(rule);
  saveSettings({ AGENT_GATE_RULES: [...rules].join(', ') });
}
// The card's "always" button: offered when the advice names a kind of change and, for merges and
// branch deletes, only when this one looks fine (the rule only ever lets fine ones through).
const ruleOption = (a) => (a?.rule && (a.level === 'fine' || /^(repo|jira):/.test(a.rule))
  ? [{ id: 'rule', name: `Allow, and always for ${ruleLabel(a.rule)}`, kind: 'allow_always' }] : []);

// What Clearsky reads from GitHub (as you, read only) to advise on a card (lib/advice.mjs): the
// PR a merge merges, the branch a delete deletes. Only states and names, never PR text.
async function githubCardAdvice(what, repo, nodes, why, chats) {
  const facts = { chatRepos: new Set(chats.flatMap((c) => [...chatRepos(c)])) };
  let number = Number(what.match(/\/pulls\/(\d+)\/merge\b/)?.[1]) || null;
  if (!number && /\(mergePullRequest\)$/.test(what)) {
    const d = await gql('query($ids: [ID!]!) { nodes(ids: $ids) { ... on PullRequest { number repository { nameWithOwner } } } }', { ids: nodes }, { partial: true }).catch(() => null);
    const pr = (d?.nodes || []).find((n) => n?.number);
    if (pr) { number = pr.number; repo ||= pr.repository.nameWithOwner; }
    facts.merge = null;
  }
  if (number && repo) facts.merge = await prFacts(repo, number, chats).catch(() => null);
  const branch = why?.match(/^deletes (\S+)$/)?.[1] || what.match(/^DELETE \S+?\/git\/refs\/heads\/(.+)$/)?.[1];
  if (branch && repo) facts.branch = await branchFacts(repo, decodeURIComponent(branch)).catch(() => null);
  return githubAdvice(why || '', facts);
}
async function prFacts(repo, number, chats) {
  const [pr, reviews] = await Promise.all([ghGet(`/repos/${repo}/pulls/${number}`), ghGet(`/repos/${repo}/pulls/${number}/reviews?per_page=100`)]);
  const latest = new Map();
  for (const r of reviews || []) if (r.user?.login && r.user.login !== pr.user?.login && ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.state)) latest.set(r.user.login, r.state);
  const byState = (st) => [...latest].filter(([, v]) => v === st).map(([k]) => k);
  const r = repo.toLowerCase(), head = String(pr.head?.ref || '').toUpperCase();
  const ours = chats.some((c) => (localState.sessionRefs(stateFile)[c.id] || []).some((k) => k.toLowerCase() === `pr:${r}#${number}`)
    || [...c.tickets].some((t) => new RegExp(`(^|[^A-Z0-9])${t}([^0-9]|$)`).test(head))
    || currentBranch(c.cwd) === pr.head?.ref) && chats.some((c) => chatRepos(c).has(r));
  return { number, ours, ci: await prCi(repo, number).catch(() => null), draft: !!pr.draft, mergeable: pr.mergeable, base: pr.base?.ref,
    approvals: byState('APPROVED'), changesRequested: byState('CHANGES_REQUESTED') };
}
// CI on the PR's latest commit, as the review queue sees it (ciState in lib/modules/github.mjs).
async function prCi(repo, number) {
  const [owner, name] = repo.split('/');
  const d = await gql(`query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) {
    commits(last: 1) { nodes { commit { statusCheckRollup { state } checkSuites(first: 20) { nodes { status conclusion workflowRun { event url workflow { name } } } } } } } } } }`,
  { owner, name, number });
  return ciState(d.repository.pullRequest);
}
async function branchFacts(repo, name) {
  const owner = repo.split('/')[0];
  const prs = await ghGet(`/repos/${repo}/pulls?state=all&per_page=10&head=${encodeURIComponent(`${owner}:${name}`)}`);
  return { name, shared: SHARED_BRANCH.test(name), open: (prs || []).find((p) => p.state === 'open')?.number || null,
    merged: (prs || []).find((p) => p.merged_at)?.number || null };
}
function currentBranch(dir) {
  try { return execFileSync('git', ['-C', dir, 'branch', '--show-current'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; } catch { return null; }
}

// Which working chat a GitHub change came from. srt's proxy can't tell, so narrow it down: chats
// running a step right now, then those whose folder is a clone of the repo it goes to. Only
// when that leaves several does every one of them ask (the first answer counts).
function askingChats(repo) {
  let chats = [...acpChats.values()].filter((c) => c.agent.sandboxed && c.busy);
  const narrow = (f) => { const n = chats.filter(f); if (n.length) chats = n; };
  narrow((c) => c.running.size);
  if (repo) narrow((c) => chatRepos(c).has(repo.toLowerCase()));
  return chats;
}
// Reading GitHub as you, for the gate's checks (lib/github-gate.mjs).
async function ghGet(path) {
  config.github.token ||= await ghCliToken();
  return http(`${config.github.api}${path}`, { headers: { Authorization: `Bearer ${config.github.token}` } });
}
const defaultBranches = new Map();
const githubLook = {
  // Whether a push only adds commits (old is an ancestor of new), asked of a working chat's clone
  // of the repo, where the pushed commits are; null when none of them has both.
  async fastForward(repo, oldSha, newSha) {
    if (!/^[0-9a-f]{40}$/.test(oldSha) || !/^[0-9a-f]{40}$/.test(newSha)) return null;
    for (const dir of cloneDirs(repo)) {
      const code = await new Promise((done) => execFile('git', ['-C', dir, 'merge-base', '--is-ancestor', oldSha, newSha], { timeout: 5000 }, (e) => done(e ? e.code : 0)));
      if (code === 0) return true;
      if (code === 1) return false;
    }
    return null;
  },
  compare: (repo, base, head) => ghGet(`/repos/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`),
  run: (repo, id) => ghGet(`/repos/${repo}/actions/runs/${id}`),
  protected: async (repo, branch) => !!(await ghGet(`/repos/${repo}/branches/${encodeURIComponent(branch)}`)).protected,
  async defaultBranch(repo) {
    if (!defaultBranches.has(repo)) defaultBranches.set(repo, (await ghGet(`/repos/${repo}`)).default_branch);
    return defaultBranches.get(repo);
  },
};

// An everyday GitHub change that went through without asking: a line in the chat that made it.
async function githubTold(what, { repo, nodes = [] } = {}) {
  repo ||= await nodesRepo(nodes);
  const chats = askingChats(repo);
  console.log(`clearsky: GitHub change let through: ${what}`);
  logWrite(agentLogFile, { where: 'github', what, target: repo, chats: chats.map(chatRef), decided: 'auto' });
  for (const c of chats) c.emit({ type: 'note', text: `GitHub: ${what}${chats.length > 1 ? ' (from one of your working chats)' : ''}` });
}

// A GitHub write goes through only to a repo a working chat is on: its clone's remote, the PRs
// it was started about, or one you allowed in it. Others ask.
async function githubScope({ repo, nodes = [] }) {
  repo ||= await nodesRepo(nodes);
  if (!repo) return 'Clearsky couldn\'t tell which repo it changes';
  const r = repo.toLowerCase();
  const chats = [...acpChats.values()].filter((c) => c.agent.sandboxed && c.busy);
  if (gateRules().has(`repo:${r}`)) return null; // you let this repo's everyday changes through (Settings)
  return chats.some((c) => chatRepos(c).has(r)) ? null : `goes to ${repo}, not a repo this chat works on`;
}

// The repo of a GraphQL change, from the ids it names (looked up as you, read only).
async function nodesRepo(ids) {
  if (!ids.length) return null;
  try {
    config.github.token ||= await ghCliToken();
    return repoFromNodes(await gql(NODES_REPO_QUERY, { ids }, { partial: true }));
  } catch { return null; }
}

// Each sandboxed chat's VM (lib/vm.mjs), for `vm <command>`: started on first use, in the git
// checkout (or folder) the command runs in, and stopped with the chat.
let vmImage = null;
async function vmRun({ key, argv, cwd, java, signal }, out, err) {
  const c = chatByKey(key);
  if (!c) throw new Error('this chat is closed');
  const proxy = await sandboxProxy();
  if (!proxy) throw new Error('the sandbox\'s proxy isn\'t running');
  proxy.ca = readFileSync(sandboxCa(join(dirname(stateFile), 'sandbox')).cert, 'utf8'); // the VM trusts it: the proxy reads Docker Hub's HTTPS
  if (c.vm && c.vm.state !== 'off' && cwd !== c.vm.cwd && !cwd.startsWith(`${c.vm.cwd}/`)) {
    c.vm.event(`Moving the VM to ${cwd}`); c.vm.stop(); c.vm = null;
  }
  if (!c.vm || c.vm.state === 'off') {
    let root = cwd;
    try { root = execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || cwd; } catch {}
    vmImage ||= new VmImage({ log: console.log });
    const old = c.vm?.events || [];
    c.vm = new ChatVm({ id: randomBytes(4).toString('hex'), cwd: root, image: vmImage, proxy, hosts: sandboxHosts(), maven: () => vmMaven(c.agent.maven), log: console.log });
    c.vm.images = () => list(process.env.AGENT_VM_IMAGES);
    c.vm.events.push(...old);
    bindVm(c);
  }
  // In line for a VM when other chats' VMs fill the places (Settings → Agent → VMs at the same
  // time): the command, the chat and the VM's view all say where it is.
  const vm = c.vm;
  vm.onStop ||= () => vmQueue.drop(vm, 'this chat\'s VM was stopped while it waited');
  vm.queue ||= () => vmQueue.view(vm);
  const { waited, ms } = await vmQueue.enter(vm, {
    signal,
    evict: () => { vm.event('Stopping the VM: another chat is waiting for one. It starts again on the next vm command'); vm.stop(); },
    notify: ({ position, limit }) => {
      const text = `Waiting for a VM: ${ordinal(position)} in line (${limit} at a time)`;
      vm.event(text);
      err(`Clearsky: ${text}. Other chats' builds run first; this command starts on its own.\n`);
    },
  });
  if (waited) vm.event(`Got a VM after ${Math.round(ms / 1000)}s in line`);
  try {
    return await vm.exec(argv, cwd, out, err, { signal, java: java?.startsWith('/usr/lib/jvm/') ? java : hostJava() });
  } finally { vmQueue.leave(vm); }
}
const vmQueue = new VmQueue();
// Maven's settings for a chat's VM: the sandbox's copy of yours (mirrors, repositories, logins as
// srt's stand-ins), which srt's proxy completes on the way out, as it does for the sandbox.
export function vmMaven(maven, { masked = maskedEnv } = {}) {
  if (!maven?.settings) return null;
  let xml;
  try { xml = readFileSync(maven.settings, 'utf8'); } catch { return null; }
  let trust = null;
  if (maven.trust && maven.credentials?.length) { try { trust = readFileSync(maven.trust); } catch { /* no CA: logins can't be added */ } }
  return { xml, env: masked(maven.credentials || []), trust, unmatched: maven.unmatched || [] };
}

// ---------------------------------------------------------------- background jobs and the watchdog
// Chats stopped on long tasks: a turn that waits on a 20-minute build or a CI run runs into its
// limits, or Copilot gives up on the wait. So a long command runs as a background job
// (lib/jobs.mjs, `bg <command>`), the chat ends its turn, and Clearsky wakes it with the result.
// And a chat that stops before its task is done gets a nudge to go on (lib/watchdog.mjs).
const jobGroups = new Set(); // process groups of jobs running here, ended with Clearsky
process.on('exit', () => { for (const pid of jobGroups) { try { process.kill(-pid, 'SIGTERM'); } catch {} } });
// Run a command in its own process group, its output to out/err, until it ends or `signal` stops it.
function spawnJob(bin, args, { cwd, env, signal, hours = 4, onPid = null }, out, err) {
  return new Promise((done) => {
    const child = spawn(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    if (child.pid) { jobGroups.add(child.pid); onPid?.(child.pid); }
    const kill = () => { try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM'); else child.kill('SIGTERM'); } catch {} };
    const timer = setTimeout(() => { err(`\nClearsky: stopped after ${hours} hours.\n`); kill(); }, hours * 36e5);
    signal?.addEventListener('abort', () => { err('\nClearsky: stopped.\n'); kill(); }, { once: true });
    child.stdout.on('data', (d) => out(d));
    child.stderr.on('data', (d) => err(d));
    child.on('error', (e) => { err(`${e.message}\n`); });
    child.on('close', (code) => { clearTimeout(timer); jobGroups.delete(child.pid); done(code ?? 1); });
  });
}
// A short command (git) in a chat's sandbox, with execFile's shape: for what Clearsky runs in a
// folder the chat can write, where git would run programs the chat names (lib/safe-git.mjs).
const sandboxRun = (c) => async (bin, args, opts = {}) => {
  if (!c?.agent?.inSandbox || c.agent.closed) throw new Error('this chat\'s sandbox has stopped');
  const dir = args[0] === '-C' && isDir(args[1]) ? args[1] : c.cwd;
  const s = await c.agent.inSandbox([bin, ...args], dir);
  try { return await execFileP(s.bin, s.args, { ...opts, env: s.env, cwd: dir }); } finally { sandboxEnded(); }
};
// Background jobs running in a chat's sandbox: pid → chat, for the VMs view's sandbox load.
const sandboxJobs = new Map();
// Where a job runs is the fence of the chat that started it.
async function runJob(job, out, err, signal) {
  const c = acpChats.get(job.chat);
  if (job.where === 'vm') return vmRun({ key: c?.agent.brokerKey, argv: job.argv, cwd: job.cwd, java: job.java, signal }, out, err);
  if (job.where === 'outside') return spawnJob(job.argv[0], job.argv.slice(1), { cwd: job.cwd, env: copilotEnv(), signal }, out, err);
  if (!c?.agent.inSandbox) throw new Error('this chat\'s sandbox has stopped');
  const s = await c.agent.inSandbox(job.argv, job.cwd);
  let pid = null;
  try { return await spawnJob(s.bin, s.args, { cwd: job.cwd, env: s.env, signal, onPid: (p) => { pid = p; sandboxJobs.set(p, job.chat); } }, out, err); } finally { sandboxJobs.delete(pid); sandboxEnded(); }
}
const jobs = new Jobs({ file: join(dirname(stateFile), 'jobs.json'), logDir: () => join(copilotTmp(), 'jobs'), run: runJob, onEnd: jobEnded });
function jobEnded(job) {
  console.log(`clearsky: background job ${job.where} -> ${job.state}${job.code != null ? ` (exit ${job.code})` : ''}`);
  const c = acpChats.get(job.chat);
  c?.emit({ type: 'note', text: `Job ${job.id} ${job.state === 'done' ? 'finished' : job.state}: ${shellLine(job.argv).slice(0, 120)}` });
  tellChat(job.chat, `${AUTO_MARK}${jobReport(job, jobs.tail(job.id, 40, 16 * 1024), { tilde: tildeHome })}`, { ...job.ctx, onSent: () => jobs.told(job.id) });
}
// The `bg` and `jobs` doors (lib/broker.mjs, scripts/sandbox-bin/bg and jobs).
function jobsDoor({ key, tool, where, argv, cwd, java }) {
  const c = chatByKey(key);
  if (!c) return { code: 1, stdout: '', stderr: 'Clearsky: this chat is closed.\n' };
  if (tool === 'bg') {
    const job = jobs.start({ chat: c.id, where, argv, cwd, ctx: { options: c.options, cwd: c.cwd } });
    if (java?.startsWith('/usr/lib/jvm/')) job.java = java;
    c.emit({ type: 'note', text: `Job ${job.id} started ${where === 'sandbox' ? 'in the sandbox' : where === 'vm' ? 'in the VM' : 'outside the sandbox'}: ${shellLine(argv).slice(0, 120)}` });
    return { code: 0, stderr: '', stdout: `Started background job ${job.id}. Its output goes to ${tildeHome(job.log)}.\n`
      + 'End your turn now (say what you are waiting for): Clearsky wakes you in this chat with the result when it ends. '
      + `Meanwhile \`jobs log ${job.id}\` shows its output so far; don't wait for it with sleep.\n` };
  }
  const [cmd = 'list', id, n] = argv;
  if (cmd === 'list' || cmd === 'ls') {
    const mine = jobs.list(c.id).slice(0, 15);
    return { code: 0, stderr: '', stdout: mine.length ? `${mine.map((j) => { const v = jobView(j); return `${j.id}  ${v.state}${j.code != null ? ` (exit ${j.code})` : ''}  ${j.where}  ${Math.round(v.ms / 1000)}s  ${v.command}`; }).join('\n')}\n` : 'No background jobs in this chat.\n' };
  }
  const job = id && jobs.get(id);
  if (!job || job.chat !== c.id) return { code: 1, stdout: '', stderr: `Clearsky: no job ${id || ''} in this chat (\`jobs\` lists them).\n` };
  if (cmd === 'log') return { code: 0, stderr: '', stdout: `${tailOf(job.log, Math.min(Math.max(Number(n) || 60, 1), 2000), 512 * 1024)}\n` };
  if (cmd === 'stop') return jobs.stop(job.id) ? { code: 0, stderr: '', stdout: `Stopping ${job.id}.\n` } : { code: 1, stdout: '', stderr: `Clearsky: ${job.id} isn't running.\n` };
  return { code: 2, stdout: '', stderr: 'usage: jobs [list] | jobs log <id> [lines] | jobs stop <id>\n' };
}

// Messages Clearsky sends a chat on its own (a job's result, a nudge): one turn at a time, after
// the chat's own; a chat whose Copilot closed meanwhile is resumed, as your next message would.
const autoInbox = new Map(); // chat → [{ text, ctx }]
const autoBusy = new Set();
function tellChat(id, text, ctx = {}) {
  autoInbox.set(id, [...(autoInbox.get(id) || []), { text, ctx }]);
  setImmediate(() => pumpChat(id));
}
async function pumpChat(id) {
  const c = acpChats.get(id);
  if (autoBusy.has(id) || c?.busy || c?.waiting.size || startingChats.has(id)) return; // its turn's end comes back here
  const q = autoInbox.get(id);
  if (!q?.length) return;
  autoInbox.delete(id);
  const ctx = Object.assign({}, ...q.map((x) => x.ctx));
  const options = c?.options || ctx.options, cwd = c?.cwd || ctx.cwd;
  if (!options || !cwd || !isDir(cwd)) { console.log('clearsky: a chat to wake has no mode or folder any more; left for its next message'); return; }
  autoBusy.add(id);
  try {
    const info = await copilotInfo();
    if (!info.available) throw new Error('Copilot CLI not found');
    // A chat that goes on in a new Copilot gets the sandbox's rules again, as for your message.
    const hint = sandboxHintFor(options.permission);
    const owed = hint && (!c || c.agent.closed || hintOwed.has(id));
    hintOwed.delete(id);
    const message = q.map((x) => x.text).join('\n\n');
    const prompt = owed ? `${UPDATE_INTRO}${hint}${MSG_MARK}${message}` : message;
    forgetSessions();
    // Nobody watches yet: an open page sees the chat working and follows it (attachCopilot).
    await acpTurn({ chat: id, options, prompt, resumeId: id, cwd, emit: () => {}, res: { on() {} }, bin: info.bin, auto: true });
    for (const x of q) x.ctx.onSent?.();
  } catch (e) {
    console.log(`clearsky: waking a chat didn't work: ${e.message}`);
  } finally { autoBusy.delete(id); }
  setImmediate(() => pumpChat(id));
}

const watchdog = new Watchdog();
// A turn ended: Clearsky's own messages go first; then a chat with a job running waits for it;
// else the watchdog looks at how the turn ended.
function afterTurn(c, { stopReason, error, command }) {
  const id = c.id;
  if (autoInbox.get(id)?.length) { setImmediate(() => pumpChat(id)); return; }
  if (command || jobs.running(id).length) return;
  const reason = watchdog.turnEnded(id, { stopReason, error: error?.message || null, text: c.turnText, stuck: c.stuck, stopped: c.userStopped });
  const w = watchdog.view(id);
  if (reason) c.emit({ type: 'note', text: `Watchdog: ${NUDGE_REASONS[reason]}. Nudging it to go on ${reason === 'stuck' ? 'now' : `in ${w.minutes} min`} unless you write first (${w.nudges + 1} of ${w.max}).` });
  else if (w.gaveUp) c.emit({ type: 'note', text: `Watchdog: still not finished after ${w.max} nudges; over to you.` });
}
// Every 15 seconds: a turn with nothing running and no word for long is stopped (and so nudged);
// due nudges go out to chats that are free.
setInterval(() => {
  const cfg = watchdogSettings();
  if (!cfg.nudges) return;
  for (const c of acpChats.values()) {
    if (c.busy && !c.stuck && !c.waiting.size && !c.running.size && Date.now() - (c.lastEvent || Date.now()) > cfg.stuckMinutes * 6e4) {
      console.log('clearsky: watchdog: a turn had no word and nothing running, stopping it');
      c.stuck = true;
      c.agent.cancel();
    }
  }
  const free = (id) => { const c = acpChats.get(id); return !!c && !c.agent.closed && !c.busy && !c.waiting.size && !jobs.running(id).length && !autoInbox.get(id)?.length; };
  for (const { id, reason, n, max } of watchdog.due(free)) {
    logEvent(`watchdog nudged a chat (${reason}, ${n} of ${max})`, { echo: false });
    tellChat(id, nudgeText(reason, n, max));
  }
}, 15_000).unref();
// Every chat's VM that runs or waits, running ones first (oldest first), then the line in order.
async function vmsOverview({ look = true } = {}) {
  const snap = vmQueue.snapshot();
  const names = localState.sessionNames(stateFile), titles = new Map((sessionsCache?.data || []).map((x) => [x.id, x.title]));
  const tilde = (p) => (p && p.startsWith(homedir()) ? `~${p.slice(homedir().length)}` : p);
  const held = new Map(snap.holders.map((h) => [h.holder, h])), line = new Map(snap.line.map((w) => [w.holder, w]));
  const chats = [...acpChats].filter(([, c]) => c.vm && (c.vm.state !== 'off' || held.has(c.vm) || line.has(c.vm)));
  if (look) await Promise.all(chats.map(([, c]) => c.vm.refresh())); // ssh into each: only while the view is open
  const vms = chats.map(([id, c]) => {
    const v = c.vm.view(), h = held.get(c.vm), w = line.get(c.vm);
    return { chat: id, title: names[id] || titles.get(id) || null, state: v.state, place: w ? 'waiting' : h ? 'running' : v.state === 'off' ? 'off' : 'running',
      position: w?.position ?? null, busy: !!h?.active, since: new Date(w?.since ?? h?.since ?? (Date.parse(v.startedAt) || Date.now())).toISOString(),
      startedAt: v.startedAt, cwd: tilde(v.cwd), commands: v.commands, vcpus: v.vcpus, memMb: v.memMb, diskBytes: v.diskBytes, system: v.system, containers: v.containers };
  }).sort((a, b) => (a.place === 'waiting') - (b.place === 'waiting') || (a.position ?? 0) - (b.position ?? 0) || Date.parse(a.since) - Date.parse(b.since));
  return { limit: snap.limit, running: snap.holders.length, waiting: snap.line.length, vms, sandboxes: sandboxesLoad(names, titles), builds: buildsWhere(),
    imageCache: imageCacheView(), host: { cpus: availableParallelism(), memMb: Math.floor(totalmem() / 1048576) } };
}
// The VMs' Docker Hub image cache (lib/registry-mirror.mjs): what's in it, looked at most every
// 15 seconds (the VMs view asks every 3).
const IMAGE_CACHE_DIR = join(homedir(), '.cache', 'clearsky', 'vm', 'registry');
let imageCacheSeen = null;
function imageCacheView(fresh = false) {
  if (fresh || !imageCacheSeen || Date.now() - imageCacheSeen.at > 15_000) imageCacheSeen = { at: Date.now(), ...mirrorStats(IMAGE_CACHE_DIR) };
  const { at, ...s } = imageCacheSeen;
  return { ...s, capBytes: cacheCapBytes() };
}
// What chats' sandboxes run on this machine itself (Linux): the sandbox fences files and network,
// not CPU, so a build run there instead of in the VM shows here, with its busiest process.
const treeLoad = new TreeLoad();
function sandboxesLoad(names, titles) {
  if (process.platform !== 'linux') return [];
  const roots = new Map();
  for (const [id, c] of acpChats) if (c.agent?.sandboxed && !c.agent.closed && c.agent.child?.pid) roots.set(`${id}\t${c.agent.child.pid}`, c.agent.child.pid);
  for (const [pid, id] of sandboxJobs) roots.set(`${id}\t${pid}`, pid);
  const per = new Map();
  for (const [key, l] of treeLoad.sample(roots)) {
    const id = key.split('\t')[0], a = per.get(id) || { chat: id, title: names[id] || titles.get(id) || null, cpuPct: null, memMb: 0, procs: 0, top: null, jobs: 0 };
    if (l.cpuPct != null) a.cpuPct = (a.cpuPct || 0) + l.cpuPct;
    a.memMb += l.memMb; a.procs += l.procs;
    if (l.top && (!a.top || l.top.cpuPct > a.top.cpuPct)) a.top = l.top;
    if (sandboxJobs.has(Number(key.split('\t')[1]))) a.jobs++;
    per.set(id, a);
  }
  return [...per.values()].sort((a, b) => (b.cpuPct || 0) - (a.cpuPct || 0));
}
const ordinal = (n) => `${n}${[, 'st', 'nd', 'rd'][n % 100 >> 3 ^ 1 && n % 10] || 'th'}`;
// VM events show in the chat as they happen (commands and containers; the rest is in its view).
function bindVm(c) {
  const shown = { vm: /^(VM up|Docker ready|Stopping|The VM stopped|Preparing|Downloading|VM image|Waiting for a VM|Got a VM)/, docker: /^(start|die|oom) /, run: /^(done|failed|Stopped)/ };
  // Containers stopped after the tests (Testcontainers kills them: exit 137, its reaper exits 0)
  // are cleanup, not a crash: one quiet line for them all. Other exits show as they happen.
  let stopped = 0, timer = null;
  const cleanup = () => { if (stopped) c.emit({ type: 'note', text: `VM: ${stopped} test container${stopped > 1 ? 's' : ''} stopped` }); stopped = 0; timer = null; };
  if (c.vm) c.vm.onEvent = (e) => {
    if (e.kind === 'docker' && /^die .*, exit (137|143)$|^die [^,]*$|^die .*, exit 0$/.test(e.text)) { stopped++; clearTimeout(timer); timer = setTimeout(cleanup, 2000); return; }
    if (shown[e.kind]?.test(e.text)) c.emit({ type: 'note', text: `VM: ${e.text}` });
  };
}
// Your default JDK (what `java` is here) for the VM, which has your /usr/lib/jvm in place of its
// own; else the newest one in there.
let defaultJava;
function hostJava() {
  if (defaultJava === undefined) {
    try { defaultJava = realpathSync(execFileSync('sh', ['-c', 'command -v java'], { encoding: 'utf8', timeout: 3000 }).trim()).replace(/\/bin\/java$/, ''); } catch { defaultJava = null; }
    if (!defaultJava?.startsWith('/usr/lib/jvm/')) {
      try { defaultJava = readdirSync('/usr/lib/jvm').filter((d) => existsSync(`/usr/lib/jvm/${d}/bin/java`)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).map((d) => `/usr/lib/jvm/${d}`).pop() || null; } catch { defaultJava = null; }
    }
  }
  return defaultJava;
}
const sandboxHosts = () => [...new Set([...(process.env.AGENT_DOMAINS ? parseDomains(process.env.AGENT_DOMAINS) : DEFAULT_DOMAINS), ...VM_DOMAINS])];

// Which Jira tickets and projects an acli command changes; `bulk` when it picks them by a query.
export function jiraTargets(argv) {
  const keys = new Set(), projects = new Set();
  let bulk = false;
  argv.forEach((a, i) => {
    if (/^--(jql|filter)(=|$)/.test(a)) bulk = true;
    const v = a.includes('=') && a.startsWith('--') ? a.slice(a.indexOf('=') + 1) : a;
    const flag = a.startsWith('--') ? a.split('=')[0] : argv[i - 1];
    if (/^(--project|-p)$/.test(flag) && /^[A-Z][A-Z0-9_]+$/.test(v)) projects.add(v);
    for (const k of v.split(',')) if (/^[A-Z][A-Z0-9_]+-\d+$/.test(k.trim())) { keys.add(k.trim()); projects.add(k.trim().split('-')[0]); }
  });
  return { keys: [...keys], projects: [...projects], bulk };
}
// The Jira projects this chat works in: its tickets, and the one its branch is named after.
function chatJira(c) {
  const set = new Set(c.jira);
  for (const k of localState.sessionRefs(stateFile)[c.id] || []) if (k.startsWith('issue:')) set.add(k.slice(6).split('-')[0]);
  try {
    const branch = execFileSync('git', ['-C', c.cwd, 'branch', '--show-current'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
    for (const m of branch.toUpperCase().matchAll(/\b([A-Z][A-Z0-9_]+)-\d+\b/g)) set.add(m[1]);
  } catch {}
  return set;
}

function brokerWhere(key) {
  const c = chatByKey(key);
  return c && [c.cwd, ...copilotFolders().map((d) => untilde(d)), ...chatFolders(c.id)];
}
// Ask in the chat, as for any step Copilot wants to take, and wait for your answer.
function brokerAsk({ key, tool, argv, cwd, vm = false, background = false }) {
  const c = chatByKey(key);
  if (!c) return Promise.resolve(false);
  const line = [tool, ...argv].map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ');
  const jira = tool === 'acli' ? jiraTargets(argv) : null;
  const log = (decided) => jira && logWrite(agentLogFile, { where: 'jira', what: line, target: jira.keys.join(', ') || jira.projects.join(', ') || null, chats: [chatRef(c)], decided });
  if (c.mode === 'full') { log('allowed'); return Promise.resolve(true); } // Full: you allowed everything
  // A Jira change to the tickets of this chat's project goes through, and shows in the chat.
  if (jira && !jira.bulk && jira.projects.length && jira.projects.every((p) => chatJira(c).has(p) || gateRules().has(`jira:${p}`))) {
    log('auto');
    c.emit({ type: 'note', text: `Jira: ${line}` });
    return Promise.resolve(true);
  }
  const title = { git: 'Push from your machine', gh: 'Change GitHub as you', acli: 'Change Jira as you', outside: `Run on your machine, outside the sandbox${background ? ', in the background' : ''}` }[tool];
  return new Promise((done) => {
    const id = randomBytes(6).toString('hex');
    // The same command again (a test run after a fix) can be allowed for the rest of this chat.
    const same = `${cwd}\n${line}`;
    if (c.allowedRuns?.has(same)) return done(true);
    const advice = jira ? jiraAdvice(jira, chatJira(c)) : tool === 'outside' ? outsideAdvice({ vm }) : null;
    const ev = { type: 'permission', id, title, kind: 'execute', detail: `${line}\n(in ${cwd.replace(homedir(), '~')})`, advice,
      options: [...(vm ? [{ id: 'vm', name: 'Run in the VM instead', kind: 'allow_once' }] : []), { id: 'allow', name: 'Allow', kind: 'allow_once' },
        ...(jira ? ruleOption(advice) : [{ id: 'chat', name: 'Allow this command again in this chat', kind: 'allow_always' }]), { id: 'deny', name: 'Deny', kind: 'reject_once' }] };
    c.waiting.set(id, (answer) => {
      c.pending.delete(id);
      if (answer.optionId === 'rule' && advice?.rule) { addGateRule(advice.rule); answer = { ...answer, optionId: 'allow' }; }
      if (answer.optionId === 'chat') (c.allowedRuns ||= new Set()).add(same);
      if (answer.optionId === 'vm') return done('vm');
      const ok = answer.optionId === 'allow' || answer.optionId === 'chat';
      log(ok ? 'allowed' : 'declined');
      // Allowed here: that ticket's project is part of this chat's work from now on.
      if (ok && jira && !jira.bulk) for (const p of jira.projects) c.jira.add(p);
      done(ok);
    });
    c.pending.set(id, ev);
    c.emit(ev);
  });
}

function pluginDoor(name) {
  const found = doorsByName().get(name);
  return found ? (req) => doorRun(found, req) : null;
}
async function doorRun({ p, door }, { key, name, argv }) {
  const c = chatByKey(key);
  if (!c) return { code: 1, stdout: '', stderr: 'Clearsky: this chat is closed.\n' };
  const line = [name, ...argv].map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ');
  const log = (decided, extra = {}) => logWrite(agentLogFile, { where: name, door: p.name, what: line, chats: [chatRef(c)], decided, ...extra });
  if (p.enabled && !p.enabled(process.env)) { log('not set up'); return { code: 1, stdout: '', stderr: `Clearsky: ${p.label} isn't set up yet (Settings → Plugins → ${p.label}).\n` }; }
  const ctx = {
    env: makeContext(p).env, chat: { mode: c.mode },
    ask: ({ title, detail = line, advice } = {}) => askInChat(c, { title: String(title || `${name} as you`), detail, ...(advice && { advice }) }),
    vpn: () => vpn.check(),
  };
  try {
    const r = (await door.run(argv, ctx)) || {};
    const { text, removed } = redact(String(r.stdout ?? ''));
    const max = 200_000, cut = text.length > max;
    log(r.decided || (r.code ? 'failed' : 'ran'), { target: r.target || null, removed });
    return { code: Number.isInteger(r.code) ? r.code : 0, stdout: text ? `${cut ? text.slice(-max) : text}${text.endsWith('\n') ? '' : '\n'}` : '',
      stderr: `${r.stderr || ''}${removed ? `(Clearsky removed ${removed} secret${removed > 1 ? 's' : ''} from this output)\n` : ''}${cut ? '(output cut to its last 200k characters: narrow the query)\n' : ''}` };
  } catch (e) {
    log('failed');
    return { code: 1, stdout: '', stderr: `${name}: ${e.message}\n` };
  }
}
// `review …` from a chat (lib/review.mjs): a proper review by a fresh Copilot, in its own
// sandbox, that gets only the goal and the code. Clearsky works out the diff and reads the
// ticket itself, so nothing of the asking chat (its history, its reasoning) goes along. The
// reviewer may read files in the repo and nothing else: no shell, no edits, no web, no MCPs.
async function reviewRun({ key, argv, cwd, signal }, out, err) {
  const c = chatByKey(key);
  if (!c) { err('Clearsky: this chat is closed.\n'); return 1; }
  const o = parseReviewArgs(argv);
  if (o.help) { out(`${REVIEW_USAGE}\n`); return 0; }
  if (o.error) { err(`review: ${o.error}\n\n${REVIEW_USAGE}\n`); return 2; }
  // git reads the chat's repo inside the chat's sandbox: the repo's settings are the chat's to
  // write, and a diff runs the programs they name (lib/safe-git.mjs).
  const run = sandboxRun(c);
  const root = String((await run('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { timeout: 10_000 }).catch(() => ({ stdout: '' }))).stdout).trim();
  if (!root) { err('review: not in a git repository\n'); return 1; }
  const log = (decided, extra = {}) => logWrite(agentLogFile, { where: 'review', what: ['review', ...argv].join(' '), target: root.replace(homedir(), '~'), repo: [...(gitRepos(root) || [])][0] || null, chats: [chatRef(c)], decided, ...extra });
  let change, ticket = null;
  try { change = await changeOf(root, o.base, { run }); } catch (e) { err(`review: ${e.message}\n`); return 1; }
  if (o.ticket) {
    try { ticket = await ticketGoal(o.ticket); } catch (e) { err(`review: couldn't read ${o.ticket} (${e.message}); use --goal instead\n`); return 1; }
  }
  // The reviewer runs in the same agent as the chat that asks.
  const rb = backend(c?.agentName);
  if (!rb.find()) { err(`review: ${rb.product} isn't found\n`); return 1; }
  err(`Clearsky: a fresh reviewer is reading ${change.branch || 'the change'} against ${change.base}${ticket ? ` for ${ticket.key}` : ''} (it sees only the goal and the code). This takes a few minutes.\n`);
  const model = process.env.AGENT_REVIEW_MODEL || process.env.AGENT_MODEL || undefined;
  const args = rb.args({ permission: 'read', model, deny: ['url'] });
  // The changed files as they were before, in a folder the reviewer's sandbox can read.
  const baseDir = join(copilotTmp(), 'review', randomBytes(6).toString('hex'));
  const baseFiles = await writeBaseFiles(root, change, baseDir, { run }).catch(() => []);
  const roots = [root, ...(baseFiles.length ? [baseDir] : [])];
  const agent = await startAgent(null, args, root, { sandbox: true, permission: 'read', model, agent: rb.name });
  const tally = { allowed: 0, denied: 0 };
  const refused = [];
  // Copilot ends its whole turn ("Operation cancelled by user") when a tool call is refused, so
  // each refusal is said in the asking chat, and the reviewer is told to carry on without it.
  agent.onPermission = async (p) => {
    const once = (p.options || []).find((x) => x.kind === 'allow_once');
    const no = (p.options || []).find((x) => x.kind === 'reject_once');
    const d = reviewDecision(p, roots);
    const ok = once && d.ok;
    tally[ok ? 'allowed' : 'denied']++;
    if (!ok) { refused.push(d.what); err(`Clearsky: the reviewer asked to ${d.what}; it may only read this repo, so that was refused.\n`); }
    return ok ? { outcome: 'selected', optionId: once.optionId } : no ? { outcome: 'selected', optionId: no.optionId } : { outcome: 'cancelled' };
  };
  let text = '', steps = 0;
  agent.onUpdate = (u) => {
    if (u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text') text += u.content.text;
    if (u.sessionUpdate === 'tool_call') { steps++; if (steps % 10 === 0) err(`Clearsky: the reviewer has read ${steps} things so far…\n`); }
  };
  const stop = () => agent.close();
  signal?.addEventListener('abort', stop);
  const timer = setTimeout(stop, 20 * 6e4);
  const verdictOf = (t) => t.match(/VERDICT:\s*(ready|fix first)/i)?.[1]?.toLowerCase() || null;
  let reviewer = null;
  try {
    const id = await agent.start(root);
    reviewer = id;
    localState.setSessionName(stateFile, id, `Review: ${change.branch || 'change'} against ${change.base}`);
    forgetSessions();
    await agent.prompt(reviewPrompt({ goal: o.goal, ticket, change, baseDir, baseFiles }));
    // Cut short by a refusal: tell it what it can read and let it finish, at most twice.
    for (let round = 0; round < 2 && !verdictOf(text) && refused.length && !agent.closed && !signal?.aborted; round++) {
      const seen = refused.length;
      text += '\n';
      await agent.prompt(`That was refused: you asked to ${refused.at(-1)}. You may only read and search files in ${roots.join(' and ')}; no commands, no git, no other folders.${baseFiles.length ? ` The changed files as they were before are in ${baseDir}.` : ''} Carry on with the review from what you can read, and finish with the VERDICT line.`);
      if (refused.length === seen) break;
    }
    const findings = text.trim();
    const verdict = verdictOf(findings);
    log('reviewed', { verdict, steps, ...tally, session: reviewer });
    console.log(`clearsky: review ${verdict || 'no verdict'}, ${steps} steps, ${tally.allowed} allowed, ${tally.denied} denied`);
    if (!verdict && refused.length) {
      out(`${findings ? `${findings}\n\n` : ''}The review didn't finish. The reviewer kept asking for things outside what it may read (${[...new Set(refused)].slice(0, 3).join('; ')}). Run review again; if it happens again, tell the user.\n`);
      return 1;
    }
    out(`${findings || 'The reviewer gave no answer.'}\n`);
    if (change.cut) err('(the diff was long, so the reviewer read the rest from the repo)\n');
    return 0;
  } catch (e) {
    log('failed', { session: reviewer });
    err(`review: ${signal?.aborted ? 'stopped' : e.message}\n`);
    return 1;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
    agent.close();
    try { rmSync(baseDir, { recursive: true, force: true }); } catch { /* gone */ }
  }
}

// The last looked-up dollar rate (Settings → Agent, live rate), without asking again.
function readFx() {
  if (process.env.CLEARSKY_FX_LIVE !== 'on') return null;
  try { return JSON.parse(readFileSync(join(homedir(), '.cache', 'clearsky', 'fx.json'), 'utf8')); } catch { return null; }
}

// What a chat's work cost, split the way a ticket records it: the chat itself (implementation)
// and the reviewers it ran with `review` (code review), each from its own session log.
function chatCredits(id, model = null) {
  const home = join(homedir(), '.copilot');
  const ok = (x) => /^[\w-]{8,64}$/.test(x || '');
  const reviews = readWrites(agentLogFile, { chat: id, limit: 3000 }).filter((e) => e.where === 'review' && ok(e.session)).map((e) => e.session);
  return creditSplit([
    { kind: 'implementation', usage: ok(id) ? sessionUsage(home, id) : null, model },
    ...[...new Set(reviews)].map((r) => ({ kind: 'code review', usage: sessionUsage(home, r), model: process.env.AGENT_REVIEW_MODEL || null })),
  ]);
}

// `usage` from a chat: the line for the end of its PR description (lib/disclosure.mjs), from
// the chats' own session logs; `usage --fields` gives it as Jira field values too. Only when
// you switched it on in Settings → Agent.
function usageRun({ key, argv = [] }) {
  const c = chatByKey(key);
  if (!c) return { code: 1, stdout: '', stderr: 'Clearsky: this chat is closed.\n' };
  if (c.agentName !== 'copilot') return { code: 1, stdout: '', stderr: `Clearsky: usage is only counted for Copilot chats so far, not ${backend(c.agentName).label}; leave the line out.\n` };
  if (process.env.AGENT_DISCLOSE !== 'on') return { code: 1, stdout: '', stderr: 'Clearsky: saying what did the work is off (Settings → Agent); leave the line out.\n' };
  const split = chatCredits(c.id, c.model);
  return { code: 0, stdout: `${argv.includes('--fields') ? disclosureFields(split) : disclosureLine(split)}\n`, stderr: '' };
}

// A question in a chat with Allow and Deny only (asked every time).
function askInChat(c, { title, detail, advice = null }) {
  return new Promise((done) => {
    const id = randomBytes(6).toString('hex');
    const ev = { type: 'permission', id, title, kind: 'execute', detail, advice,
      options: [{ id: 'allow', name: 'Allow', kind: 'allow_once' }, { id: 'deny', name: 'Deny', kind: 'reject_once' }] };
    c.waiting.set(id, (answer) => { c.pending.delete(id); done(answer.optionId === 'allow'); });
    c.pending.set(id, ev);
    c.emit(ev);
  });
}

// One prompt and its answer, changing nothing: the stand-up summary with Claude Code (Copilot
// has `-p` for that).
async function oneShot(bin, prompt, { model, timeoutMs = 120_000 } = {}) {
  const b = backend();
  const agent = await startAgent(bin, b.args({ permission: 'read', model }), copilotCwd(), { permission: 'read', model, agent: b.name });
  let text = '';
  agent.onUpdate = (u) => { if (u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text') text += u.content.text; };
  const timer = setTimeout(() => agent.close(), timeoutMs);
  try { await agent.start(copilotCwd()); await agent.prompt(prompt); } finally { clearTimeout(timer); agent.close(); }
  if (!text.trim()) throw new Error(`${b.label} gave no answer`);
  return text.trim();
}

// A short-lived agent process (`name`, the default one if null), for listing or reading sessions.
async function withAgent(name, fn) {
  const agent = await startAgent(null, [], copilotCwd(), { agent: name });
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

// A session started here is named after the dashboard and items Clearsky put in front of
// your message; show what you typed instead (and never match PRs or tickets on the rest).
export function sessionTitle(title, typed) {
  if (!title || !(title.startsWith(CONTEXT_INTRO.slice(0, 30)) || title.startsWith(REFS_INTRO))) return title || null;
  const own = typed || (title.includes(MSG_MARK) ? typedPart(title) : '');
  return own.trim().split('\n')[0].slice(0, 120) || 'Chat from Clearsky';
}

// Sessions of every agent installed here, each with the agent it belongs to. One agent that
// can't list them doesn't hide the other's (unless it's the only one).
async function copilotSessions(_bin, force) {
  if (!force && sessionsCache && Date.now() - sessionsCache.at < 30_000) return withStatus(sessionsCache.data);
  const names_ = installedAgents();
  const lists = await Promise.allSettled(names_.map((n) => withAgent(n, (a) => a.listSessions()).then((l) => l.map((x) => ({ ...x, agent: n })))));
  if (lists.every((x) => x.status === 'rejected')) throw lists[0].reason;
  const list = lists.flatMap((x) => (x.status === 'fulfilled' ? x.value : []));
  const titles = localState.sessionTitles(stateFile), names = localState.sessionNames(stateFile);
  const data = list.map((x) => ({ id: x.sessionId, agent: x.agent, title: names[x.sessionId] || sessionTitle(x.title, titles[x.sessionId]), cwd: x.cwd || null, updatedAt: x.updatedAt || null }))
    .sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));
  keepSessions(data);
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
      : jobs.running(x.id).length ? 'background' : c || open[x.id] ? 'waiting' : 'closed';
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
  // Copilot's session log (lib/copilot-events.mjs).
  const events = new Map(recent.filter((x) => x.agent === 'copilot' && Date.now() - (Date.parse(x.updatedAt) || 0) < 14 * 864e5).map((x) => [x.id, sessionEvents(copilotHome(), x.id)]));
  const cwdOf = new Map(recent.map((x) => [x.id, x.cwd]));
  const workspace = (id) => { const ws = workspaceInfo(id, cwdOf.get(id)); return { ...ws, branches: [...new Set([...(events.get(id)?.branches || []), ws.branch].filter(Boolean))] }; };
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

async function copilotHistory(_bin, id, cwd) {
  const messages = await withAgent(sessionAgent(id), (a) => a.history(id, cwd));
  for (const m of messages) if (m.role === 'me') m.text = typedPart(m.text);
  // Copilot replays steps without times; its log has them.
  const { times = {} } = (sessionAgent(id) || backend().name) === 'copilot' ? sessionEvents(copilotHome(), id) : {};
  for (const m of messages) for (const g of m.segs || []) if (g.type === 'tool' && times[g.id]) Object.assign(g, times[g.id]);
  return messages;
}

function toolDetail(call = {}) {
  const input = call.rawInput;
  if (!input || typeof input !== 'object') return '';
  const text = input.command || input.path || input.url || JSON.stringify(input);
  return String(text).slice(0, 400);
}

// Files a chat creates or edits, for its Outputs: the paths only, when the step went through.
function noteFiles(c, u) {
  if (u.sessionUpdate === 'tool_call' && ['edit', 'delete', 'move'].includes(u.kind)) {
    const paths = [...(u.locations || []).map((l) => l?.path), u.rawInput?.path, u.rawInput?.file_path].filter((x) => typeof x === 'string' && x.startsWith('/'));
    if (paths.length) (c.fileCalls ||= new Map()).set(u.toolCallId, { paths: [...new Set(paths)], kind: u.kind });
    return;
  }
  const f = c.fileCalls?.get(u.toolCallId);
  if (!f || u.sessionUpdate !== 'tool_call_update') return;
  if (Array.isArray(u.locations)) for (const l of u.locations) if (typeof l?.path === 'string' && l.path.startsWith('/') && !f.paths.includes(l.path)) f.paths.push(l.path);
  if (!['completed', 'failed'].includes(u.status)) return;
  c.fileCalls.delete(u.toolCallId);
  if (u.status !== 'completed') return;
  for (const path of f.paths.slice(0, 20)) logWrite(agentFilesFile, { where: 'file', what: path, kind: f.kind === 'delete' ? 'deleted' : 'wrote', chats: [chatRef(c)], decided: 'done' });
}

// Builds and test runs in a chat, for its map (lib/map.mjs): the command, how it ended and how
// long it took, logged like the agent's writes. Nothing else about the step is kept.
function noteBuild(c, u) {
  const cmd = u.rawInput?.command;
  if (u.sessionUpdate === 'tool_call' && u.kind === 'execute' && typeof cmd === 'string') {
    const kind = buildKind(cmd);
    if (kind) (c.builds ||= new Map()).set(u.toolCallId, { cmd: redact(cmd.replace(/\s+/g, ' ').trim().slice(0, 200)).text, kind, at: Date.now() });
    return;
  }
  const b = c.builds?.get(u.toolCallId);
  if (!b || u.sessionUpdate !== 'tool_call_update' || !['completed', 'failed'].includes(u.status)) return;
  c.builds.delete(u.toolCallId);
  logWrite(agentLogFile, { where: 'build', what: b.cmd, kind: b.kind, target: c.cwd.replace(homedir(), '~'), repo: [...(gitRepos(c.cwd) || [])][0] || null,
    chats: [chatRef(c)], decided: u.status === 'completed' ? 'passed' : 'failed', ms: Date.now() - b.at });
}

const startingChats = new Map(); // chat → while its Copilot starts
async function acpTurn({ chat, options, prompt, resumeId, cwd, emit, res, bin, scope = [], auto = false, agent: agentPick = null }) {
  // One turn at a time in a chat: a message that comes while Clearsky's own turn runs (a job's
  // result, a nudge), or while the chat's Copilot starts, waits for it.
  for (;;) {
    const b = acpChats.get(chat);
    if (b?.busy) { await b.turnDone; continue; }
    if (startingChats.has(chat)) { await startingChats.get(chat); continue; }
    break;
  }
  // Changing the folders in Settings starts the chat's Copilot again (resuming it) on its next turn.
  // Changing a chat's own folders (its side panel) does the same.
  const extra = chatFolders(chat);
  const dirs = [...copilotFolders(), ...extra, copilotTmp(), memory.memoryDir()].map((f) => untilde(f)).filter(isDir);
  // The chat's agent: the one it runs in already, else your pick for a new chat, else the rules.
  const name = acpChats.get(chat)?.agentName || (resumeId && sessionAgent(resumeId)) || (AGENTS[agentPick] ? agentPick : null)
    || chatAgent(chat, { cwd, repos: scope.filter((x) => x.repo).map((x) => x.repo) });
  const b = backend(name);
  const args = b.args({ ...options, folders: dirs });
  // Sandboxed mode always runs in srt; the others when Settings → Agent → Sandbox says so.
  const sandbox = !!copilot.PERMISSIONS[options.permission]?.sandbox || process.env.AGENT_SANDBOX === 'srt';
  const sig = JSON.stringify([b.name, args, dirs, options.permission, options.model, sandbox, process.env.AGENT_DOMAINS, process.env.AGENT_FOLDERS]);
  let c = acpChats.get(chat);
  // A new Copilot for the same chat keeps its VM, and the repos and Jira projects it works on.
  let keep = {};
  if (c && (c.sig !== sig || c.agent.closed)) { resumeId = c.agent.sessionId; keep = { vm: c.vm, repos: c.repos, jira: c.jira, tickets: c.tickets }; c.agent.close(); acpChats.delete(chat); c = null; }
  let started = null;
  if (!c) startingChats.set(chat, new Promise((d) => { started = d; }));
  try { if (!c) {
    const agent = await startAgent(b.name === backend().name ? bin : null, args, cwd, { sandbox, folders: extra, permission: options.permission, model: options.model, dirs, agent: b.name });
    c = { agent, agentName: b.name, sig, cwd, vm: keep.vm || null, repos: keep.repos || new Set(), jira: keep.jira || new Set(), tickets: keep.tickets || new Set(), waiting: new Map(), pending: new Map(), approved: new Set(), running: new Set(), shared: new Set(), emit: () => {}, lastUsed: Date.now() };
    bindVm(c);
    const id = await agent.start(cwd, resumeId);
    c.id = id;
    // Its repos are the ones its folder has now, before its first turn; a chat seen before keeps its list.
    c.scope = chatScope.scopeOf(scopesFile, id) || chatScope.saveScope(scopesFile, id, await chatScope.scopeSnapshot(cwd, gitReposLater));
    for (const r of c.scope['+'] || []) c.repos.add(r);
    acpChats.set(id, c);
    localState.setSessionAgent(stateFile, id, b.name);
    // A new chat gets Copilot's own session id; the panel keeps using that from now on.
    if (id !== chat) emit({ type: 'session', id });
    emit({ type: 'agent', name: b.name });
  } } finally { if (started) { startingChats.delete(chat); started(); } }
  c.lastUsed = Date.now();
  c.mode = options.permission;
  c.model = options.model || null;
  c.options = options; // for Clearsky's own turns in this chat (a job's result, a nudge)
  // What this chat is about (the items it was started with, the tickets you named): its writes
  // to those go through without asking.
  for (const x of scope) {
    if (x.kind === 'issue') { c.jira.add(x.key.split('-')[0]); c.tickets.add(x.key); }
    else if (x.repo) c.repos.add(x.repo.toLowerCase());
  }
  const { agent } = c;
  // Events go to whichever page is watching this chat; none while you look at another one.
  c.emit = emit;
  if (agent.commands) { copilotCommands = agent.commands; emit({ type: 'commands', commands: agent.commands }); }
  agent.onUpdate = (u) => {
    if (u.sessionUpdate === 'available_commands_update') { copilotCommands = agent.commands; c.emit({ type: 'commands', commands: agent.commands }); return; }
    // A step you allowed has finished: its GitHub changes ask again (see githubAsk).
    if (u.sessionUpdate === 'tool_call_update' && ['completed', 'failed'].includes(u.status)) { c.approved.delete(u.toolCallId); c.running.delete(u.toolCallId); }
    else if (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') c.running.add(u.toolCallId);
    noteBuild(c, u);
    noteFiles(c, u);
    // For the watchdog: when it last did anything, and what it said after its last step.
    c.lastEvent = Date.now();
    if (u.sessionUpdate === 'tool_call') c.turnText = '';
    else if (u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text') c.turnText += u.content.text;
    const e = chatEvent(u);
    // A /compact turn's own words wait for its end: "Nothing to compact" isn't shown as said.
    if (e?.type === 'text' && c.heldText) { c.heldText.push(e.text); return; }
    if (e && (e.type !== 'text' || e.text)) c.emit(e);
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
  let turnOver;
  c.turnDone = new Promise((d) => { turnOver = d; });
  Object.assign(c, { turnText: '', lastEvent: Date.now(), userStopped: false, stuck: false, auto });
  watchdog.cancel(c.id);
  // /compact: Copilot's answer to it isn't a reliable end (sometimes it never comes), so the
  // compaction's own record in the session's log ends the turn.
  const compact = /^\s*\/compact\b/.test(prompt) ? watchCompaction(c, chat) : null;
  c.heldText = compact ? [] : null;
  let r = null, error = null;
  try { r = await (compact ? Promise.race([agent.prompt(prompt), compact]) : agent.prompt(prompt)); } catch (e) { error = e; }
  finally {
    compact?.turnOver();
    // Copilot's "Failed to run /compact: Error: Nothing to compact." (as an error or as its
    // answer) isn't a failure: the chat is already as short as it gets. A quiet note instead.
    if (compact) {
      const said = c.heldText.join('');
      c.heldText = null;
      if (NOTHING_TO_COMPACT.test(error?.message || '') || NOTHING_TO_COMPACT.test(said)) {
        error = null;
        compact.stop();
        c.emit({ type: 'note', text: 'Nothing to compact: this chat is already as short as Copilot can make it.' });
      } else if (said) c.emit({ type: 'text', text: said });
    }
    c.busy = false; c.approved.clear(); c.running.clear(); closeCards(c); hostDoor.turnEnded(c.id); turnOver();
  }
  afterTurn(c, { stopReason: r?.stopReason, error, command: /^\s*\//.test(typedPart(prompt)) });
  if (error) throw error;
  c.emit({ type: 'done', stopReason: r?.stopReason });
  c.emit = () => {};
}

// Waits for Copilot's session.compaction_complete (after this point in its log) and says how much it
// removed. If Copilot is still "answering" the /compact turn then, that turn is ended: the
// compaction is done. Gives up after three minutes. `turnOver()` says the turn ended by itself.
const NOTHING_TO_COMPACT = /nothing to compact/i;
function watchCompaction(c, id) {
  const file = join(copilotHome(), 'session-state', c.agent.sessionId || id, 'events.jsonl');
  let from = 0, over = false;
  try { from = statSync(file).size; } catch {}
  const k = (n) => `${Math.round((n || 0) / 1000)}k`;
  const started = Date.now();
  let timer;
  const p = new Promise((done) => {
    timer = setInterval(() => {
      let text = '';
      try { const buf = readFileSync(file); text = buf.subarray(Math.min(from, buf.length)).toString('utf8'); } catch {}
      const line = text.split('\n').find((l) => l.includes('"session.compaction_complete"'));
      if (!line && Date.now() - started < 180_000) return;
      clearInterval(timer);
      let d = {};
      try { d = JSON.parse(line).data || {}; } catch {}
      // After a turn that ended by itself, the note goes to the chat's next turn or nowhere.
      c.emit({ type: 'note', text: !line ? 'Compact: no word from Copilot after 3 minutes'
        : NOTHING_TO_COMPACT.test(d.error || '') ? 'Nothing to compact: this chat is already as short as Copilot can make it.'
        : d.success === false ? `Compact didn't work${d.error ? `: ${d.error}` : ''}`
        : `Compacted: ${k(d.preCompactionTokens)} → ${k(d.postCompactionTokens)} tokens` });
      if (over) return;
      setTimeout(() => { if (!over) { c.agent.cancel(); done({ stopReason: 'end_turn' }); } }, 2000);
    }, 1000);
  });
  p.turnOver = () => { over = true; };
  p.stop = () => { over = true; clearInterval(timer); };
  return p;
}

// Watch a chat that is still running (after switching back to it): its open questions, then
// what it does from now on, until the turn ends.
function attachCopilot(chat, req, res) {
  const c = acpChats.get(chat);
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  const send = (e) => { e.at ??= Date.now(); if (!res.writableEnded && !res.destroyed) res.write(`${JSON.stringify(e)}\n`); };
  if (!c?.busy) { send({ type: 'done' }); return res.end(); }
  for (const ev of c.pending.values()) send(ev);
  const emit = (e) => { send(e); if (e.type === 'done') res.end(); };
  c.emit = emit;
  res.on('close', () => { if (c.emit === emit) c.emit = () => {}; });
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

const ATTENTION_SOURCES = ['github', 'jiraMentions'];
const poller = { lastPoll: null, notifier: null, timer: null };

// Desktop banners come from notify-send when it's there; otherwise the open page shows them.
// Desktop banners go over D-Bus with gdbus (clicks work), else through notify-send, else the
// open page shows them. CLEARSKY_NOTIFY=notify-send forces the old way.
let dbusNotifier = null;
function hasNotifySend() {
  if (process.env.CLEARSKY_NOTIFY === 'off') return Promise.resolve('off');
  if (process.env.CLEARSKY_NOTIFY === 'browser') return Promise.resolve('browser');
  // WSL has no desktop of its own to show them on: the page in your Windows browser does.
  if (!process.env.CLEARSKY_NOTIFY && wslInfo()) return Promise.resolve('browser');
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
    // A plugin you just added (or Slack, now a plugin) starts quiet too: what it already had isn't news.
    quiet: (it) => { const src = String(it.key).split(':')[0]; return plugins.sources.has(src) && !Object.keys(before).some((k) => k.startsWith(`${src}:`)); },
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

// Every CLEARSKY_POLL_MINUTES (3), read again each round so a change in Settings applies at once.
function startPolling() {
  hasNotifySend().then((n) => { poller.notifier = n; });
  const next = (ms) => { clearTimeout(poller.timer); poller.timer = setTimeout(tick, ms); poller.timer.unref?.(); };
  const tick = () => pollAttention(true).catch((e) => console.error(`clearsky: poll failed: ${e.message}`))
    .finally(() => next(Math.max(1, Number(process.env.CLEARSKY_POLL_MINUTES) || 3) * 6e4));
  next(2000);
}

// Restart without cutting off Copilot: wait until no chat here is working or waiting for an OK,
// then start a fresh server (or, under systemd, exit for it to restart us). Idle chats carry on
// after the restart, because a new message reopens the session.
const restart = { pending: null, timer: null, server: null };
// A restart waits for chats started here that are mid-answer or waiting on your Allow/Deny.
// Chats done with their turn, and Copilot in a terminal or editor, don't hold it up.
// A background job running holds it up too (Restart now cuts it short; its chat hears so after).
const chatsBusy = () => [...acpChats.values()].filter((c) => c.busy || c.waiting.size).length + jobs.running().length;
function busyChats() {
  const names = localState.sessionNames(stateFile), titles = new Map((sessionsCache?.data || []).map((x) => [x.id, x.title]));
  return [...acpChats.entries()].filter(([, c]) => c.busy || c.waiting.size)
    .map(([id, c]) => ({ id, title: names[id] || titles.get(id) || 'Copilot chat', status: needsYou(c) ? 'needs-you' : 'working' }));
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

// Whether Clearsky's files changed since this process started (a pull), so a restart would update it.
const startedAt = Date.now();
function updateReady() {
  const root = appDir;
  let bundled = [];
  try { bundled = readdirSync(join(root, 'plugins')).flatMap((n) => [`plugins/${n}`, `plugins/${n}/lib`]); } catch { /* none */ }
  for (const dir of ['bin', 'lib', 'lib/modules', 'web', 'web/js', 'web/css', ...bundled]) {
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
      if (Date.now() > Date.parse(restart.pending.until)) { logEvent(`restart given up, ${chatsBusy()} chat(s) still working`); clearInterval(restart.timer); restart.pending = null; }
      return;
    }
    clearInterval(restart.timer);
    const busyNow = chatsBusy();
    logEvent(`restarting (${restart.pending.force ? 'Restart now' : 'when idle'}, ${busyNow} busy chat(s) stopped)`);
    jobs.closing = true; // what's still running is 'interrupted' for the next Clearsky, which tells its chats
    for (const c of acpChats.values()) { c.agent.close(); c.vm?.stop(); }
    stopSandbox().catch(() => {});
    restart.server?.close();
    if (process.env.CLEARSKY_SUPERVISED === '1') process.exit(75); // a supervisor (systemd) starts us again
    spawn(process.execPath, process.argv.slice(1), { detached: true, stdio: 'inherit', cwd: process.cwd(),
      env: { ...process.env, CLEARSKY_STARTED_BY: `restart (${restart.pending.force ? 'Restart now' : 'when idle'}, ${busyNow} busy)` } }).unref();
    setTimeout(() => process.exit(0), 200);
  };
  restart.timer = setInterval(check, 3000);
  check();
  return restart.pending;
}

// Sources with a web login (School) are touched now and then, at random times between 30 minutes
// and 2 hours apart, so their login doesn't run out while Clearsky sits unwatched.
export const keepAliveDelay = (rand = Math.random) => Math.round((30 + rand() * 90) * 6e4);
function keepLoginsAlive() {
  for (const p of plugins.sources.values()) {
    if (typeof p.keepAlive !== 'function') continue;
    const next = () => setTimeout(async () => {
      if (!p.enabled || p.enabled(process.env)) {
        try { logEvent(`${p.label}: login kept alive (${await p.keepAlive({ ...makeContext(p), vpn: () => vpn.check() })})`, { echo: false }); }
        catch (e) { logEvent(`${p.label}: keeping the login alive failed: ${e.message}`, { echo: false }); }
      }
      next();
    }, keepAliveDelay()).unref?.();
    next();
  }
}

// ---------------------------------------------------------------- plugins

// Every plugin for Settings → Plugins, all in one list and described the same way: Clearsky's
// own (GitHub, Jira, Calendar, Links), the ones you added, your own files in
// ~/.config/clearsky/sources, and what ships with Clearsky but isn't added. `reach` is what it
// holds and talks to; `ready` is false until its required settings are filled in.
function pluginList() {
  const { added, available } = listPlugins({ paths: pluginDirs });
  const strip = ({ manifest, ...p }) => ({ ...p, manifest: manifest && { hosts: manifest.hosts, clis: manifest.clis, files: manifest.files, secrets: manifest.secrets, outside: manifest.outside || null, area: manifest.area } });
  const reach = new Map(moduleManifests().map((m) => [m.name, m]));
  const shape = (m) => m && { hosts: m.hosts || [], clis: m.clis || [], files: m.files || [], secrets: m.secrets || [], dbus: !!m.dbus, note: m.note || '', outside: m.outside || null };
  const loaded = (p) => plugins.sources.get(p.name)?.plugin?.from === p.from;
  const all = [
    ...BUILTIN_MANIFESTS.filter((m) => m.name !== 'copilot').map((m) => ({ name: m.name, label: m.label, description: m.description || '', area: m.area,
      kind: 'core', added: true, loaded: true, ready: true, reach: shape(reach.get(m.name)) })),
    ...[...plugins.sources.values()].map((p) => {
      const a = added.find((x) => x.name === p.name);
      let ready = true;
      try { ready = !p.enabled || !!p.enabled(process.env); } catch { ready = false; }
      return { name: p.name, label: p.label, description: a?.description || p.manifest?.description || '', area: p.area || 'personal',
        kind: a ? a.kind : 'local', from: a?.from || '~/.config/clearsky/sources', version: a?.version || '', commit: a?.commit || null, run: a?.run || 'inside',
        added: true, loaded: a ? loaded(a) : true, ready, problem: a?.problem || null, reach: shape(reach.get(p.name)) };
    }),
    // Added but not running in this Clearsky: new since it started, or it failed to load.
    ...added.filter((p) => !plugins.sources.has(p.name)).map((p) => ({
      name: p.name, label: p.label, description: p.description, area: p.manifest?.area || 'personal', kind: p.kind, from: p.from, version: p.version || '', commit: p.commit || null,
      run: p.run, added: true, loaded: false, ready: true, problem: p.problem, reach: shape(p.manifest) })),
    ...available.map((p) => ({ name: p.name, label: p.label, description: p.description, area: p.manifest?.area || 'personal', kind: p.kind, from: p.from,
      version: p.manifest?.version || '', added: false, loaded: false, ready: false, reach: shape(p.manifest) })),
  ];
  const pins = readRegistry(pluginDirs.registry).plugins;
  for (const p of all) if (pins[p.name]?.pin && p.added) p.pin = pins[p.name].pin;
  // Added from its folder here, and it has a repo of its own now: offer the move.
  for (const p of all) if (p.kind === 'bundled' && p.added && !retiredText(p.name)) { const c = catalogEntry(p.name); if (c) p.moveTo = c.from; }
  return {
    all, added: added.map((p) => ({ ...strip(p), loaded: loaded(p) })),
    available: available.map(strip), errors: plugins.errors, sandbox: !!srtCli(), team: teamPlugins(),
  };
}

// A fetched plugin waiting for you to say yes (10 minutes), so what's added is what you saw.
const pendingPlugins = new Map();
async function previewPlugin(from) {
  const p = await preparePlugin(from, { paths: pluginDirs });
  const token = randomBytes(12).toString('hex');
  pendingPlugins.set(token, { ...p, timer: setTimeout(() => { pendingPlugins.delete(token); p.discard(); }, 10 * 6e4) });
  const m = p.manifest;
  return { token, name: m.name, label: m.label, version: m.version, description: m.description, from, kind: p.spec.kind,
    commit: p.got.commit || null, hosts: m.hosts, clis: m.clis, files: m.files, secrets: m.secrets, settings: Object.keys(m.settings),
    outside: m.outside || null, replaces: p.had ? { version: p.had.version, commit: p.had.commit || null, from: p.had.from } : null, sandbox: !!srtCli(),
    changes: p.changes && { ...p.changes, text: changesText(p.changes) }, warning: p.warning || null };
}

// `clearsky add | remove | plugins | update`.
async function pluginCommand(args) {
  const [cmd, name] = args, flag = (f) => args.includes(f);
  const say = (m) => console.log(m);
  const where = (m) => [m.hosts.length ? `reaches ${m.hosts.join(', ')}` : 'reaches no hosts', m.clis.length && `runs ${m.clis.join(', ')}`, m.files.length && `keeps ${m.files.join(', ')}`].filter(Boolean).join('; ');
  try {
    if (cmd === 'plugins') {
      const { added, available } = listPlugins({ paths: pluginDirs });
      say(added.length ? 'Added:' : 'No plugins added. `clearsky add <plugin>` adds one.');
      for (const p of added) say(`  ${p.name} ${p.version || ''}  ${p.run === 'inside' ? 'inside Clearsky' : 'sandboxed'}  from ${p.from}${p.commit ? ` @ ${p.commit.slice(0, 10)}` : ''}${p.problem ? `  (${p.problem})` : ''}`);
      if (available.length) { say('To add (`clearsky add <name>`):'); for (const p of available) say(`  ${catalogEntry(p.name)?.aka[0] || p.name}  ${p.description}${p.kind === 'catalog' ? `  (${p.from})` : ''}`); }
      if (!srtCli()) say('The sandbox (srt) isn\'t installed, so sandboxed plugins won\'t run. `clearsky doctor` says how to get it.');
      return 0;
    }
    if (!name && cmd !== 'update') { say(`usage: clearsky ${cmd} <plugin>`); return 2; }
    if (cmd === 'remove') { removePlugin(name, { paths: pluginDirs, data: flag('--data') }); say(`Removed ${name}${flag('--data') ? ', and what it kept' : ''}. Restart Clearsky to drop it.`); return 0; }
    const ask = async (q) => {
      if (flag('--yes')) return true;
      if (!process.stdin.isTTY) return false;
      const rl = (await import('node:readline/promises')).createInterface({ input: process.stdin, output: process.stdout });
      const yes = /^y(es)?$/i.test((await rl.question(`${q} [y/N] `)).trim());
      rl.close();
      return yes;
    };
    const opt = (f) => { const i = args.indexOf(f); return i > -1 ? (args[i + 1] ?? '') : undefined; };
    // clearsky update [name] [--to v1.3.0 | --to ''] [--check] [--yes]
    if (cmd === 'update') {
      const named = name && !name.startsWith('--') ? name : null;
      const names = named ? [named] : listPlugins({ paths: pluginDirs }).added.filter((p) => p.kind !== 'bundled').map((p) => p.name);
      const to = opt('--to');
      let changed = 0;
      for (const n of names) {
        if (flag('--check')) {
          const c = await checkPlugin(n, { paths: pluginDirs }).catch((e) => ({ problem: e.message }));
          const where = c.pin === 'tag' || c.pin === 'branch' ? `${c.pin} ${c.ref}` : c.pin === 'default' ? `follows ${c.branch || 'the default branch'}` : c.pin;
          say(`${n}: ${[where, c.problem, c.behind && 'has new commits', c.moved && `the tag now points to other code (${c.latest?.slice(0, 10)})`,
            c.newer?.length && `newer: ${c.newer.map((x) => x.tag).join(', ')}`].filter(Boolean).join('; ') || 'up to date'}`);
          continue;
        }
        const had = readRegistry(pluginDirs.registry).plugins[n];
        const p = await preparePlugin(to === undefined ? had?.from || n : withRef(had.from, to), { paths: pluginDirs });
        const before = { version: p.had?.version, commit: p.had?.commit };
        if (p.warning) say(`${n}: careful, ${p.warning}`);
        if (p.manifest.outside && p.had?.run !== 'inside') { p.discard(); say(`${n}: not updated, the new version wants to run outside the sandbox (${p.manifest.outside}). Add it again with --trust if you trust it.`); continue; }
        if (p.changes?.wider) {
          say(`${n}: the new version ${changesText(p.changes)}.`);
          if (!await ask('Take it?')) { p.discard(); say(`${n}: not updated.`); continue; }
        }
        const r = p.done({ trust: p.had?.run === 'inside' });
        changed++;
        say(`${n}: ${before.commit && r.commit ? `${before.commit.slice(0, 10)} → ${r.commit.slice(0, 10)}` : `${before.version} → ${r.version}`}${r.from !== p.had?.from ? ` (now ${r.from})` : ''}`);
      }
      if (changed) say('Restart Clearsky to load the new code.'); else if (!names.length) say('Nothing to update.');
      return 0;
    }
    // clearsky add --team: each of the team pack's plugins you haven't got (or have at another version).
    if (cmd === 'add' && name === '--team') {
      const t = teamPlugins();
      const todo = (t?.plugins || []).filter((p) => p.state !== 'added');
      if (!todo.length) { say(t ? `You have all of ${t.name}'s plugins.` : 'You haven\'t joined a team pack with plugins. `clearsky join <pack>` first.'); return 0; }
      for (const o of todo) {
        say(`\n${o.state === 'new' ? 'Team plugin' : `Team version of ${o.name} (you have ${o.yours})`}: ${o.from}${o.note ? ` — ${o.note}` : ''}`);
        const code = await pluginCommand(['add', o.from, ...args.filter((a) => a === '--yes' || a === '--trust')]);
        if (code) say('  skipped');
      }
      return 0;
    }
    // add: show what it is and what it reaches before any of its code runs, then ask.
    const p = await preparePlugin(name, { paths: pluginDirs });
    const m = p.manifest;
    say(`${m.label} ${m.version}${p.got.commit ? ` (${p.got.commit.slice(0, 10)})` : ''}: ${m.description || 'no description'}`);
    say(`  ${where(m)}`);
    if (Object.keys(m.settings).length) say(`  settings: ${Object.keys(m.settings).join(', ')}`);
    if (p.spec.kind === 'bundled') say('  ships with Clearsky; runs inside it');
    else if (m.outside) say(`  runs OUTSIDE the sandbox, as you: ${m.outside}`);
    else say(`  runs in a sandbox of its own${srtCli() ? '' : ' (not installed here, so it won\'t run until it is)'}`);
    if (m.outside && p.spec.kind !== 'bundled' && !flag('--trust')) { p.discard(); say('Not added: it can do anything you can. Add it again with --trust if you trust its code.'); return 1; }
    if (p.had) say(`  replaces ${p.had.from}${p.changes?.wider ? `; the new version ${changesText(p.changes)}` : ''}`);
    if (p.warning) say(`  careful: ${p.warning}`);
    if (!flag('--yes') && !process.stdin.isTTY) { p.discard(); say('Not added: say yes with --yes when there\'s no terminal to ask in.'); return 1; }
    if (!await ask('Add it?')) { p.discard(); say('Not added.'); return 1; }
    const r = p.done({ trust: flag('--trust') });
    say(`Added ${r.name}. Restart Clearsky (or Settings → Restart) to load it${Object.keys(m.settings).length ? ', then fill in its settings' : ''}.`);
    return 0;
  } catch (e) { console.error(`clearsky: ${e.message}`); return 1; }
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

// ---------------------------------------------------------------- hand-offs

// Hand-offs (lib/handoff.mjs): one at a time, each an ordinary Copilot chat in the sandbox,
// started the way the page starts one (a POST to /api/copilot on this server), so it gets the
// same folders, worktree, sandbox and doors.
const handoffFile = () => join(dirname(userEnvFile), 'handoffs.json');
const handoffs = { running: null, timer: null };
function changeHandoff(id, patch) { saveHandoffs(handoffFile(), updateHandoff(readHandoffs(handoffFile()), id, patch)); }

async function handoffCheck(csrf) {
  if (handoffs.running) return;
  const h = nextHandoff(readHandoffs(handoffFile()));
  if (!h) return;
  handoffs.running = h.id;
  // The demo has no real Copilot or sandbox: it acts one out, so a hand-off can be shown.
  if (isDemo()) {
    changeHandoff(h.id, { status: 'working', startedAt: new Date().toISOString(), note: '' });
    setTimeout(() => { changeHandoff(h.id, { status: 'done', endedAt: new Date().toISOString(), pr: 'https://github.com/acme/payments-api/pull/479', note: 'Demo data: a real hand-off ends with its own draft PR.' }); handoffs.running = null; }, 8000);
    return;
  }
  try {
    const info = await copilotInfo();
    if (!info.available) throw new Error('GitHub Copilot CLI not found');
    if (!(await srtInstalled())) throw new Error('hand-offs run only in the sandbox: install srt (see the welcome page)');
    changeHandoff(h.id, { status: 'working', startedAt: new Date().toISOString(), note: '' });
    logEvent(`hand-off started: ${h.label}`);
    const res = await fetch(`http://127.0.0.1:${config.port}/api/copilot`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Clearsky-Token': csrf },
      body: JSON.stringify({ session: `handoff-${h.id}-${randomBytes(4).toString('hex')}`, refs: [h.ref], permission: 'sandboxed',
        model: process.env.AGENT_MODEL || undefined, effort: process.env.AGENT_EFFORT || undefined,
        message: handoffPrompt(h, { skills: (info.skills || []).map((x) => x.name) }) }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    // Follow the answer as it streams: its chat, when it waits for an OK, and its last words.
    let text = '', buf = '', failed = null;
    const dec = new TextDecoder();
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        let e; try { e = JSON.parse(line); } catch { continue; }
        if (e.type === 'session') changeHandoff(h.id, { session: e.id });
        else if (e.type === 'cwd') changeHandoff(h.id, { cwd: e.cwd });
        else if (e.type === 'text') text += e.text || '';
        else if (e.type === 'tool') text += '\n';
        else if (e.type === 'permission') changeHandoff(h.id, { status: 'needs-you', note: 'Waiting for your OK in the chat.' });
        else if (e.type === 'permission-done') changeHandoff(h.id, { status: 'working', note: '' });
        else if (e.type === 'error') failed = e.message;
      }
    }
    const r = failed && !text.trim() ? { status: 'failed', pr: null, note: failed } : handoffResult(text);
    changeHandoff(h.id, { ...r, endedAt: new Date().toISOString() });
    logEvent(`hand-off ${r.status}: ${h.label}${r.pr ? ` (${r.pr})` : ''}`);
  } catch (e) {
    changeHandoff(h.id, { status: 'failed', note: e.message, endedAt: new Date().toISOString() });
  } finally {
    handoffs.running = null;
  }
}
function startHandoffs(csrf) {
  saveHandoffs(handoffFile(), settleAfterRestart(readHandoffs(handoffFile())));
  handoffs.check = () => handoffCheck(csrf).catch((e) => logEvent(`hand-off error: ${e.message}`));
  handoffs.timer = setInterval(handoffs.check, 30_000);
  handoffs.timer.unref();
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

export { findBrowser, SOURCES, sourceCache };

// Your default browser, as the desktop opens links.
function openInBrowser(u) {
  // Under WSL, the Windows browser (wslview, else rundll32.exe): see lib/browser.mjs.
  const [cmd, ...pre] = openCommand();
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
    else spawn(process.execPath, [join(appDir, 'bin', 'clearsky.mjs'), 'serve', '--port', String(config.port)], { detached: true, stdio: 'ignore', env: process.env, cwd: appDir }).unref();
    for (let i = 0; i < 50 && !(await up()); i++) await new Promise((r) => setTimeout(r, 200));
  }
  // Under WSL2 a Windows browser (Edge, Chrome): WSL forwards 127.0.0.1 to Windows.
  const wsl = wslInfo();
  const browser = findBrowser(process.env, { windows: !!wsl });
  if (!browser) { console.error(`No Chromium-based browser found (tried ${wsl ? 'Edge and Chrome on C:, then ' : ''}${BROWSERS.join(', ')}). Set CLEARSKY_BROWSER, or open ${base}`); process.exit(1); }
  // A size that fits a laptop screen (CLEARSKY_WINDOW_SIZE=1600,1000 for another); the page
  // shrinks the window too when the browser remembers one taller than the screen.
  const size = /^\d+,\d+$/.test(process.env.CLEARSKY_WINDOW_SIZE || '') ? process.env.CLEARSKY_WINDOW_SIZE : '1280,860';
  // A browser profile of its own: in your running browser the window would be filed under the
  // browser (Wayland ignores --class there), so it couldn't be found as Clearsky in the dock or
  // Alt+Tab. No logins needed in it: links open in your default browser.
  // A Windows browser keeps it on Windows (%LOCALAPPDATA%\Clearsky\app-window): it can't use the Linux home.
  const windows = isWindowsExe(browser);
  const profile = windows ? windowsProfileDir() : join(dirname(userEnvFile), 'app-window');
  if (process.platform === 'linux' && !wsl) fixLauncher();
  spawn(browser, [`--app=${base}/?app=1`, ...(windows ? [] : ['--class=Clearsky']), ...(profile ? [`--user-data-dir=${profile}`] : []), '--no-first-run', '--no-default-browser-check', `--window-size=${size}`],
    { detached: true, stdio: 'ignore' }).unref();
}

// `clearsky docker …`: Clearsky's container, with the folders from Settings → Agent mounted
// (see lib/docker.mjs). Runs on your machine, not in the container.
async function dockerCommand([sub = 'up', ...rest]) {
  const { dockerMounts, writeMountsFile } = await import('../lib/docker.mjs');
  if (process.env.CLEARSKY_IN_CONTAINER === '1') { console.error('Run this on your machine, not in the container.'); process.exitCode = 1; return; }
  const repo = appDir;
  for (const d of [dirname(userEnvFile), join(homedir(), '.copilot')]) mkdirSync(d, { recursive: true, mode: 0o700 });
  const mounts = dockerMounts({ folders: copilotFolders(), cwd: process.env.AGENT_CWD, home: homedir() });
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
