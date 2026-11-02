// Made-up work for Clearsky's demo (scripts/demo/run.mjs): a fictional company, people, repos,
// tickets and meetings, so screenshots show a lived-in dashboard without anything real.
export const ME = 'alex';
const H = 36e5;
export const ago = (h) => new Date(Date.now() - h * H).toISOString();
// The day is laid out around now, so the demo looks the same whenever it runs: the stand-up is
// the first quarter hour at least 40 minutes away, and the rest of the day follows it.
const Q = 15 * 60_000;
export const standupAt = () => new Date(Math.ceil((Date.now() + 40 * 60_000) / Q) * Q);
export const at = (hours, dayOffset = 0) => new Date(standupAt().getTime() + hours * H + dayOffset * 24 * H);
export const hhmm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

const suite = (name, conclusion, status = 'COMPLETED') => ({ status, conclusion, workflowRun: { event: 'pull_request', url: `https://github.com/acme/x/actions/runs/${Math.floor(Math.random() * 1e6)}`, workflow: { name } } });
export const pr = (o) => ({
  number: 1, title: 'A change', url: `https://github.com/${o.repo || 'acme/payments-api'}/pull/${o.number || 1}`, state: 'OPEN', isDraft: false,
  createdAt: ago(30), updatedAt: ago(2), reviewDecision: 'REVIEW_REQUIRED', mergeable: 'MERGEABLE', headRefName: 'feature/x',
  additions: 120, deletions: 34, changedFiles: 6, repository: { nameWithOwner: o.repo || 'acme/payments-api' }, author: { login: ME },
  reviews: { nodes: [] }, reviewRequests: { nodes: [] }, reviewThreads: { nodes: [] },
  commits: { nodes: [{ commit: { committedDate: ago(3), statusCheckRollup: { state: o.ci || 'SUCCESS' }, checkSuites: { nodes: [suite('build', o.ci === 'FAILURE' ? 'FAILURE' : 'SUCCESS')] } } }] },
  closingIssuesReferences: { nodes: [] }, timelineItems: { nodes: [] }, files: { nodes: (o.paths || ['src/main/java/com/acme/pay/Refunds.java']).map((path) => ({ path })) },
  ...o,
});
const user = (login) => ({ requestedReviewer: { __typename: 'User', login } });
const review = (login, state, h) => ({ state, submittedAt: ago(h), author: { __typename: 'User', login } });
const thread = (login, resolved = false) => ({ isResolved: resolved, isOutdated: false, comments: { nodes: [{ author: { __typename: 'User', login } }] } });

export const github = {
  reviewRequested: [
    pr({ number: 482, repo: 'acme/payments-api', title: 'PAY-415: Retry webhook delivery with backoff', author: { login: 'anna' }, headRefName: 'PAY-415-webhook-retry', additions: 86, deletions: 12, changedFiles: 4,
      createdAt: ago(5), timelineItems: { nodes: [{ createdAt: ago(4), requestedReviewer: { __typename: 'User', login: ME } }] }, paths: ['src/main/java/com/acme/pay/webhook/Delivery.java', 'src/test/java/com/acme/pay/webhook/DeliveryTest.java'] }),
    pr({ number: 1307, repo: 'acme/web-shop', title: 'Checkout: show saved cards first', author: { login: 'bob' }, headRefName: 'checkout-saved-cards', additions: 240, deletions: 98, changedFiles: 11,
      createdAt: ago(26), reviews: { nodes: [review(ME, 'COMMENTED', 22)] }, timelineItems: { nodes: [{ createdAt: ago(1), requestedReviewer: { __typename: 'User', login: ME } }] }, paths: ['web/checkout/Cards.tsx', 'web/checkout/Cards.test.tsx'] }),
    pr({ number: 77, repo: 'acme/infra', title: 'Terraform: bump RDS to 15.6', author: { login: 'carla' }, headRefName: 'rds-15-6', additions: 6, deletions: 6, changedFiles: 2,
      createdAt: ago(50), timelineItems: { nodes: [{ createdAt: ago(48), requestedReviewer: { __typename: 'User', login: ME } }] }, paths: ['terraform/rds.tf', '.github/workflows/plan.yml'] }),
  ],
  myPrs: [
    pr({ number: 479, repo: 'acme/payments-api', title: 'PAY-412: Partial refunds for split payments', headRefName: 'PAY-412-partial-refunds', reviewDecision: 'CHANGES_REQUESTED',
      reviews: { nodes: [review('dev', 'CHANGES_REQUESTED', 3)] }, reviewThreads: { nodes: [thread('dev'), thread('dev'), thread(ME, true)] }, additions: 310, deletions: 45, changedFiles: 9 }),
    pr({ number: 1301, repo: 'acme/web-shop', title: 'PAY-398: Refund status on the order page', headRefName: 'PAY-398-refund-status', reviewDecision: 'APPROVED',
      reviews: { nodes: [review('anna', 'APPROVED', 1)] }, additions: 64, deletions: 10, changedFiles: 3 }),
    pr({ number: 481, repo: 'acme/payments-api', title: 'PAY-420: Ledger export as CSV', headRefName: 'PAY-420-ledger-csv', ci: 'FAILURE', additions: 150, deletions: 4, changedFiles: 5,
      reviewRequests: { nodes: [user('anna')] } }),
    // Waiting for review: one asked a while ago with no answer, one with a recent comment.
    pr({ number: 486, repo: 'acme/payments-api', title: 'PAY-415: Retry webhook delivery with backoff', headRefName: 'PAY-415-webhook-retries', additions: 96, deletions: 20, changedFiles: 4,
      reviewRequests: { nodes: [user('anna'), user('bob'), user('carla')] }, timelineItems: { nodes: ['anna', 'bob', 'carla'].map((login) => ({ createdAt: ago(100), requestedReviewer: { __typename: 'User', login } })) } }),
    pr({ number: 1310, repo: 'acme/web-shop', title: 'PAY-422: Show refunds in the order history', headRefName: 'PAY-422-order-history', additions: 120, deletions: 12, changedFiles: 6,
      reviewRequests: { nodes: [user('anna'), user('carla')] }, reviews: { nodes: [review('bob', 'COMMENTED', 1.5)] },
      commits: { nodes: [{ commit: { committedDate: ago(4), statusCheckRollup: { state: 'SUCCESS' }, checkSuites: { nodes: [] } } }] },
      timelineItems: { nodes: ['anna', 'bob', 'carla'].map((login) => ({ createdAt: ago(20), requestedReviewer: { __typename: 'User', login } })) } }),
    pr({ number: 76, repo: 'acme/infra', title: 'Alerts for webhook backlog', headRefName: 'webhook-backlog-alerts', isDraft: true, additions: 40, deletions: 0, changedFiles: 2 }),
  ],
  mentions: [
    { __typename: 'Issue', number: 233, title: 'Payouts delayed on Mondays', url: 'https://github.com/acme/payments-api/issues/233', updatedAt: ago(0.5), repository: { nameWithOwner: 'acme/payments-api' }, author: { login: 'erik' }, labels: { nodes: [{ name: 'bug' }] } },
  ],
  assigned: [
    { __typename: 'Issue', number: 230, title: 'Flaky test: RefundServiceIT', url: 'https://github.com/acme/payments-api/issues/230', updatedAt: ago(20), repository: { nameWithOwner: 'acme/payments-api' }, author: { login: 'carla' }, labels: { nodes: [{ name: 'tests' }] } },
  ],
};

