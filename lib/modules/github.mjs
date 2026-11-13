// GitHub: review requests, your PRs and who has the ball on each, mentions and assigned issues,
// through GitHub's GraphQL API with your token, or the GitHub CLI's login when there is none.
// The pure parts (who has the ball, open threads, bots) are exported for tests and the item model.

import { buildQuery, buildOf } from '../builds.mjs';
import { reviewTriage } from '../advice.mjs';
import { shortRepo, GLYPH, TONE, ticketKeys, prNext, reviewNext, replyNext, startNext } from '../items.mjs';

// What this module holds and reaches (shown in Settings → Plugins).
export const manifest = {
  name: 'github', label: 'GitHub', area: 'work', description: 'Pull requests, reviews and mentions in your organizations, and how your repos build.',
  secrets: [{ key: 'GITHUB_TOKEN', kind: 'token', note: 'or the GitHub CLI login (gh auth token)' }],
  clis: ['gh'],
  hosts: ['api.github.com'],
  files: [],
};

export const PR_FIELDS = `
  number title url state isDraft createdAt updatedAt reviewDecision mergeable headRefName baseRefName
  additions deletions changedFiles
  repository { nameWithOwner }
  author { login }
  reviews(last: 30) { nodes { state submittedAt author { __typename login } } }
  reviewRequests(first: 20) { nodes { requestedReviewer { __typename ... on User { login } ... on Team { slug } ... on Bot { login } } } }
  reviewThreads(first: 100) { nodes { isResolved isOutdated comments(last: 1) { nodes { author { __typename login } } } } }
  commits(last: 1) { nodes { commit { committedDate statusCheckRollup { state }
    checkSuites(first: 20) { nodes { status conclusion workflowRun { event url workflow { name } } } } } } }
  closingIssuesReferences(first: 5) { nodes { number repository { nameWithOwner } } }
  timelineItems(itemTypes: [REVIEW_REQUESTED_EVENT], last: 10) {
    nodes { ... on ReviewRequestedEvent { createdAt requestedReviewer { __typename ... on User { login } ... on Team { slug } } } }
  }`;

// Your PRs also say who wrote each commit, for "read by you". Asked in a separate, small request
// per 10 PRs (commits with line counts across all your PRs at once is too heavy: GitHub answers 502),
// and a failure there only leaves "read by you" out.
export const OWN_FIELDS = `
  changedFiles
  viewedFiles: files(first: 100) { nodes { viewerViewedState } }
  history: commits(last: 30) { nodes { commit { oid committedDate message author { name email user { login } } } } }`;
export const ownCommits = (pr) => (pr.history?.nodes || []).map(({ commit: c }) => ({
  oid: c.oid, at: c.committedDate, message: c.message,
  login: c.author?.user?.login || null, name: c.author?.name || null, email: c.author?.email || null,
}));
export const ownViewed = (pr) => (pr.viewedFiles?.nodes && pr.viewedFiles.nodes.length === pr.changedFiles
  ? { files: pr.changedFiles, viewed: pr.viewedFiles.nodes.filter((f) => f.viewerViewedState === 'VIEWED').length } : null);

export const ITEM_FIELDS = `
  __typename
  ... on Issue { number title url updatedAt repository { nameWithOwner } author { login } labels(first: 10) { nodes { name } } }
  ... on PullRequest { number title url updatedAt repository { nameWithOwner } author { login } }`;

