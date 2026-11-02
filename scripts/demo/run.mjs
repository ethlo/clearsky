#!/usr/bin/env node
// Clearsky with made-up data, for screenshots and trying it out: `node scripts/demo/run.mjs`
// (port 7790, or the first argument). It runs a stand-in for GitHub, Slack and the calendar,
// a fake acli and Copilot (this folder), in a throw-away home folder, so nothing of yours is
// read or touched and nothing leaves this machine.

import { HOME as home } from './home.mjs';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { github, standup, slack, calendar, ago, ME, standupAt, hhmm } from './data.mjs';
import { CHAT, SESSIONS } from './chat.mjs';

process.env.TZ ||= 'Europe/Oslo'; // the demo's clock, for Clearsky and the made-up meetings alike
const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2]) || 7790;

const fake = createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  const send = (o, type = 'application/json') => { res.writeHead(200, { 'Content-Type': type }); res.end(typeof o === 'string' ? o : JSON.stringify(o)); };
  const q = body ? JSON.parse(body).query || '' : '';
  if (req.url === '/graphql') {
    if (q.includes('reviewed: search')) return send({ data: { mine: { nodes: standup.mine }, reviewed: { nodes: standup.reviewed } } });
    if (q.includes('reviewRequested: search')) return send({ data: { reviewRequested: { nodes: github.reviewRequested }, myPrs: { nodes: github.myPrs }, mentions: { nodes: github.mentions }, assigned: { nodes: github.assigned } } });
    if (q.includes('assignableUsers')) return send({ data: { viewer: { login: ME }, repository: { assignableUsers: { nodes: ['anna', 'bob', 'carla', 'dev'].map((login) => ({ login, name: login })) }, pullRequest: { author: { login: ME }, suggestedReviewers: [{ reviewer: { login: 'anna', name: 'Anna Berg' } }], reviewRequests: { nodes: [] }, reviews: { nodes: [] } } } } });
    if (q.includes('pullRequest(number')) {
      const { number } = JSON.parse(body).variables || {};
      const p = [...github.reviewRequested, ...github.myPrs].find((x) => x.number === Number(number)) || github.myPrs[0];
      return send({ data: { repository: { pullRequest: { ...p, bodyText: `${p.title}. Splits the refund across the payment methods in proportion, and books each part in the ledger.`, author: p.author } } } });
    }
    if (q.includes('search(query: $q')) return send({ data: { viewer: { login: ME }, search: { nodes: [] } } });
    if (q.includes('viewer { login }')) return send({ data: { viewer: { login: ME } } });
    return send({ data: {} });
  }
  if (req.url === '/slack/auth.test') return send({ ok: true, user_id: 'U1', user: ME, team: 'Acme' });
  if (req.url.startsWith('/slack/search.messages')) {
    return send({ ok: true, messages: { matches: slack.map((m, i) => ({ ts: String((Date.now() - m.h * 36e5) / 1000), user: `U${i + 2}`, username: m.user, text: m.text,
      channel: m.channel ? { name: m.channel, is_im: false } : { is_im: true }, permalink: `https://acme.slack.com/archives/C${i}/p${i}` })) } });
  }
  if (req.url === '/calendar.ics') return send(calendar(), 'text/calendar');
  if (req.url.startsWith('/repos/')) return send([]);
  res.writeHead(404); res.end();
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${fake.address().port}`;

// A home folder of its own: settings, the agent's log, and Copilot's session folders.
const conf = join(home, '.config', 'clearsky');
mkdirSync(conf, { recursive: true });
writeFileSync(join(conf, '.env'), [
  'GITHUB_TOKEN=demo', `GITHUB_API_URL=${base}`, 'GITHUB_ORGS=acme', `ACLI_BIN=${join(here, 'acli.mjs')}`, 'JIRA_URL=https://acme.atlassian.net', 'JIRA_ACCOUNT_ID=me-1',
  'SLACK_TOKEN=demo', `SLACK_API_URL=${base}/slack`, `GOOGLE_CALENDAR_ICS=${base}/calendar.ics`, 'CLEARSKY_POLL_MINUTES=0', `CLEARSKY_STANDUP_TIME=${hhmm(standupAt())}`, 'CLEARSKY_NOTIFY=off',
  `COPILOT_BIN=${join(here, 'copilot.mjs')}`, 'GRAFANA_INSTANCES=test=https://grafana.test.example.com,prod=https://grafana.example.com',
  `VPN_CHECK=127.0.0.1:${fake.address().port}`, // the made-up VPN is always on
].join('\n'), { mode: 0o600 });
const copilotHome = join(home, '.copilot');
for (const s of SESSIONS) {
  const d = join(copilotHome, 'session-state', s.sessionId);
  mkdirSync(join(d, 'files'), { recursive: true });
  mkdirSync(join(d, 'research'), { recursive: true });
  mkdirSync(s.cwd, { recursive: true });
  writeFileSync(join(d, 'workspace.yaml'), `id: ${s.sessionId}\ncwd: ${s.cwd}\n${s.branch ? `repository: acme/payments-api\nbranch: ${s.branch}\n` : ''}`);
}
const files = join(copilotHome, 'session-state', CHAT.id);
writeFileSync(join(files, 'research', 'rounding.md'), '# Rounding in split refunds\n\nEach part was rounded on its own (HALF_EVEN), so 100.00 split three ways gave 33.33 × 3 = 99.99.\n\nFix: round every part but the last, and give the last part what is left.\n\n| parts | before | after |\n|---|---|---|\n| 3 × 33.33 | 99.99 | 100.00 |\n| 7 × 14.29 | 100.03 | 100.00 |\n');
writeFileSync(join(files, 'files', 'refund-cases.csv'), 'payment,methods,refund,expected\nP-1001,card+giftcard,40.00,card 30.00 / giftcard 10.00\nP-1002,card,100.00,card 100.00\nP-1003,card+invoice,33.33,card 16.67 / invoice 16.66\n');
const chat = [{ id: CHAT.id }];
const log = [
  { at: ago(1.5), where: 'build', kind: 'test', what: './mvnw -q test -pl refunds', repo: 'acme/payments-api', target: '~/dev/acme/payments-api', chats: chat, decided: 'failed', ms: 81_000 },
  { at: ago(1.1), where: 'build', kind: 'test', what: './mvnw -q test -pl refunds', repo: 'acme/payments-api', target: '~/dev/acme/payments-api', chats: chat, decided: 'passed', ms: 78_000 },
  { at: ago(0.9), where: 'review', what: 'review --ticket PAY-412', repo: 'acme/payments-api', target: '~/dev/acme/payments-api', chats: chat, decided: 'reviewed', verdict: 'fix first' },
  { at: ago(0.7), where: 'review', what: 'review --ticket PAY-412', repo: 'acme/payments-api', target: '~/dev/acme/payments-api', chats: chat, decided: 'reviewed', verdict: 'ready' },
  { at: ago(0.6), where: 'github', what: 'git push to acme/payments-api (PAY-412-partial-refunds)', target: 'acme/payments-api', chats: chat, decided: 'auto' },
  { at: ago(0.5), where: 'github', what: 'POST acme/payments-api/pulls/479/comments/9911/replies', target: 'acme/payments-api', chats: chat, decided: 'auto' },
  { at: ago(0.5), where: 'github', what: 'POST acme/payments-api/pulls/479/comments/9912/replies', target: 'acme/payments-api', chats: chat, decided: 'auto' },
  { at: ago(0.4), where: 'jira', what: "acli jira workitem transition --key PAY-412 --status 'In Review'", target: 'PAY-412', chats: chat, decided: 'auto' },
  { at: ago(0.3), where: 'grafana', what: "grafana logs test '{app=\"payments-api\"} |= \"refund\"'", target: 'test', chats: chat, decided: 'read', removed: 0 },
  { at: ago(0.2), where: 'jira', what: "acli jira workitem create --project PAY --type Bug --summary 'Ledger CSV export rounds each line on its own'", target: 'PAY', chats: chat, decided: 'allowed' },
  { at: ago(3), where: 'github', what: 'POST acme/payments-api/pulls/482/reviews', target: 'acme/payments-api', chats: [{ id: 'demo-review-482' }], decided: 'allowed' },
];
writeFileSync(join(conf, 'agent-writes.jsonl'), log.map((e) => JSON.stringify(e)).join('\n') + '\n');
// The files the chat wrote, so its Outputs list them as there.
const src = join(CHAT.cwd, 'src', 'main', 'java', 'com', 'acme', 'pay', 'refund'), test = src.replace(`${join('src', 'main')}`, join('src', 'test'));
mkdirSync(src, { recursive: true }); mkdirSync(test, { recursive: true });
writeFileSync(join(src, 'RefundSplitter.java'), 'package com.acme.pay.refund;\n\n// Splits a refund across the payment methods in proportion; the last part gets what is left.\nfinal class RefundSplitter {}\n');
writeFileSync(join(test, 'RefundSplitterTest.java'), 'package com.acme.pay.refund;\n\nclass RefundSplitterTest {}\n');
writeFileSync(join(conf, 'agent-files.jsonl'), [
  { at: ago(1.3), where: 'file', what: `${CHAT.cwd}/src/main/java/com/acme/pay/refund/RefundSplitter.java`, kind: 'wrote', chats: chat, decided: 'done' },
  { at: ago(1.2), where: 'file', what: `${CHAT.cwd}/src/test/java/com/acme/pay/refund/RefundSplitterTest.java`, kind: 'wrote', chats: chat, decided: 'done' },
].map((e) => JSON.stringify(e)).join('\n') + '\n');
writeFileSync(join(conf, 'state.json'), JSON.stringify({ sessionNames: Object.fromEntries(SESSIONS.map((s) => [s.sessionId, s.title])), sessionRefs: { [CHAT.id]: ['pr:acme/payments-api#479', 'issue:PAY-412'] } }));

// Links: a few favourites on each side.
const L = (title, url) => ({ title, url });
writeFileSync(join(conf, 'links.json'), JSON.stringify({ groups: [
  { name: 'Daily', area: 'work', links: [L('Payments board', 'https://acme.atlassian.net/jira/software/projects/PAY/boards/12'), L('payments-api', 'https://github.com/acme/payments-api'), L('web-shop', 'https://github.com/acme/web-shop'), L('On-call schedule', 'https://acme.pagerduty.example.com/schedules')] },
  { name: 'Environments', area: 'work', links: [L('Grafana test', 'https://grafana.test.example.com'), L('Grafana prod', 'https://grafana.example.com'), L('Admin (test)', 'https://admin.test.example.com'), L('Status page', 'https://status.example.com')] },
  { name: 'Docs', area: 'work', links: [L('Engineering handbook', 'https://handbook.example.com'), L('Payments API reference', 'https://docs.example.com/payments'), L('Runbooks', 'https://acme.atlassian.net/wiki/spaces/OPS/runbooks'), L('Architecture decisions', 'https://github.com/acme/adr')] },
  { name: 'Home', area: 'personal', links: [L('Bank', 'https://bank.example.no'), L('Football club', 'https://club.example.no'), L('Recipes', 'https://recipes.example.org')] },
] }), { mode: 0o600 });

const app = spawn(process.execPath, [join(here, '..', '..', 'bin', 'clearsky.mjs'), 'serve', '--port', String(port)], {
  stdio: 'inherit', env: { PATH: process.env.PATH, HOME: home, CLEARSKY_DEMO_HOME: home, CLEARSKY_COPILOT_HOME: copilotHome, TZ: process.env.TZ, LANG: 'en_GB.UTF-8' },
});
console.log(`Clearsky demo: http://127.0.0.1:${port}  (made-up data in ${home}; Ctrl+C stops it)`);
const stop = () => { app.kill(); fake.close(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
app.on('exit', () => { fake.close(); process.exit(0); });
