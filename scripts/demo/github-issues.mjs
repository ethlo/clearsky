// The demo with GitHub Issues as the tracker (CLEARSKY_DEMO_TRACKER=github, lib/tracker.mjs):
// the same made-up work, with PRs that close GitHub issues instead of Jira keys in their titles,
// and milestones for the Versions page.
import { github, standup, ago, ME } from './data.mjs';

// The Jira key in a demo PR's title, as the GitHub issue it closes now: [repo, number, title].
const ISSUES = {
  'PAY-412': ['acme/payments-api', 241, 'Partial refunds for split payments'],
  'PAY-415': ['acme/payments-api', 238, 'Retry webhook delivery with backoff'],
  'PAY-420': ['acme/payments-api', 244, 'Ledger export as CSV'],
  'PAY-398': ['acme/web-shop', 88, 'Show refund status on the order page'],
  'PAY-422': ['acme/web-shop', 91, 'Show refunds in the order history'],
  'PAY-409': ['acme/payments-api', 229, 'Idempotency keys for refunds'],
};
const node = ([repo, number, title]) => ({ number, title, repository: { nameWithOwner: repo } });
const url = ([repo, number]) => `https://github.com/${repo}/issues/${number}`;

export function useGitHubIssues() {
  for (const p of [...github.reviewRequested, ...github.myPrs, ...standup.mine]) {
    const key = String(p.title).match(/^([A-Z]+-\d+):\s*/)?.[1];
    if (!key || !ISSUES[key]) continue;
    p.title = p.title.slice(key.length + 1).trim();
    p.closingIssuesReferences = { nodes: [node(ISSUES[key])] };
    if (p.headRefName) p.headRefName = p.headRefName.replace(key, String(ISSUES[key][1]));
  }
  const issue = (i, h, labels = []) => ({ __typename: 'Issue', number: i[1], title: i[2], url: url(i), updatedAt: ago(h), repository: { nameWithOwner: i[0] }, author: { login: 'anna' }, labels: { nodes: labels.map((name) => ({ name })) } });
  github.assigned.push(issue(ISSUES['PAY-412'], 2, ['feature']), issue(ISSUES['PAY-420'], 5, ['feature']), issue(ISSUES['PAY-398'], 1, ['feature']),
    issue(['acme/payments-api', 247, 'Payout report shows wrong currency for SEK'], 26, ['bug']));
}

const day = (d) => new Date(Date.now() + d * 864e5).toISOString();
export const milestones = {
  'acme/payments-api': [{ title: 'v2.13', state: 'CLOSED', dueOn: day(-12) }, { title: 'v2.14', state: 'OPEN', dueOn: day(9), description: 'Refunds for split payments' }, { title: 'v2.15', state: 'OPEN', dueOn: day(37) }],
  'acme/web-shop': [{ title: 'Spring sale', state: 'OPEN', dueOn: day(4) }, { title: 'Checkout v3', state: 'OPEN', dueOn: null }],
};
// [number, title, state, assignee, kind, labels]
const row = ([number, title, state, who, kind = 'Issue', labels = []], repo) => ({ __typename: kind, number, title, url: `https://github.com/${repo}/${kind === 'Issue' ? 'issues' : 'pull'}/${number}`, state,
  updatedAt: ago(number % 40), assignees: { nodes: who ? [{ login: who }] : [] }, labels: { nodes: labels.map((name) => ({ name })) } });
const inMilestone = {
  'acme/payments-api v2.14': [
    [241, 'Partial refunds for split payments', 'OPEN', ME, 'Issue', ['feature', 'P1']], [244, 'Ledger export as CSV', 'OPEN', ME, 'Issue', ['feature']],
    [238, 'Retry webhook delivery with backoff', 'OPEN', 'anna', 'Issue', ['P1']], [247, 'Payout report shows wrong currency for SEK', 'OPEN', null, 'Issue', ['bug', 'P1']],
    [249, 'Rotate the webhook signing secret', 'OPEN', null, 'Issue', ['P3']], [229, 'Idempotency keys for refunds', 'CLOSED', ME, 'Issue', ['feature']],
    [478, 'Idempotency keys for refunds', 'MERGED', ME, 'PullRequest'], [235, 'Refund API: problem details in errors', 'CLOSED', 'bob', 'Issue', ['P2']],
    [236, 'Book refunds per payment method in the ledger', 'CLOSED', 'carla', 'Issue'], [479, 'Partial refunds for split payments', 'OPEN', ME, 'PullRequest'],
  ],
  'acme/web-shop Spring sale': [[88, 'Show refund status on the order page', 'OPEN', ME, 'Issue'], [91, 'Show refunds in the order history', 'OPEN', ME], [80, 'Banner for the sale', 'CLOSED', 'bob']],
};
export const milestoneRows = (repo, title) => (inMilestone[`${repo} ${title}`] || []).map((r) => row(r, repo));
// The stand-up's issues: closed since the last one, and open ones you worked on.
export const standupIssues = () => ({
  closed: [{ number: 229, title: 'Idempotency keys for refunds', url: url(ISSUES['PAY-409']), state: 'CLOSED', updatedAt: ago(18), closedAt: ago(18), repository: { nameWithOwner: 'acme/payments-api' } }],
  touched: [{ number: 238, title: 'Retry webhook delivery with backoff', url: url(ISSUES['PAY-415']), state: 'OPEN', updatedAt: ago(16), closedAt: null, repository: { nameWithOwner: 'acme/payments-api' } }],
});
