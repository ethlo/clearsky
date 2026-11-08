import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

// Never your own settings, state or extra sources: bin/clearsky.mjs reads them from the home folder.
process.env.HOME = mkdtempSync(join(tmpdir(), 'clearsky-home-'));
process.env.CLEARSKY_POLL_MINUTES = '0';
const acliLog = join(mkdtempSync(join(tmpdir(), 'clearsky-')), 'acli.log');
// Copilot's session folders: one work session (acme), one personal (no work repository).
const copilotHome = mkdtempSync(join(tmpdir(), 'clearsky-copilot-'));
mkdirSync(join(copilotHome, 'session-state', 'acp-session-1'), { recursive: true });
writeFileSync(join(copilotHome, 'session-state', 'acp-session-1', 'workspace.yaml'), 'id: acp-session-1\nrepository: acme/api\nbranch: feature/ops-9-pager\n');
mkdirSync(join(copilotHome, 'session-state', 'personal-1'), { recursive: true });
writeFileSync(join(copilotHome, 'session-state', 'personal-1', 'workspace.yaml'), 'repository: me/hack\nbranch: main\n');

const now = new Date().toISOString();
const hoursAgo = (h) => new Date(Date.now() - h * 36e5).toISOString();

const pr = (over = {}) => ({
  number: 1, title: 'A PR', url: 'https://github.com/acme/api/pull/1', isDraft: false,
  createdAt: hoursAgo(48), updatedAt: now, reviewDecision: 'REVIEW_REQUIRED', mergeable: 'MERGEABLE',
  additions: 10, deletions: 2, changedFiles: 1,
  repository: { nameWithOwner: 'acme/api' }, author: { login: 'me' },
  reviews: { nodes: [] }, reviewRequests: { nodes: [] }, reviewThreads: { nodes: [] },
  commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
  timelineItems: { nodes: [] },
  ...over,
});

