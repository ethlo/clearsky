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
  id: `PR_${o.number || 1}`, number: 1, title: 'A change', url: `https://github.com/${o.repo || 'acme/payments-api'}/pull/${o.number || 1}`, state: 'OPEN', isDraft: false,
  createdAt: ago(30), updatedAt: ago(2), reviewDecision: 'REVIEW_REQUIRED', mergeable: 'MERGEABLE', headRefName: 'feature/x',
  additions: 120, deletions: 34, changedFiles: 6, repository: { nameWithOwner: o.repo || 'acme/payments-api' }, author: { login: ME },
  reviews: { nodes: [] }, reviewRequests: { nodes: [] }, reviewThreads: { nodes: [] },
  commits: { nodes: [{ commit: { committedDate: ago(3), statusCheckRollup: { state: o.ci || 'SUCCESS' }, checkSuites: { nodes: [suite('build', o.ci === 'FAILURE' ? 'FAILURE' : 'SUCCESS')] } } }] },
  closingIssuesReferences: { nodes: [] }, timelineItems: { nodes: [] }, files: { nodes: (o.paths || ['src/main/java/com/acme/pay/Refunds.java']).map((path) => ({ path })) },
  ...o,
});
// Commits for "read by you": [hoursAgo, who, lines], who = 'me', 'copilot' (Co-authored-by) or a login.
const COPILOT = '\n\nCo-authored-by: Copilot <175728472+Copilot@users.noreply.github.com>';
const hist = (number, list) => ({ headRefOid: `${number}c${list.length}`, history: { nodes: list.map(([h, who, lines], i) => ({ commit: {
  oid: `${number}c${i + 1}`, committedDate: ago(h), additions: Math.round(lines * 0.8), deletions: Math.round(lines * 0.2),
  message: `Change ${i + 1}${who === 'copilot' ? COPILOT : ''}`, author: { name: who, email: `${who}@example.com`, user: { login: who === 'copilot' || who === 'me' ? ME : who } } } })) } });