export const standup = {
  mine: [
    { number: 478, title: 'PAY-409: Idempotency keys for refunds', url: 'https://github.com/acme/payments-api/pull/478', state: 'MERGED', isDraft: false, createdAt: ago(60), mergedAt: ago(18), repository: { nameWithOwner: 'acme/payments-api' },
      commits: { nodes: [{ commit: { committedDate: ago(20), authors: { nodes: [{ user: { login: ME } }] } } }] } },
    { number: 479, title: 'PAY-412: Partial refunds for split payments', url: 'https://github.com/acme/payments-api/pull/479', state: 'OPEN', isDraft: false, createdAt: ago(30), mergedAt: null, repository: { nameWithOwner: 'acme/payments-api' },
      commits: { nodes: [{ commit: { committedDate: ago(17), authors: { nodes: [{ user: { login: ME } }] } } }] } },
  ],
  reviewed: [
    { number: 1299, title: 'Cart: keep coupon after login', url: 'https://github.com/acme/web-shop/pull/1299', repository: { nameWithOwner: 'acme/web-shop' }, author: { login: 'bob' }, reviews: { nodes: [{ state: 'APPROVED', submittedAt: ago(19) }] } },
  ],
};

export const tickets = [
  { key: 'PAY-412', summary: 'Partial refunds for split payments', status: 'In Progress', cat: 'indeterminate', priority: 'High', type: 'Story', updated: ago(2) },
  { key: 'PAY-420', summary: 'Ledger export as CSV', status: 'In Progress', cat: 'indeterminate', priority: 'Medium', type: 'Story', updated: ago(5) },
  { key: 'PAY-398', summary: 'Show refund status on the order page', status: 'In Review', cat: 'indeterminate', priority: 'Medium', type: 'Story', updated: ago(1) },
  { key: 'PAY-431', summary: 'Payout report shows wrong currency for SEK', status: 'To Do', cat: 'new', priority: 'High', type: 'Bug', updated: ago(26) },
  { key: 'PAY-433', summary: 'Rotate the webhook signing secret', status: 'To Do', cat: 'new', priority: 'Low', type: 'Task', updated: ago(70) },
];
export const mentionTickets = [
  { key: 'PAY-415', summary: 'Retry webhook delivery with backoff', status: 'In Review', by: 'Anna Berg', text: 'can you take the review on this one? Delivery.java is the interesting part.', h: 3 },
  { key: 'OPS-88', summary: 'Payments on-call handbook', status: 'Open', by: 'Carla Diaz', text: 'added a section on refunds, could you check the steps still match?', h: 20 },
];

export const slack = [
  { h: 0.3, user: 'anna', channel: 'payments', text: '<@U1> the partial refunds demo is this afternoon, can you share your screen?' },
  { h: 2, user: 'bob', channel: null, text: 'Thanks for the review <@U1>! Pushed the fixes.' },
];

// Today's meetings: a stand-up, a demo, a 1:1.
export function calendar() {
  const ev = (uid, title, s, e, extra = '') => `BEGIN:VEVENT\r\nUID:${uid}\r\nSUMMARY:${title}\r\nDTSTART:${fmt(s)}\r\nDTEND:${fmt(e)}\r\n${extra}END:VEVENT\r\n`;
  const fmt = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//acme//demo//EN\r\n${[
    ev('d1', 'Payments stand-up', at(0), at(0.25)),
    ev('d2', 'Partial refunds demo', at(4.25), at(4.75), 'LOCATION:Meet\r\n'),
    ev('d3', '1:1 with Carla', at(5.75), at(6.25)),
    ev('d4', 'Refunds design review', at(0.75, 1), at(1.75, 1)),
    ev('d5', 'Payments stand-up', at(0, 1), at(0.25, 1)),
  ].join('')}END:VCALENDAR\r\n`;
}