let server, seen = [];
before(async () => {
  server = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const json = body ? JSON.parse(body) : null;
    seen.push({ url: req.url, auth: req.headers.authorization, json });
    const send = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };

    if (req.url === '/graphql') {
      if (json.query.includes('viewer { login }')) return send({ data: { viewer: { login: 'me' } } });
      if (json.query.includes('reviewed: search')) return send({ data: {
        mine: { nodes: [
          { number: 5, title: 'Shipped thing', url: 'u5', state: 'MERGED', isDraft: false, createdAt: hoursAgo(72), mergedAt: hoursAgo(5), repository: { nameWithOwner: 'acme/api' },
            commits: { nodes: [{ commit: { committedDate: hoursAgo(6), authors: { nodes: [{ user: { login: 'me' } }] } } }, { commit: { committedDate: hoursAgo(7), authors: { nodes: [{ user: { login: 'me' } }] } } }, { commit: { committedDate: hoursAgo(24 * 9), authors: { nodes: [{ user: { login: 'me' } }] } } }] } },
          { number: 6, title: 'New thing', url: 'u6', state: 'OPEN', isDraft: true, createdAt: hoursAgo(4), mergedAt: null, repository: { nameWithOwner: 'acme/api' },
            commits: { nodes: [{ commit: { committedDate: hoursAgo(3), authors: { nodes: [{ email: 'me@work.test', user: null }] } } }, { commit: { committedDate: hoursAgo(2), authors: { nodes: [{ email: 'anna@x', user: { login: 'anna' } }] } } }, { commit: { committedDate: hoursAgo(2), authors: { nodes: [{ email: '1+bob@users.noreply.github.com', user: null }] } } }] } },
          { number: 7, title: 'Old open', url: 'u7', state: 'OPEN', isDraft: false, createdAt: hoursAgo(24 * 9), mergedAt: null, repository: { nameWithOwner: 'acme/api' } },
        ] },
        reviewed: { nodes: [
          { number: 8, title: 'Their PR', url: 'u8', repository: { nameWithOwner: 'acme/web' }, author: { login: 'anna' }, reviews: { nodes: [{ state: 'APPROVED', submittedAt: hoursAgo(3) }] } },
          { number: 9, title: 'Reviewed long ago', url: 'u9', repository: { nameWithOwner: 'acme/web' }, author: { login: 'bob' }, reviews: { nodes: [{ state: 'COMMENTED', submittedAt: hoursAgo(24 * 9) }] } },
        ] },
      } });
      return send({ data: {
        reviewRequested: { nodes: [
          pr({ number: 7, author: { login: 'anna' }, url: 'https://github.com/acme/api/pull/7',
            reviews: { nodes: [{ state: 'COMMENTED', submittedAt: hoursAgo(30), author: { login: 'me' } }] },
            timelineItems: { nodes: [{ createdAt: hoursAgo(3), requestedReviewer: { __typename: 'User', login: 'me' } }] } }),
          pr({ number: 8, author: { login: 'dependabot[bot]' } }),
        ] },
        myPrs: { nodes: [
          pr({ number: 1, reviewDecision: 'CHANGES_REQUESTED',
            reviews: { nodes: [{ state: 'CHANGES_REQUESTED', author: { login: 'bob' } }] } }),
          pr({ number: 2, reviewDecision: 'APPROVED',
            reviews: { nodes: [{ state: 'APPROVED', author: { login: 'anna' } }] } }),
          pr({ number: 3, reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'Team', slug: 'core' } }] } }),
        ] },
        mentions: { nodes: [{ __typename: 'Issue', number: 99, title: 'Help?', url: 'https://github.com/acme/api/issues/99',
          updatedAt: now, repository: { nameWithOwner: 'acme/api' }, author: { login: 'carl' }, labels: { nodes: [] } }] },
        assigned: { nodes: [] },
      } });
    }
    if (req.url === '/slack/auth.test') return send({ ok: true, user_id: 'U1', user: 'alex', team: 'Acme' });
    if (req.url.startsWith('/slack/search.messages')) {
      const ts = (h) => String((Date.now() - h * 36e5) / 1000);
      return send({ ok: true, messages: { matches: [
        { ts: ts(1), user: 'U2', username: 'anna', text: '<@U1> can you look at <#C9|deploys>? cc <@U3|bob> <https://x.test|link>',
          channel: { name: 'payments', is_im: false }, permalink: 'https://acme.slack.com/archives/C1/p1' },
        { ts: ts(2), user: 'U2', username: 'anna', text: 'ping <@U1>', channel: { is_im: true }, permalink: 'https://acme.slack.com/archives/D1/p2' },
        { ts: ts(3), user: 'U1', username: 'alex', text: 'note to self <@U1>', channel: { name: 'x' }, permalink: '#' },
        { ts: ts(24 * 20), user: 'U2', username: 'anna', text: 'old <@U1>', channel: { name: 'x' }, permalink: '#' },
      ] } });
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  Object.assign(process.env, {
    GITHUB_TOKEN: 'gh-test', GITHUB_API_URL: base, GITHUB_ORGS: 'acme',
    ACLI_BIN: fileURLToPath(new URL('./fake-acli.mjs', import.meta.url)), FAKE_ACLI_LOG: acliLog,
    CLEARSKY_IGNORE_AUTHORS: 'dependabot[bot]',
    SLACK_TOKEN: 'xoxp-test', SLACK_API_URL: `${base}/slack`,
    COPILOT_BIN: fileURLToPath(new URL('./fake-copilot.mjs', import.meta.url)), CLEARSKY_COPILOT_HOME: copilotHome,
  });
});
after(() => server.close());

