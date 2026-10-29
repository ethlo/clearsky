import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const acliLog = join(mkdtempSync(join(tmpdir(), 'clearsky-')), 'acli.log');

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
            commits: { nodes: [{ commit: { committedDate: hoursAgo(3), authors: { nodes: [{ user: { login: 'me' } }] } } }, { commit: { committedDate: hoursAgo(2), authors: { nodes: [{ user: { login: 'anna' } }] } } }] } },
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
    if (req.url === '/slack/auth.test') return send({ ok: true, user_id: 'U1', user: 'morten', team: 'Acme' });
    if (req.url.startsWith('/slack/search.messages')) {
      const ts = (h) => String((Date.now() - h * 36e5) / 1000);
      return send({ ok: true, messages: { matches: [
        { ts: ts(1), user: 'U2', username: 'anna', text: '<@U1> can you look at <#C9|deploys>? cc <@U3|bob> <https://x.test|link>',
          channel: { name: 'payments', is_im: false }, permalink: 'https://acme.slack.com/archives/C1/p1' },
        { ts: ts(2), user: 'U2', username: 'anna', text: 'ping <@U1>', channel: { is_im: true }, permalink: 'https://acme.slack.com/archives/D1/p2' },
        { ts: ts(3), user: 'U1', username: 'morten', text: 'note to self <@U1>', channel: { name: 'x' }, permalink: '#' },
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
  });
});
after(() => server.close());

test('collects GitHub, Jira and Slack into one view', async () => {
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

  assert.equal(d.slack.error, undefined);
  assert.deepEqual(d.slack.mentions.map((m) => m.channel), ['#payments', 'DM'], 'own and old messages dropped');
  assert.equal(d.slack.mentions[0].excerpt, '@you can you look at #deploys? cc @bob link');
  const search = seen.find((s) => s.url.startsWith('/slack/search.messages'));
  assert.equal(search.auth, 'Bearer xoxp-test');
  assert.match(decodeURIComponent(search.url), /query=<@U1>[+ ]after:\d{4}-\d{2}-\d{2}/);

  // GitHub search is scoped to the org; Jira went through acli and fell back after the rejected JQL.
  const gql = seen.find((s) => s.json?.variables?.rr);
  assert.match(gql.json.variables.rr, /review-requested:me org:acme archived:false/);
  const acliCalls = readFileSync(acliLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(acliCalls.every((a) => a[0] === 'jira' && a.includes('--json')));
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
  const s = await standup();
  assert.equal(s.yesterday.github.error, undefined);
  assert.deepEqual(s.yesterday.github.merged.map((p) => p.number), [5]);
  assert.deepEqual(s.yesterday.github.opened.map((p) => p.number), [6]);
  assert.deepEqual(s.yesterday.github.reviewed.map((p) => [p.number, p.verdict]), [[8, 'APPROVED']]);
  assert.deepEqual(s.yesterday.github.commits, [{ repo: 'acme/api', count: 3 }], 'my recent commits on my PRs');
  assert.deepEqual(s.yesterday.jira.touched.map((i) => i.key), ['OPS-9']);
  assert.match(s.text, /Merged acme\/api#5: Shipped thing/);
  assert.match(s.text, /Reviewed acme\/web#8 by anna \(approved\)/);
  assert.match(s.text, /Worked on OPS-9: Pager rotation \(In Review\)/);
  assert.match(s.text, /\*Today\*\n- Continue OPS-1: Rotate certs/);
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
  assert.equal(label({ reviews: { nodes: [{ state: 'COMMENTED', author: { login: 'x' } }] } }), 'Has feedback');
  assert.equal(label({}), 'Waiting for review');
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
      myPrs: [{ repo: 'a/b', number: 3, title: 'Mine', url: 'u3', draft: false, status: { label: 'Ready to merge', owner: 'me' } }],
    },
    jira: { assigned: [{ key: 'OPS-1', summary: 'Certs', url: 'u4', statusCategory: 'indeterminate' }], mentions: [] },
    slack: { disabled: true },
  };
  // During the sync: back-to-back 1:1 and stand-up extend the busy block to 10:00, then 60 min free.
  const p = planNow(data, at(9, 5));
  assert.equal(p.now.title, 'Sync');
  assert.equal(p.next.title, 'Design review');
  assert.equal(p.freeMinutes, 60);
  assert.ok(!p.agenda.some((e) => e.title === 'Stand-up'), 'calendar already has the stand-up');
  assert.deepEqual(p.suggestions.map((s) => s.title), ['Merge a/b#3', 'Review a/b#2', 'Continue OPS-1']);
});
