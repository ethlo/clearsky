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
  assert.ok(acliCalls.some((a) => a[a.indexOf('--jql') + 1]?.startsWith('updated >= -14d AND (watcher')));
  assert.equal(d.jira.assigned[0].url, 'https://acme.atlassian.net/browse/OPS-1');
  assert.equal(d.jira.assigned[0].project, 'OPS');
  assert.equal(d.jira.mentions[0].url, 'https://acme.atlassian.net/browse/OPS-2?focusedCommentId=10');

  const md = toMarkdown(d);
  assert.match(md, /## Needs my review \(1\)/);
  assert.match(md, /\*\*Changes requested\*\* \(your move\)/);
  assert.match(md, /## Slack mentions \(2\)/);
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