// CI on the PR's latest commit. A build started by hand (workflow_dispatch) isn't in the PR's
// check rollup, only in the commit's check suites, so those count too.
// GitHub's own runs (event "dynamic": Copilot's reviewer, code scanning set up by GitHub) aren't the
// repo's CI and stay out of the PR's rollup, so they don't count here either. A workflow run again
// counts by its latest run.
const ciSuites = (commit) => {
  const latest = new Map();
  for (const s of (commit?.checkSuites?.nodes || []).filter((x) => x.workflowRun && x.workflowRun.event !== 'dynamic')) latest.set(s.workflowRun.workflow?.name || s.workflowRun.url, s);
  return [...latest.values()];
};
export function ciState(pr) {
  const commit = pr.commits?.nodes?.[0]?.commit;
  const runs = ciSuites(commit);
  if (runs.some((s) => ['FAILURE', 'TIMED_OUT', 'STARTUP_FAILURE'].includes(s.conclusion))) return 'FAILURE';
  if (runs.some((s) => s.status && s.status !== 'COMPLETED')) return 'PENDING';
  return commit?.statusCheckRollup?.state || (runs.length && runs.every((s) => s.conclusion === 'SUCCESS' || s.conclusion === 'SKIPPED' || s.conclusion === 'NEUTRAL') ? 'SUCCESS' : null); // SUCCESS FAILURE ERROR PENDING EXPECTED
}
// The CI run to link: a failing one, else one still running, else the latest build.
export function ciRun(pr) {
  const runs = ciSuites(pr.commits?.nodes?.[0]?.commit);
  const pick = runs.find((s) => ['FAILURE', 'TIMED_OUT', 'STARTUP_FAILURE'].includes(s.conclusion)) || runs.find((s) => s.status !== 'COMPLETED')
    || runs.find((s) => s.workflowRun.event === 'workflow_dispatch') || null;
  return pick && { name: pick.workflowRun.workflow?.name || 'CI', url: pick.workflowRun.url };
}

// Review bots (like Copilot's PR reviewer, which comments on every push) aren't people
// waiting on you: their reviews and threads never make a PR your move.
export const isBot = (a) => !!a && (a.__typename === 'Bot' || /\[bot\]$|^copilot-pull-request-reviewer$|^Copilot$/i.test(a.login || ''));

export function latestReviewsByUser(pr, me) {
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

export const humanReviewers = (pr) => (pr.reviewRequests?.nodes || []).filter((n) => n.requestedReviewer && !isBot(n.requestedReviewer));

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
  if (ci === 'FAILURE' || ci === 'ERROR') { const run = ciRun(pr); return { label: 'CI failing', ...(run && { detail: run.name, url: run.url }), owner: 'me', tone: 'bad' }; }
  if (pr.reviewDecision === 'CHANGES_REQUESTED' || changes > 0) return { label: 'Changes requested', owner: 'me', tone: 'bad' };
  if (unresolved > 0) return { label: `${unresolved} unresolved thread${unresolved > 1 ? 's' : ''}`, owner: 'me', tone: 'warn' };
  if (approved && (ci === 'PENDING' || ci === 'EXPECTED')) return { label: 'Approved, CI running', owner: 'others', tone: 'wait' };
  if (approved) return { label: 'Ready to merge', owner: 'me', tone: 'good' };
  // Review comments count only when they came after your latest commit; once you've pushed, the ball is theirs.
  const lastCommit = Date.parse(pr.commits?.nodes?.at(-1)?.commit?.committedDate || 0) || 0;
  if (reviews.some((r) => r.state === 'COMMENTED' && Date.parse(r.submittedAt) > lastCommit)) return { label: 'Has feedback', owner: 'me', tone: 'warn' };
  if (!humanReviewers(pr).length && !reviews.length) {
    // Rounds with Copilot's reviewer first: asking a person before those are done wastes their time.
    const bot = openThreads(pr, me).bot;
    if (bot) return { label: 'In review rounds', detail: `${bot} Copilot comment${bot > 1 ? 's' : ''}`, owner: 'me', tone: 'warn' };
    if ((pr.reviewRequests?.nodes || []).some((n) => isBot(n.requestedReviewer))) return { label: 'In review rounds', detail: 'Copilot reviewing', owner: 'others', tone: 'wait' };
    // Rounds done: the branch's CI build with tests, then a person.
    const run = ciRun(pr);
    if (ci === 'PENDING' || ci === 'EXPECTED') return { label: 'CI build running', ...(run && { detail: run.name, url: run.url }), owner: 'others', tone: 'wait' };
    if (ci === 'SUCCESS') return { label: 'Ready for a reviewer', owner: 'me', tone: 'warn' };
    // Nobody has been asked to review: the one thing to do is ask someone.
    return { label: 'No reviewer yet', owner: 'me', tone: 'warn' };
  }
  return { label: 'Waiting for review', owner: 'others', tone: 'wait' };
}