test('collects GitHub, Jira and the Slack plugin into one view', async () => {
  const { collect, toMarkdown } = await import('../bin/clearsky.mjs');
  const d = await collect();

  assert.equal(d.github.error, undefined);
  assert.equal(d.jira.error, undefined);

  assert.deepEqual(d.github.reviewRequested.map((p) => p.number), [7]); // bot filtered out
  assert.equal(d.github.reviewRequested[0].rerequested, true);
  assert.equal(d.github.reviewRequested[0].viaTeam, false);

  const status = Object.fromEntries(d.github.myPrs.map((p) => [p.number, p.status.label]));
  assert.deepEqual(status, { 1: 'Changes requested', 2: 'Ready to merge', 3: 'Waiting for review' });
  assert.deepEqual(d.github.myPrs[2].pendingReviewers, ['team:core']);

  assert.equal(d.jira.assigned[0].key, 'OPS-1');
  assert.equal(d.jira.mentions.length, 1, 'only the comment by someone else that mentions me');
  assert.equal(d.jira.mentions[0].excerpt, 'Hi @you, can you check this?');

  assert.deepEqual(d.summary, {
    reviewsWaiting: 1, myPrsNeedingAction: 2, myPrsWaitingOnOthers: 1, mentions: 4, jiraOpen: 1, jiraInProgress: 1,
  });

  // Slack is a plugin now, added for you because SLACK_TOKEN was set.
  const sl = d.sources.slack;
  assert.equal(sl.error, undefined);
  assert.deepEqual(sl.mentions.map((m) => m.channel), ['#payments', 'DM'], 'own and old messages dropped');
  assert.equal(sl.mentions[0].excerpt, '@you can you look at #deploys? cc @bob link');
  // Its rows need you, as mentions with Reply as the next step, and its replies join the plan.
  const rows = d.items.filter((i) => i.src === 'Slack');
  assert.deepEqual(rows.map((i) => [i.kind, i.group, i.next.label, i.ref]), [['mention', 'needs', 'Reply', '#payments'], ['mention', 'needs', 'Reply', 'DM']]);
  assert.equal(rows[0].k, `slack:${sl.mentions[0].url}`);
  const search = seen.find((s) => s.url.startsWith('/slack/search.messages'));
  assert.equal(search.auth, 'Bearer xoxp-test');
  assert.match(decodeURIComponent(search.url), /query=<@U1>[+ ]after:\d{4}-\d{2}-\d{2}/);

  // GitHub search is scoped to the org; Jira went through acli and fell back after the rejected JQL.
  const gql = seen.find((s) => s.json?.variables?.rr);
  assert.match(gql.json.variables.rr, /review-requested:me org:acme archived:false/);
  const acliCalls = readFileSync(acliLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(acliCalls.every((a) => a[0] === 'jira' && (a.includes('--json') || a[1] === 'auth')));
  assert.equal(d.jira.mentions[0].url.startsWith('https://acme.atlassian.net/'), true, 'links use the site, not acli\'s API host');
  assert.ok(acliCalls.some((a) => a[a.indexOf('--jql') + 1]?.startsWith('comment ~ currentUser() AND updated >= -14d')));
  assert.ok(!acliCalls.some((a) => a[2] === 'comment'), 'comments are read through workitem view');
  assert.equal(d.jira.assigned[0].url, 'https://acme.atlassian.net/browse/OPS-1');
  assert.equal(d.jira.assigned[0].project, 'OPS');
  assert.equal(d.jira.mentions[0].url, 'https://acme.atlassian.net/browse/OPS-2?focusedCommentId=10');

  const md = toMarkdown(d);
  assert.match(md, /## Needs my review \(1\)/);
  assert.match(md, /\*\*Changes requested\*\* \(your move\)/);
  assert.match(md, /## Slack mentions \(2\)/);
});

test('stand-up: yesterday from GitHub and Jira, today from the queue', async () => {
  const { standup, nextStandup, previousStandup } = await import('../bin/clearsky.mjs');
  const fmt = (d) => `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]} ${d.toTimeString().slice(0, 5)}`;
  // Stand-up at 09:45 (default). Monday morning: next is today, previous was Friday.
  assert.equal(fmt(nextStandup(new Date('2026-11-02T08:00:00'))), 'Mon 09:45');
  assert.equal(fmt(previousStandup(new Date('2026-11-02T08:00:00'))), 'Fri 09:45');
  // Monday afternoon: next is Tuesday, so the summary covers since Monday's stand-up.
  assert.equal(fmt(nextStandup(new Date('2026-11-02T14:00:00'))), 'Tue 09:45');
  assert.equal(fmt(previousStandup(new Date('2026-11-02T14:00:00'))), 'Mon 09:45');
  // During the stand-up it is still today's.
  assert.equal(fmt(nextStandup(new Date('2026-11-02T09:50:00'))), 'Mon 09:45');
  const { parseWorkdays } = await import('../bin/clearsky.mjs');
  assert.deepEqual([...parseWorkdays('Mon-Fri')], [1, 2, 3, 4, 5]);
  assert.deepEqual([...parseWorkdays('Sun-Thu')], [0, 1, 2, 3, 4]);
  assert.deepEqual([...parseWorkdays('mon, wed,fri')], [1, 3, 5]);
  // Saturday: next is Monday, previous Friday.
  assert.equal(fmt(previousStandup(new Date('2026-10-31T12:00:00'))), 'Fri 09:45');
  // A fixed 12-hour window, so the result doesn't depend on the time of day.
  const s = await standup(undefined, new Date(Date.now() - 12 * 36e5));
  assert.equal(s.yesterday.github.error, undefined);
  assert.deepEqual(s.yesterday.github.merged.map((p) => p.number), [5]);
  assert.deepEqual(s.yesterday.github.opened.map((p) => p.number), [6]);
  assert.deepEqual(s.yesterday.github.reviewed.map((p) => [p.number, p.verdict]), [[8, 'APPROVED']]);
  assert.deepEqual(s.yesterday.github.commits, [{ repo: 'acme/api', count: 3 }], 'my recent commits on my PRs');
  assert.deepEqual(s.yesterday.jira.touched.map((i) => i.key), ['OPS-9']);
  assert.match(s.text, /\*Merged and in review\*\n- Merged, ready to test: acme\/api#5 Shipped thing/);
  assert.match(s.text, /Reviewed acme\/web#8 by anna \(approved\)/);
  assert.match(s.text, /Worked on OPS-9: Pager rotation \(In Review\)/);
  assert.match(s.text, /\*Today\*\n- Continue OPS-1: Rotate certs/);
  // Recent Copilot sessions count as work too; older ones don't.
  assert.match(s.text, /With Copilot: OPS-9 Check the repo \(api, feature\/ops-9-pager\)/);
  assert.ok(!/From the terminal|Personal hack/.test(s.text), 'old and personal sessions are left out');
});

test('PR status: who has the ball', async () => {
  const { myPrStatus } = await import('../bin/clearsky.mjs');
  const label = (o) => myPrStatus(pr(o), 'me').label;
  assert.equal(label({ isDraft: true }), 'Draft');
  assert.equal(label({ mergeable: 'CONFLICTING' }), 'Merge conflict');
  assert.equal(label({ commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE' } } }] } }), 'CI failing');
  assert.equal(label({ reviewThreads: { nodes: [{ isResolved: false }, { isResolved: true }] } }), '1 unresolved thread');
  assert.equal(label({ reviewDecision: 'APPROVED', commits: { nodes: [{ commit: { statusCheckRollup: { state: 'PENDING' } } }] } }), 'Approved, CI running');
  assert.equal(label({ reviewDecision: null, reviews: { nodes: [{ state: 'APPROVED', author: { login: 'x' } }, { state: 'COMMENTED', author: { login: 'x' } }] } }), 'Ready to merge');
  const commented = { reviews: { nodes: [{ state: 'COMMENTED', submittedAt: hoursAgo(1), author: { login: 'x' } }] } };
  assert.equal(label({ ...commented, commits: { nodes: [{ commit: { committedDate: hoursAgo(2) } }] } }), 'Has feedback');
  assert.equal(label({ ...commented, commits: { nodes: [{ commit: { committedDate: hoursAgo(0.5) } }] } }), 'Waiting for review', 'pushed since the feedback');
  const asked = { reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'User', login: 'anna' } }] } };
  assert.equal(label(asked), 'Waiting for review');
  assert.equal(label({}), 'Ready for a reviewer', 'Copilot\'s rounds done and CI green');
  assert.equal(label({ commits: { nodes: [{ commit: {} }] } }), 'No reviewer yet', 'no CI at all');
  // A build started by hand isn't in the rollup, only in the commit's check suites.
  const suites = (status, conclusion) => ({ commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' },
    checkSuites: { nodes: [{ status, conclusion, workflowRun: { event: 'workflow_dispatch', url: 'https://ci/1', workflow: { name: 'Build' } } }] } } }] } });
  assert.deepEqual(myPrStatus(pr(suites('IN_PROGRESS', null)), 'me'), { label: 'CI build running', detail: 'Build', url: 'https://ci/1', owner: 'others', tone: 'wait' });
  assert.equal(label(suites('COMPLETED', 'FAILURE')), 'CI failing');
  assert.equal(label(suites('COMPLETED', 'SUCCESS')), 'Ready for a reviewer');
  // GitHub's own runs (Copilot's reviewer, code scanning) aren't the repo's CI; a rerun counts by its latest.
  const run = (event, name, conclusion) => ({ status: 'COMPLETED', conclusion, workflowRun: { event, url: `https://ci/${name}`, workflow: { name } } });
  const many = (...nodes) => ({ commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' }, checkSuites: { nodes } } }] } });
  assert.equal(label(many(run('dynamic', 'Copilot', 'FAILURE'), run('dynamic', 'GitHub Advanced Security', 'FAILURE'), run('pull_request', 'Build', 'SUCCESS'))), 'Ready for a reviewer');
  assert.equal(label(many(run('workflow_dispatch', 'Build', 'FAILURE'), run('workflow_dispatch', 'Build', 'SUCCESS'))), 'Ready for a reviewer');
  // Copilot's reviewer bot comments after every push; that never makes it your move.
  const bot = { __typename: 'Bot', login: 'copilot-pull-request-reviewer' };
  assert.equal(label({ ...asked, reviews: { nodes: [{ state: 'COMMENTED', submittedAt: hoursAgo(0.1), author: bot }] },
    reviewRequests: { nodes: [...asked.reviewRequests.nodes, { requestedReviewer: bot }] },
    reviewThreads: { nodes: [{ isResolved: false, comments: { nodes: [{ author: bot }] } }] },
    commits: { nodes: [{ commit: { committedDate: hoursAgo(0.2) } }] } }), 'Waiting for review');
  // Before any person is asked: rounds with Copilot, then Request review.
  const status = (o) => myPrStatus(pr(o), 'me');
  assert.deepEqual(status({ reviewRequests: { nodes: [{ requestedReviewer: bot }] } }), { label: 'In review rounds', detail: 'Copilot reviewing', owner: 'others', tone: 'wait' });
  const botThread = (extra = {}) => ({ isResolved: false, ...extra, comments: { nodes: [{ author: bot }] } });
  assert.deepEqual(status({ reviewThreads: { nodes: [botThread(), botThread()] } }), { label: 'In review rounds', detail: '2 Copilot comments', owner: 'me', tone: 'warn' });
  assert.equal(label({ reviewThreads: { nodes: [botThread({ isResolved: true })] } }), 'Ready for a reviewer', 'rounds done');
  // Threads you answered last, or that are outdated, aren't yours.
  const thread = (login, extra = {}) => ({ isResolved: false, ...extra, comments: { nodes: [{ author: { __typename: 'User', login } }] } });
  assert.equal(label({ ...asked, reviewThreads: { nodes: [thread('me'), thread('anna', { isOutdated: true })] } }), 'Waiting for review');
  assert.equal(label({ ...asked, reviewThreads: { nodes: [thread('anna')] } }), '1 unresolved thread');
  // The latest plain comment per person counts, not their first.
  const twice = { ...asked, reviews: { nodes: [{ state: 'COMMENTED', submittedAt: hoursAgo(48), author: { login: 'x' } }, { state: 'COMMENTED', submittedAt: hoursAgo(1), author: { login: 'x' } }] } };
  assert.equal(label({ ...twice, commits: { nodes: [{ commit: { committedDate: hoursAgo(2) } }] } }), 'Has feedback');
});

test('Now / Next: free slot and tasks that fit it', async () => {
  const { planNow } = await import('../bin/clearsky.mjs');
  const at = (h, m = 0) => { const d = new Date(); d.setHours(h, m, 0, 0); return d.getTime(); };
  const ev = (title, h1, m1, h2, m2) => ({ title, start: new Date(at(h1, m1)).toISOString(), end: new Date(at(h2, m2)).toISOString(), allDay: false });
  const data = {
    calendar: { events: [ev('Sync', 9, 0, 9, 15), ev('1:1', 9, 15, 9, 45), ev('Daily stand-up', 9, 45, 10, 0), ev('Design review', 11, 0, 12, 0)] },
    github: {
      reviewRequested: [
        { repo: 'a/b', number: 1, title: 'Big', url: 'u1', requestedAt: new Date(at(8)).toISOString(), size: { additions: 900, deletions: 10 } },
        { repo: 'a/b', number: 2, title: 'Small', url: 'u2', requestedAt: new Date(at(8)).toISOString(), size: { additions: 20, deletions: 5 } },
      ],
      myPrs: [{ repo: 'a/b', number: 3, title: 'Mine', url: 'u3', stamp: 's3', draft: false, status: { label: 'Ready to merge', owner: 'me' } }],
    },
    jira: { assigned: [{ key: 'OPS-1', summary: 'Certs', url: 'u4', statusCategory: 'indeterminate' }], mentions: [] },
    slack: { disabled: true },
  };
  // During the sync: back-to-back 1:1 and stand-up extend the busy block to 10:00, then 60 min free.
  const p = planNow(data, at(9, 5), {}, {}, {});
  assert.equal(p.now.title, 'Sync');
  assert.equal(p.next.title, 'Design review');
  assert.equal(p.freeMinutes, 60);
  assert.ok(!p.agenda.some((e) => e.title === 'Stand-up'), 'calendar already has the stand-up');
  assert.deepEqual(p.suggestions.map((s) => s.title), ['Merge a/b#3', 'Review a/b#2', 'Continue OPS-1']);
  // What plugins put forward (their plan() hook) comes right after merging.
  const withReply = planNow({ ...data, extraTasks: [{ key: 'slack:u9', title: 'Reply to anna in #team', url: 'u9', stamp: '1', minutes: 5, why: 'Slack mention' }] }, at(9, 5), {}, {}, {});
  assert.deepEqual(withReply.suggestions.map((s) => s.title), ['Merge a/b#3', 'Reply to anna in #team', 'Review a/b#2']);

  // Dismissed (same stamp) and muted items drop out; a dismissed item with new activity comes back.
  const later = new Date(at(9, 5) + 36e5).toISOString();
  const q = planNow(data, at(9, 5), { u3: 's3' }, { u2: later }, {});
  const titles = q.suggestions.map((s) => s.title);
  assert.ok(!titles.includes('Merge a/b#3') && !titles.includes('Review a/b#2'), titles.join());
  assert.deepEqual(q.muted.map((m) => [m.key, m.until]), [['u2', later]]);
  assert.deepEqual(q.done.map((c) => c.key), ['u3'], 'done tasks are listed with their time');
  assert.equal(planNow(data, at(9, 5), { u3: 'older' }, {}, {}).suggestions[0].title, 'Merge a/b#3');
});

test('finds your local clone of a PR repository', async () => {
  const { findCheckout } = await import('../bin/clearsky.mjs');
  const root = mkdtempSync(join(tmpdir(), 'clearsky-code-'));
  mkdirSync(join(root, 'acme', 'api', '.git'), { recursive: true });
  writeFileSync(join(root, 'acme', 'api', '.git', 'config'), '[remote "origin"]\n\turl = git@github.com:acme/api.git\n');
  mkdirSync(join(root, 'fork', 'api', '.git'), { recursive: true });
  writeFileSync(join(root, 'fork', 'api', '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/someone/api\n');
  assert.equal(findCheckout('acme/api', [root]), join(root, 'acme', 'api'));
  assert.equal(findCheckout('acme/web', [root]), null);
  assert.equal(findCheckout('someone/api', [root]), join(root, 'fork', 'api'));
});

test('picks the worktree that has the PR branch checked out', async () => {
  const { worktreeFor } = await import('../bin/clearsky.mjs');
  const { execFileSync } = await import('node:child_process');
  const root = mkdtempSync(join(tmpdir(), 'clearsky-wt-'));
  const clone = join(root, 'abc');
  const git = (...a) => execFileSync('git', ['-C', clone, ...a], { stdio: 'ignore' });
  mkdirSync(clone);
  git('init', '-q', '-b', 'main');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x');
  git('worktree', 'add', '-q', '-b', 'ABC-1', join(root, 'abc-1'));
  assert.equal(worktreeFor(clone, 'ABC-1'), join(root, 'abc-1'));
  assert.equal(worktreeFor(clone, 'other'), null);
  assert.equal(worktreeFor(clone, null), null);
});

test('links Copilot sessions to the PRs and tickets they work on', async () => {
  const { linkSessions } = await import('../bin/clearsky.mjs');
  const prs = [{ repo: 'Acme/api', number: 7, branch: 'feat/ABC-12-login' }, { repo: 'acme/web', number: 9, branch: 'fix' }];
  const ws = {
    s1: { repository: 'https://github.com/acme/api.git', branch: 'feat/ABC-12-login' },
    s2: { repository: 'acme/web', branch: 'main' },
    s3: {},
  };
  const sessions = [
    { id: 's1', title: 'Login work', updatedAt: '2026-10-29T08:00:00Z', status: 'working' },
    { id: 's2', title: 'Review PR #9', updatedAt: '2026-10-29T07:00:00Z' },
    { id: 's3', title: 'Look at https://github.com/acme/web/pull/9', updatedAt: '2026-10-29T06:00:00Z' },
    { id: 's4', title: 'Untouched', updatedAt: '2026-10-29T05:00:00Z' },
  ];
  const links = linkSessions(sessions, { prs, refs: { s4: ['issue:XYZ-1'] }, workspace: (id) => ws[id] || {} });
  assert.deepEqual(links['pr:Acme/api#7'].map((x) => [x.id, x.status]), [['s1', 'working']], 'by checkout branch, repo given as a URL');
  assert.deepEqual(links['issue:ABC-12'].map((x) => x.id), ['s1'], 'ticket from the branch name');
  assert.deepEqual(links['pr:acme/web#9'].map((x) => [x.id, x.status]), [['s2', 'closed'], ['s3', 'closed']], 'by number in the repo, or by URL');
  assert.deepEqual(links['issue:XYZ-1'].map((x) => x.id), ['s4'], 'refs attached in Clearsky');
  // A session that worked on a branch before its PR existed links once the PR is opened.
  const later = linkSessions([{ id: 'b1', title: 'Work', updatedAt: '2026-10-29T08:00:00Z' }],
    { prs: [{ repo: 'acme/api', number: 8, branch: 'feat/later' }], workspace: () => ({ repository: 'acme/api', branch: 'main', branches: ['main', 'feat/later'] }) });
  assert.deepEqual(later['pr:acme/api#8'].map((x) => x.id), ['b1']);

  // A ticket's sessions show on its PR and the other way round.
  const cross = linkSessions([{ id: 't1', title: 'ABC-5 · Fix capture', updatedAt: '2026-10-29T08:00:00Z' }],
    { prs: [{ repo: 'acme/abc', number: 3, title: 'ABC-5: Fix capture', branch: 'x' }] });
  assert.deepEqual(cross['pr:acme/abc#3'].map((x) => x.id), ['t1']);
  // …and with the GitHub issues it closes.
  const closes = linkSessions([{ id: 'g1', title: 'Look at https://github.com/acme/abc/issues/12', updatedAt: '2026-10-29T08:00:00Z' }],
    { prs: [{ repo: 'acme/abc', number: 3, title: 'Fix', issues: ['acme/abc#12'] }] });
  assert.deepEqual(closes['pr:acme/abc#3'].map((x) => x.id), ['g1']);
  assert.deepEqual(closes['gh:acme/abc#12'].map((x) => x.id), ['g1']);
});

test('a chat started on an item is named after it', async () => {
  const { itemSessionName } = await import('../bin/clearsky.mjs');
  const data = { github: { myPrs: [{ repo: 'acme/abc', number: 3, title: '[ABC-5] Fix capture', branch: 'feature/ABC-5-capture' }] },
    jira: { assigned: [{ key: 'ABC-6', summary: 'Rotate certs' }] } };
  const cache = (n) => data[n] || {};
  assert.equal(itemSessionName({ kind: 'issue', key: 'ABC-6' }, cache), 'ABC-6 · Rotate certs');
  assert.equal(itemSessionName({ kind: 'issue', key: 'ABC-9' }, cache), 'ABC-9');
  assert.equal(itemSessionName({ kind: 'pr', repo: 'acme/abc', number: 3 }, cache), 'ABC-5 · abc#3 · Fix capture');
  assert.equal(itemSessionName({ kind: 'pr', repo: 'acme/web', number: 4 }, cache), 'web#4');
});

test('names sessions started here after what you typed, not the dashboard in front of it', async () => {
  const { sessionTitle, linkSessions } = await import('../bin/clearsky.mjs');
  const dash = 'You are helping me with my work. This is my work dashboard right now:\n\nReviews: acme/web#9 OPS-4';
  assert.equal(sessionTitle(`${dash}\n\n---\nMy message:\nWhy is CI red?`), 'Why is CI red?');
  assert.equal(sessionTitle(dash, 'Plan my afternoon'), 'Plan my afternoon', 'the title saved when the chat started');
  assert.equal(sessionTitle(dash), 'Chat from Clearsky');
  assert.equal(sessionTitle('Fix OPS-4 in the terminal'), 'Fix OPS-4 in the terminal');
  const links = linkSessions([{ id: 's1', title: sessionTitle(dash), updatedAt: '2026-10-29T08:00:00Z' }],
    { prs: [{ repo: 'acme/web', number: 9 }], workspace: () => ({ repository: 'acme/web', branch: 'main' }) });
  assert.deepEqual(links, {}, 'the dashboard text links nothing');
});

test('sources: fresh data as is, older data at once with a new fetch behind it, Refresh waits', async () => {
  const { source, SOURCES, sourceCache } = await import('../bin/clearsky.mjs');
  let n = 0, release;
  SOURCES.swrTest = () => { n++; return n === 1 ? Promise.resolve({ v: 1 }) : new Promise((r) => { release = () => r({ v: n }); }); };
  try {
    assert.deepEqual(await source('swrTest'), { v: 1 });
    assert.deepEqual(await source('swrTest'), { v: 1 });
    assert.equal(n, 1, 'fresh: no new fetch');
    sourceCache.get('swrTest').at -= 5 * 6e4;
    assert.deepEqual(await source('swrTest'), { v: 1 }, 'stale: the kept data, at once');
    assert.equal(n, 2, 'and a fetch behind it');
    assert.deepEqual(await source('swrTest'), { v: 1 }, 'still the kept data while that runs');
    assert.equal(n, 2, 'one fetch at a time');
    const waited = source('swrTest', true);
    release();
    assert.deepEqual(await waited, { v: 2 }, 'Refresh gets the new data');
    sourceCache.get('swrTest').at -= 60 * 6e4;
    const old = source('swrTest');
    await new Promise((r) => setImmediate(r)); // the fetch starts a tick later
    release();
    assert.deepEqual(await old, { v: 3 }, 'too old to show: waits');
  } finally { delete SOURCES.swrTest; sourceCache.delete('swrTest'); }
});

test('logins are kept alive at random times, 30 minutes to 2 hours apart', async () => {
  const { keepAliveDelay } = await import('../bin/clearsky.mjs');
  assert.equal(keepAliveDelay(() => 0), 30 * 6e4);
  assert.equal(keepAliveDelay(() => 1), 120 * 6e4);
  assert.equal(keepAliveDelay(() => 0.5), 75 * 6e4);
});