export const READ_MARKS = { 'prread:https://github.com/acme/payments-api/pull/486': '486c3', 'prread:https://github.com/acme/web-shop/pull/1310': '1310c2' };
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
      reviews: { nodes: [review('dev', 'CHANGES_REQUESTED', 3)] }, reviewThreads: { nodes: [thread('dev'), thread('dev'), thread(ME, true)] }, additions: 310, deletions: 45, changedFiles: 9,
      ...hist(479, [[30, 'me', 120], [26, 'copilot', 140], [0.7, 'me', 60]]) }),
    pr({ number: 1301, repo: 'acme/web-shop', title: 'PAY-398: Refund status on the order page', headRefName: 'PAY-398-refund-status', reviewDecision: 'APPROVED',
      reviews: { nodes: [review('anna', 'APPROVED', 1)] }, additions: 64, deletions: 10, changedFiles: 3,
      ...hist(1301, [[28, 'copilot', 50], [6, 'copilot', 24]]) }),
    pr({ number: 481, repo: 'acme/payments-api', title: 'PAY-420: Ledger export as CSV', headRefName: 'PAY-420-ledger-csv', ci: 'FAILURE', additions: 150, deletions: 4, changedFiles: 5,
      reviewRequests: { nodes: [user('anna')] }, ...hist(481, [[9, 'me', 120], [5, 'me', 34]]) }),
    // Waiting for review: one asked a while ago with no answer, one with a recent comment.
    pr({ number: 486, repo: 'acme/payments-api', title: 'PAY-415: Retry webhook delivery with backoff', headRefName: 'PAY-415-webhook-retries', additions: 96, deletions: 20, changedFiles: 4,
      reviewRequests: { nodes: [user('anna'), user('bob'), user('carla')] }, timelineItems: { nodes: ['anna', 'bob', 'carla'].map((login) => ({ createdAt: ago(100), requestedReviewer: { __typename: 'User', login } })) },
      ...hist(486, [[104, 'copilot', 80], [102, 'me', 16], [101, 'copilot', 20]]) }),
    pr({ number: 1310, repo: 'acme/web-shop', title: 'PAY-422: Show refunds in the order history', headRefName: 'PAY-422-order-history', additions: 120, deletions: 12, changedFiles: 6,
      reviewRequests: { nodes: [user('anna'), user('carla')] }, reviews: { nodes: [review('bob', 'COMMENTED', 1.5)] },
      commits: { nodes: [{ commit: { committedDate: ago(4), statusCheckRollup: { state: 'SUCCESS' }, checkSuites: { nodes: [] } } }] },
      timelineItems: { nodes: ['anna', 'bob', 'carla'].map((login) => ({ createdAt: ago(20), requestedReviewer: { __typename: 'User', login } })) },
      ...hist(1310, [[24, 'copilot', 90], [22, 'me', 12], [4, 'copilot', 22], [3.5, 'copilot', 8]]) }),
    pr({ number: 76, repo: 'acme/infra', title: 'Alerts for webhook backlog', headRefName: 'webhook-backlog-alerts', isDraft: true, additions: 40, deletions: 0, changedFiles: 2, ...hist(76, [[8, 'copilot', 40]]) }),
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
// The Jira projects you can see, their fix versions, and the tickets in each (the Versions page).
export const jiraProjects = [
  { key: 'PAY', name: 'Payments' }, { key: 'WEB', name: 'Web shop' }, { key: 'OPS', name: 'Operations' },
  { key: 'DATA', name: 'Data platform' }, { key: 'MOB', name: 'Mobile app' }, { key: 'SEC', name: 'Security' },
];
const day = (d) => new Date(Date.now() + d * 24 * H).toISOString().slice(0, 10);
export const jiraVersions = {
  PAY: [{ name: '2.13', released: true, releaseDate: day(-12) }, { name: '2.14', released: false, releaseDate: day(9) }, { name: '2.15', released: false, releaseDate: day(37) },
    { name: '2.12', released: true, releaseDate: day(-40) }, { name: '2.11', released: true, archived: true, releaseDate: day(-80) }],
  WEB: [{ name: 'Spring sale', released: false, releaseDate: day(4) }, { name: 'Checkout v3', released: false }],
  OPS: [{ name: '2026-Q4', released: false, releaseDate: day(50) }],
};
// [key, summary, status, category, type, priority, assignee]
const vt = (rows) => rows.map(([key, summary, status, cat, type, priority, assignee]) => ({ key, summary, status, cat, type, priority, assignee, updated: ago(key.length * 3) }));
export const versionTickets = {
  'PAY 2.14': vt([
    ['PAY-412', 'Partial refunds for split payments', 'In Progress', 'indeterminate', 'Story', 'High', 'Alex Kim'],
    ['PAY-420', 'Ledger export as CSV', 'In Progress', 'indeterminate', 'Story', 'Medium', 'Alex Kim'],
    ['PAY-398', 'Show refund status on the order page', 'In Review', 'indeterminate', 'Story', 'Medium', 'Alex Kim'],
    ['PAY-415', 'Retry webhook delivery with backoff', 'In Review', 'indeterminate', 'Story', 'High', 'Anna Berg'],
    ['PAY-431', 'Payout report shows wrong currency for SEK', 'To Do', 'new', 'Bug', 'High', 'Alex Kim'],
    ['PAY-433', 'Rotate the webhook signing secret', 'To Do', 'new', 'Task', 'Low', null],
    ['PAY-401', 'Refund API: idempotency keys', 'Done', 'done', 'Story', 'High', 'Bob Lee'],
    ['PAY-402', 'Refund events on the ledger stream', 'Done', 'done', 'Story', 'Medium', 'Anna Berg'],
    ['PAY-405', 'Rounding error on three-way split', 'Done', 'done', 'Bug', 'High', 'Bob Lee'],
    ['PAY-408', 'Docs: partial refunds', 'Done', 'done', 'Task', 'Low', 'Carla Diaz'],
    ['PAY-410', 'Gift card refunds go to the wrong balance', 'In QA', 'indeterminate', 'Bug', 'Highest', 'Bob Lee'],
    ['PAY-417', 'Load test the refund endpoint', 'Blocked', 'indeterminate', 'Task', 'Medium', 'Carla Diaz'],
    ['PAY-422', 'Feature flag for partial refunds', 'Done', 'done', 'Task', 'Medium', 'Alex Kim'],
    ['PAY-425', 'Refund reason codes', 'To Do', 'new', 'Story', 'Medium', 'Anna Berg'],
  ]),
  'PAY 2.15': vt([
    ['PAY-440', 'Multi-currency payouts', 'To Do', 'new', 'Epic', 'High', null],
    ['PAY-441', 'Payout scheduling', 'To Do', 'new', 'Story', 'Medium', 'Bob Lee'],
    ['PAY-442', 'Payout preview', 'In Progress', 'indeterminate', 'Story', 'Medium', 'Anna Berg'],
  ]),
  'PAY 2.13': vt([
    ['PAY-380', 'Saved cards for returning customers', 'Done', 'done', 'Story', 'High', 'Alex Kim'],
    ['PAY-384', 'Card expiry reminders', 'Done', 'done', 'Story', 'Medium', 'Bob Lee'],
  ]),
  'WEB Spring sale': vt([
    ['WEB-1301', 'Sale banner on the start page', 'Done', 'done', 'Story', 'Medium', 'Bob Lee'],
    ['WEB-1307', 'Checkout: show saved cards first', 'In Review', 'indeterminate', 'Story', 'High', 'Bob Lee'],
    ['WEB-1312', 'Countdown timer drifts on mobile', 'To Do', 'new', 'Bug', 'Medium', 'Anna Berg'],
  ]),
};

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

