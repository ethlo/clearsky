// The stand-up: what you did since the last one (GitHub, tickets, chats, plugins), what is on
// today and what blocks you; as data, as text, and as a few sentences to say.
import * as copilot from '../copilot.mjs';
import { hook, asList } from '../sources.mjs';
import { groupStandup } from '../standup.mjs';
import { fieldsOf, nameOf, starredProjects } from '../modules/jira.mjs';
import { config, tracker, backend, plugins, clock, sameDay, nextStandup, previousStandup } from './config.mjs';
import { settle, gql, ghCliToken, jiraModule, jiraSearch, jiraSite, browseUrl } from './services.mjs';
import { pluginData, collect } from './work.mjs';
import { workspaceInfo, copilotCwd, copilotInfo, copilotEnv } from './chat-env.mjs';
import { oneShot } from './chat.mjs';
import { copilotSessions } from './chat-sessions.mjs';

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
export let sayCache = { key: null, text: null, at: null };
export async function standupSay(s, force) {
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