export function reviewerName(r) {
  return r?.login || (r?.slug ? `team:${r.slug}` : null);
}

// The parts that talk to GitHub. `config.github` holds the API address, token, orgs and authors to ignore.
export function createGitHub({ config, http, execFileP, daysAgoIso }) {
  let myName;
  async function gql(query, variables, { partial = false } = {}) {
    const { api, token } = config.github;
    const graphqlUrl = api.endsWith('/api/v3') ? api.replace(/\/v3$/, '/graphql') : `${api}/graphql`;
    const ask = () => http(graphqlUrl, { headers: { Authorization: `Bearer ${token}` }, body: { query, variables } });
    // GitHub sometimes answers a slow query with nothing at all, or a gateway error: try once more.
    let res;
    try { res = await ask(); } catch (e) { if (!(e.status >= 502)) throw e; }
    if (!res) res = await ask();
    if (!res) throw new Error("GitHub sent an empty answer; trying again at the next refresh");
    // partial: ids GitHub doesn't know come back as null beside an error; keep the rest.
    if (res.errors?.length && !(partial && res.data)) throw new Error(`GitHub: ${res.errors.map((e) => e.message).join('; ')}`);
    return res.data;
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

  // Merge one of your PRs, as you, the way the repo allows: squash if it's allowed, else a
  // merge commit, else rebase. Whether the branch goes is the repo's own setting.
  async function mergePr(repo, number) {
    config.github.token ||= await ghCliToken();
    const { api, token } = config.github;
    const headers = { Authorization: `Bearer ${token}` };
    const r = await http(`${api}/repos/${repo}`, { headers });
    const method = r.allow_squash_merge !== false ? 'squash' : r.allow_merge_commit !== false ? 'merge' : 'rebase';
    await http(`${api}/repos/${repo}/pulls/${number}/merge`, { method: 'PUT', headers, body: { merge_method: method } });
    return { method };
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
    const { token, orgs, ignoreAuthors, myPrsEverywhere } = config.github;
    if (!token) return { error: 'GITHUB_TOKEN is not set and `gh auth token` gave nothing' };

    const { viewer } = await gql('query { viewer { login } }');
    const me = viewer.login;
    // Your name, once: your commits made with an email GitHub doesn't know carry it.
    if (myName === undefined) { try { myName = (await gql('query { viewer { name } }'))?.viewer?.name || null; } catch { /* asked again next time */ } }
    const scope = `${orgs.map((o) => `org:${o}`).join(' ')} archived:false`;
    const since = daysAgoIso(config.days);

    const data = await gql(
      `query($rr: String!, $mine: String!, $ment: String!, $asg: String!) {
        reviewRequested: search(query: $rr, type: ISSUE, first: 50) { nodes { ... on PullRequest { ${PR_FIELDS} files(first: 100) { nodes { path } } } } }
        myPrs: search(query: $mine, type: ISSUE, first: 50) { nodes { ... on PullRequest { ${PR_FIELDS} id headRefOid } } }
        mentions: search(query: $ment, type: ISSUE, first: 30) { nodes { ${ITEM_FIELDS} } }
        assigned: search(query: $asg, type: ISSUE, first: 50) { nodes { ${ITEM_FIELDS} } }
      }`,
      {
        rr: `is:pr is:open review-requested:${me} ${scope}`,
        mine: `is:pr is:open author:${me} ${myPrsEverywhere ? 'archived:false' : scope}`,
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
        // Who else reviews it, and where they stand.
        approvals: latestReviewsByUser(pr, me).filter((r) => r.state === 'APPROVED').map((r) => r.author.login),
        changesRequested: latestReviewsByUser(pr, me).filter((r) => r.state === 'CHANGES_REQUESTED').map((r) => r.author.login),
        pendingReviewers: humanReviewers(pr).map((n) => reviewerName(n.requestedReviewer)).filter((n) => n && n !== me),
        ci: ciState(pr),
        size: { additions: pr.additions, deletions: pr.deletions, files: pr.changedFiles },
        paths: (pr.files?.nodes || []).map((f) => f.path),
        botSuggestions: openThreads(pr, me).bot,
      };
    });

    // PRs Copilot's coding agent opened for you: yours to answer for, too. Asked on its own, so a
    // failure there leaves just those out.
    try {
      const d = await gql(`query($q: String!) { agentPrs: search(query: $q, type: ISSUE, first: 10) { nodes { ... on PullRequest { ${PR_FIELDS} id headRefOid } } } }`,
        { q: `is:pr is:open author:app/copilot-swe-agent involves:${me} ${myPrsEverywhere ? 'archived:false' : scope}` });
      data.agentPrs = d.agentPrs;
    } catch (e) { console.error(`clearsky: PRs the coding agent opened for you: ${e.message}`); }
    const seenPr = new Set();
    const myPrs = [...data.myPrs.nodes, ...(data.agentPrs?.nodes || [])].filter((n) => open(n) && !seenPr.has(`${n.repository?.nameWithOwner}#${n.number}`) && seenPr.add(`${n.repository?.nameWithOwner}#${n.number}`)).map((pr) => {
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
        // When people were last asked, and last answered (bots, Copilot and your pushes don't count).
        askedAt: (pr.timelineItems?.nodes || []).filter((e) => reviewerName(e.requestedReviewer)).map((e) => e.createdAt).sort().at(-1) || null,
        lastReviewAt: lastHuman || null,
        lastReviewer: reviews.slice().sort((a, b) => String(a.submittedAt).localeCompare(String(b.submittedAt))).at(-1)?.author?.login || null,
        // For "read by you" (lib/own-read.mjs): the head commit, and who wrote each commit.
        nodeId: pr.id || null,
        base: pr.baseRefName || null,
        headOid: pr.headRefOid || null,
        ...(isBot(pr.author) || pr.author?.login !== me ? { openedBy: pr.author?.login || null } : {}),
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

    // Who wrote each commit, and the files you ticked Viewed (only when GitHub listed them all).
    for (let i = 0; i < myPrs.length; i += 10) {
      const chunk = myPrs.slice(i, i + 10).filter((p) => p.nodeId);
      if (!chunk.length) continue;
      try {
        const d = await gql(`query($ids: [ID!]!) { nodes(ids: $ids) { ... on PullRequest { id ${OWN_FIELDS} } } }`, { ids: chunk.map((p) => p.nodeId) });
        const by = new Map((d.nodes || []).filter(Boolean).map((n) => [n.id, n]));
        for (const p of chunk) { const n = by.get(p.nodeId); if (n) Object.assign(p, { commits: ownCommits(n), viewed: ownViewed(n) }); }
      } catch (e) { console.error(`clearsky: who wrote your PRs' commits: ${e.message}`); }
    }

    return { login: me, name: myName || null, orgs, reviewRequested, myPrs, mentions, assigned };
  }

  // PRs that carry a ticket key in their title or branch, open or recently closed, with where
  // each stands: for a ticket you don't have a PR of your own for in your lists.
  const ticketPrCache = new Map();
  // `fresh` skips the cache: Clearsky checks for a reviewer right before a ticket goes to review.
  async function ticketPrs(key, { fresh = false } = {}) {
    const hit = ticketPrCache.get(key);
    if (!fresh && hit && Date.now() - hit.at < 2 * 6e4) return hit.data;
    config.github.token ||= await ghCliToken();
    if (!config.github.token) return { prs: [], noGitHub: true };
    const scope = config.github.orgs.map((o) => `org:${o}`).join(' ');
    const d = await gql(`query($q: String!) { viewer { login } search(query: $q, type: ISSUE, first: 10) { nodes { ... on PullRequest { ${PR_FIELDS} mergedAt closedAt } } } }`,
      { q: `is:pr ${key} in:title ${scope}` });
    const me = d.viewer.login, re = new RegExp(`(^|[^A-Za-z0-9])${key}(?![0-9])`, 'i');
    const prs = (d.search?.nodes || []).filter((pr) => pr?.number && (re.test(pr.title) || re.test(pr.headRefName || ''))).map((pr) => {
      const reviews = latestReviewsByUser(pr, me);
      const state = pr.mergedAt ? 'merged' : pr.state === 'CLOSED' ? 'closed' : 'open';
      const status = state === 'open' ? myPrStatus(pr, pr.author?.login) : { label: state === 'merged' ? 'Merged' : 'Closed', owner: 'none', tone: state === 'merged' ? 'good' : 'neutral' };
      const p = { repo: pr.repository.nameWithOwner, number: pr.number, title: pr.title, url: pr.url, author: pr.author?.login || 'ghost', mine: pr.author?.login === me,
        state, draft: pr.isDraft, branch: pr.headRefName || null, ci: ciState(pr), status, updatedAt: pr.updatedAt,
        approvals: reviews.filter((r) => r.state === 'APPROVED').map((r) => r.author.login),
        changesRequested: reviews.filter((r) => r.state === 'CHANGES_REQUESTED').map((r) => r.author.login),
        pendingReviewers: humanReviewers(pr).map((n) => reviewerName(n.requestedReviewer)).filter(Boolean),
        // People who reviewed it, whatever they said (not bots, not its author).
        reviewers: latestReviewsByUser(pr, pr.author?.login).map((r) => r.author.login),
        askedMe: humanReviewers(pr).some((n) => n.requestedReviewer?.login === me) };
      return { ...p, next: state !== 'open' ? { label: `${p.status.label}: nothing left on this PR`, wait: true }
        : p.mine ? prNext(p) : p.askedMe ? reviewNext(p) : { label: `${p.author}'s PR: ${p.status.label.toLowerCase()}`, wait: true } };
    }).sort((a, b) => (a.state === 'open' ? 0 : 1) - (b.state === 'open' ? 0 : 1) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    const data = { key, prs };
    ticketPrCache.set(key, { at: Date.now(), data });
    return data;
  }

  // How each repo's main branch builds, and what it produced last (lib/builds.mjs).
  async function builds(repos) {
    config.github.token ||= await ghCliToken();
    if (!config.github.token) throw new Error('GITHUB_TOKEN is not set and `gh auth token` gave nothing');
    if (!repos.length) return [];
    const data = await gql(buildQuery(repos));
    return Promise.all(repos.map(async (r, i) => {
      const node = data?.[`r${i}`];
      if (!node) return { repo: r, error: 'not found, or no access' };
      // Artifacts are REST only; a repo without Actions, or without access to them, has none.
      const arts = await http(`${config.github.api}/repos/${r}/actions/artifacts?per_page=30`, { headers: { Authorization: `Bearer ${config.github.token}` } })
        .then((x) => x?.artifacts || []).catch(() => []);
      return buildOf(node, arts);
    }));
  }

  // ---- Milestones, for the Versions page when GitHub Issues is the tracker (lib/tracker.mjs):
  // a starred repo is a project, a milestone a version, and its issues and PRs the tickets.

  // Repos you can pick to star: in your organizations (all of yours without any), newest push first.
  async function repoChoices() {
    config.github.token ||= await ghCliToken();
    const d = await gql(`query { viewer { repositories(first: 100, affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER], orderBy: { field: PUSHED_AT, direction: DESC }) {
      nodes { nameWithOwner description isArchived } } } }`);
    const orgs = new Set(config.github.orgs.map((o) => o.toLowerCase()));
    return (d.viewer?.repositories?.nodes || []).filter((r) => r && !r.isArchived && (!orgs.size || orgs.has(r.nameWithOwner.split('/')[0].toLowerCase())))
      .map((r) => ({ key: r.nameWithOwner, name: r.nameWithOwner }));
  }

  const msCache = new Map();
  async function milestones(repo, force = false) {
    const hit = msCache.get(repo);
    if (!force && hit && Date.now() - hit.at < 10 * 6e4) return hit.data;
    config.github.token ||= await ghCliToken();
    const [owner, name] = repo.split('/');
    const d = await gql(`query($o: String!, $n: String!) { repository(owner: $o, name: $n) {
      milestones(first: 100, states: [OPEN, CLOSED], orderBy: { field: DUE_DATE, direction: ASC }) { nodes { title state dueOn description } } } }`, { o: owner, n: name });
    if (!d.repository) throw new Error(`${repo} not found`);
    const data = (d.repository.milestones?.nodes || []).map((m) => ({ name: m.title, released: m.state === 'CLOSED', releaseDate: m.dueOn ? m.dueOn.slice(0, 10) : null, description: m.description || '' }));
    msCache.set(repo, { at: Date.now(), data });
    return data;
  }

  const msIssueCache = new Map();
  async function milestoneIssues(repo, title, force = false) {
    const ck = `${repo}\n${title}`, hit = msIssueCache.get(ck);
    if (!force && hit && Date.now() - hit.at < 2 * 6e4) return hit.data;
    config.github.token ||= await ghCliToken();
    const fields = `number title url state updatedAt assignees(first: 1) { nodes { login } } labels(first: 10) { nodes { name } }`;
    const d = await gql(`query($q: String!) { search(query: $q, type: ISSUE, first: 100) { issueCount nodes {
      __typename ... on Issue { ${fields} } ... on PullRequest { ${fields} isDraft } } } }`, { q: `repo:${repo} milestone:"${String(title).replace(/"/g, '')}"` });
    const issues = (d.search?.nodes || []).filter((n) => n?.number).map((n) => {
      const closed = n.state !== 'OPEN', who = n.assignees?.nodes?.[0]?.login || null;
      // GitHub has open and closed only; someone on it counts as in progress.
      const status = closed ? (n.state === 'MERGED' ? 'Merged' : 'Closed') : who ? 'Assigned' : 'Open';
      return { key: `${repo}#${n.number}`, summary: n.title, url: n.url, status, statusCategory: closed ? 'done' : who ? 'indeterminate' : 'new',
        type: n.__typename === 'PullRequest' ? 'Pull request' : 'Issue', priority: (n.labels?.nodes || []).map((l) => l.name).find((l) => /^(p[0-4]|priority[: ].+|critical|high|low)$/i.test(l)) || null,
        assignee: who, updatedAt: n.updatedAt || null };
    });
    const data = { project: repo, version: title, issues, truncated: (d.search?.issueCount || 0) > issues.length, checkedAt: new Date().toISOString() };
    msIssueCache.set(ck, { at: Date.now(), data });
    return data;
  }

  return { gql, reviewerOptions, requestReviews, mergePr, ghCliToken, ticketPrs, builds, repoChoices, milestones, milestoneIssues, fetch: fetchGitHub };
}

// Who reviews it and where they stand, in a few words.
const prMeta = (p) => [p.approvals.length && `approved by ${p.approvals.join(', ')}`,
  p.changesRequested.length && `changes from ${p.changesRequested.join(', ')}`,
  p.pendingReviewers.length && `waiting on ${p.pendingReviewers.join(', ')}`,
  p.botSuggestions && `Copilot left ${p.botSuggestions} suggestion${p.botSuggestions > 1 ? 's' : ''}`].filter(Boolean).join(' · ');
// Working days (Monday to Friday) from `iso` to now.
export function workingDaysSince(iso, now = Date.now()) {
  if (!iso) return 0;
  let n = 0;
  for (let t = Date.parse(iso) + 864e5; t <= now; t += 864e5) { const d = new Date(t).getDay(); if (d !== 0 && d !== 6) n++; }
  return n;
}
export const NUDGE_DAYS = 3;
// A PR waiting for review, in a few words: one approval is usually all it takes, so how many
// were asked, when, and when anyone last answered. Quiet for NUDGE_DAYS working days: a nudge.
export function reviewProgress(p, now = Date.now()) {
  const asked = p.pendingReviewers.length + p.approvals.length + p.changesRequested.length + (p.commented?.length || 0);
  const since = [p.askedAt, p.lastReviewAt].filter(Boolean).sort().at(-1) || null;
  const quiet = workingDaysSince(since, now);
  const label = p.approvals.length ? [`${p.approvals.length} approved, needs more`, null]
    : quiet >= NUDGE_DAYS && !p.lastReviewAt ? [`no response in ${quiet}d`, 'amber']
      : quiet >= NUDGE_DAYS ? [`quiet for ${quiet}d`, 'amber'] : ['needs 1 approval', null];
  const step = [asked && `${asked} asked${p.askedAt ? ` ${shortAgo(p.askedAt)} ago` : ''}`,
    p.lastReviewAt ? `last review ${shortAgo(p.lastReviewAt)} ago${p.lastReviewer ? ` (${p.lastReviewer})` : ''}` : 'no reviews yet'].filter(Boolean).join(' · ');
  return { label, step, at: since };
}
const shortAgo = (iso) => {
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 6e4));
  return m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
};

const prLinks = (p) => [...ticketKeys(p.title, p.branch || '').map((k) => `issue:${k}`), ...(p.issues || []).map((i) => `gh:${i}`)];

// Routine or worth verifying (lib/advice.mjs), worked out once per PR.
const triaged = new WeakMap();
const triage = (p) => { if (!triaged.has(p)) triaged.set(p, reviewTriage(p)); return triaged.get(p); };

// GitHub's data as work items (see lib/items.mjs).
export function workItems(g) {
  if (!g || g.error) return [];
  const out = [];
  const add = (group, kind, x) => out.push({ group, kind, src: 'GitHub', k: x.url, ...x });
  [...(g.reviewRequested || [])].sort((a, b) => (b.rerequested - a.rerequested) || Date.parse(a.requestedAt) - Date.parse(b.requestedAt))
    .forEach((p) => add('needs', 'review', { url: p.url, stamp: p.stamp, pr: `${p.repo}#${p.number}`, ref: `${shortRepo(p.repo)} #${p.number}`, title: p.title,
      step: `${p.author} · +${p.size.additions} −${p.size.deletions}${p.viaTeam ? ' · via team' : ''} · ${triage(p).text}`, glyph: 'rev', triage: triage(p),
      label: p.draft ? ['draft'] : [`${p.rerequested ? 're-review' : 'review'} · ${triage(p).level}`, triage(p).level === 'routine' ? 'green' : 'amber'], at: p.requestedAt, links: prLinks(p), next: reviewNext(p), data: p }));
  (g.myPrs || []).forEach((p) => {
    // Waiting for people: how far the review has got, instead of each reviewer.
    const rp = p.status.label === 'Waiting for review' && reviewProgress(p);
    const row = { url: p.url, stamp: p.stamp, pr: `${p.repo}#${p.number}`,
      ref: `${shortRepo(p.repo)} #${p.number}`, title: p.title, step: rp ? rp.step : prMeta(p),
      glyph: p.status.owner === 'me' ? GLYPH[p.status.tone] || 'todo' : 'wait',
      label: rp ? rp.label : [p.status.label.toLowerCase(), p.status.owner === 'me' ? TONE[p.status.tone] : null],
      at: (rp && rp.at) || p.updatedAt, links: prLinks(p), next: prNext(p), data: rp ? { ...p, review: rp } : p };
    // Code under your name that reviewers see (or approved) before you've read it: yours first.
    const own = p.own;
    // (A conflict or failing CI stays the next step: reading comes after it's fixed.)
    if (own?.risk && own.state !== 'read' && !['Merge conflict', 'CI failing'].includes(p.status.label)) {
      return add('needs', 'pr', { ...row, stamp: `${p.stamp}|unread:${own.headOid}`, step: own.step, glyph: 'rev',
        next: { label: own.state === 'new' ? 'Read the new commits' : 'Read it', run: 'url', url: own.diffUrl || p.url } });
    }
    add(p.status.owner === 'me' ? 'needs' : 'waiting', 'pr', row);
  });
  (g.mentions || []).forEach((m) => add('needs', 'mention', { url: m.url, stamp: m.stamp, pr: m.kind === 'PR' ? `${m.repo}#${m.number}` : null,
    ref: `${shortRepo(m.repo)} #${m.number}`, title: m.title, step: `mentioned you in this ${m.kind === 'PR' ? 'PR' : 'issue'}`, glyph: 'ment',
    label: ['GitHub'], at: m.updatedAt, next: replyNext(m.url), data: m }));
  (g.assigned || []).forEach((i) => add('tickets', 'issue', { url: i.url, stamp: i.stamp, ref: `${shortRepo(i.repo)} #${i.number}`, title: i.title,
    glyph: 'todo', label: ['GitHub issue'], at: i.updatedAt, next: startNext(), data: i }));
  return out;
}