// The VMs view (/api/vms): two chats' VMs building, two more waiting in line for one.
// A chat's background jobs and its watchdog, for the chat's side pane.
export function jobs(chat, now = Date.now()) {
  const job = (id, where, command, state, startMin, endMin, code = null) => ({ id, where, command, cwd: '~/dev/acme/payments-api', state, code,
    startedAt: new Date(now - startMin * 6e4).toISOString(), endedAt: endMin == null ? null : new Date(now - endMin * 6e4).toISOString(), ms: ((endMin == null ? 0 : -endMin) + startMin) * 6e4, told: true });
  const list = chat === 'demo-pay412-refunds' ? [
    job('j9b20d', 'sandbox', 'gh run watch 9214 --exit-status', 'running', 3, null),
    job('j4c1e9', 'vm', './mvnw verify -pl refunds', 'done', 19, 11.8, 0),
    job('j77a03', 'vm', './mvnw verify -pl refunds -Dit.test=RefundServiceIT', 'failed', 41, 37, 1),
  ] : [];
  return { jobs: list, watchdog: { on: true, max: 3, minutes: 2, nudges: chat === 'demo-pay412-refunds' ? 1 : 0, paused: false, gaveUp: false, due: null, reason: null, last: null } };
}

export function vms(now = Date.now()) {
  const wob = (base, span) => Math.round(base + Math.sin(now / 7000 + base) * span);
  const ctr = (name, image, status, cpu, memMb, ports = '') => ({ name, image, state: 'running', status, ports, cpu: `${cpu.toFixed(2)}%`, mem: `${memMb}MiB / 7.8GiB` });
  const home = '~/dev/acme';
  return {
    limit: 2, running: 2, waiting: 2,
    vms: [
      { chat: 'demo-pay412-refunds', title: 'PAY-412: Partial refunds for split payments', state: 'running', place: 'running', busy: true, since: new Date(now - 14 * 6e4).toISOString(),
        startedAt: new Date(now - 14 * 6e4).toISOString(), cwd: `${home}/payments-api`, commands: 6, vcpus: 6, memMb: 8192, diskBytes: 3.1 * 2 ** 30,
        system: { memTotalMb: 7936, memUsedMb: wob(5200, 400), cpus: 6, cpuPct: wob(71, 12) },
        containers: [
          ctr('testcontainers-ryuk-4f1a', 'testcontainers/ryuk:0.11.0', 'Up 3 minutes', 0.02, 9),
          ctr('postgres-refunds-it', 'postgres:16-alpine', 'Up 3 minutes', wob(38, 9), wob(212, 20), '0.0.0.0:32771->5432/tcp'),
          ctr('kafka-ledger-it', 'confluentinc/cp-kafka:7.6.1', 'Up 2 minutes', wob(54, 15), wob(980, 60), '0.0.0.0:32773->9093/tcp'),
          { name: 'redis-cache-it', image: 'redis:7', state: 'exited', status: 'Exited (0) 4 minutes ago', ports: '' },
        ] },
      { chat: 'demo-flaky-it', title: 'Flaky RefundServiceIT', state: 'running', place: 'running', busy: false, since: new Date(now - 32 * 6e4).toISOString(),
        startedAt: new Date(now - 32 * 6e4).toISOString(), cwd: `${home}/payments-api`, commands: 11, vcpus: 6, memMb: 8192, diskBytes: 2.4 * 2 ** 30,
        system: { memTotalMb: 7936, memUsedMb: wob(1400, 80), cpus: 6, cpuPct: wob(4, 2) },
        containers: [] },
      { chat: 'demo-review-482', title: 'Review acme/payments-api#482', state: 'off', place: 'waiting', position: 1, since: new Date(now - 3 * 6e4).toISOString(), cwd: `${home}/payments-api`, commands: 0, vcpus: 6, memMb: 8192, system: null, containers: [] },
      { chat: 'demo-webshop-build', title: 'web-shop: checkout tests', state: 'off', place: 'waiting', position: 2, since: new Date(now - 50e3).toISOString(), cwd: `${home}/web-shop`, commands: 0, vcpus: 6, memMb: 8192, system: null, containers: [] },
    ],
    host: { cpus: 12, memMb: 31744 },
  };
}
