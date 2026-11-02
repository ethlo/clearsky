#!/usr/bin/env node
// Stand-in for the Atlassian CLI in Clearsky's demo: the made-up tickets in data.mjs.
import { tickets, mentionTickets, ago } from './data.mjs';

const args = process.argv.slice(2);
const arg = (n) => args[args.indexOf(n) + 1];
const print = (o) => process.stdout.write(JSON.stringify(o));
const self = (key) => `https://acme.atlassian.net/rest/api/3/issue/${key}`;
const ME = { accountId: 'me-1', displayName: 'Alex Kim' };
const status = (name, cat) => ({ name, statusCategory: { key: cat } });
const doc = (text) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

if (args[1] === 'auth' && args[2] === 'status') {
  process.stdout.write('✓ Authenticated\n  Site: acme.atlassian.net\n  Email: alex@example.com\n');
} else if (args[1] === 'workitem' && args[2] === 'search') {
  const jql = arg('--jql');
  if (/^(assignee|reporter) = currentUser\(\) ORDER/.test(jql)) print([{ key: 'PAY-412', self: self('PAY-412'), fields: { assignee: ME, reporter: ME } }]);
  else if (/comment ~ currentUser|watcher/.test(jql)) print(mentionTickets.map((t) => ({ key: t.key, self: self(t.key), fields: { summary: t.summary, status: status(t.status, 'indeterminate') } })));
  else print(tickets.map((t) => ({ key: t.key, self: self(t.key), fields: { summary: t.summary, status: status(t.status, t.cat), priority: { name: t.priority },
    updated: t.updated, issuetype: { name: t.type }, project: { key: t.key.split('-')[0] }, assignee: ME } })));
} else if (args[1] === 'workitem' && args[2] === 'view') {
  const key = args[3], fields = arg('--fields') || '';
  const t = tickets.find((x) => x.key === key) || mentionTickets.find((x) => x.key === key) || { key, summary: 'A ticket', status: 'To Do', cat: 'new', type: 'Task' };
  const m = mentionTickets.find((x) => x.key === key);
  if (fields === 'comment') {
    print({ key, fields: { comment: { comments: m ? [{ id: '1', author: { accountId: 'u-anna', displayName: m.by }, created: ago(m.h), body: { type: 'doc', content: [{ type: 'paragraph', content: [
      { type: 'mention', attrs: { id: 'me-1', text: '@Alex Kim' } }, { type: 'text', text: ` ${m.text}` }] }] } }] : [] } } });
  } else if (fields === 'fixVersions') {
    print({ key, fields: { fixVersions: key.startsWith('PAY') ? [{ name: '2.14' }] : [] } });
  } else {
    print({ key, self: self(key), fields: { summary: t.summary, status: status(t.status, t.cat || 'indeterminate'), issuetype: { name: t.type || 'Story' }, priority: { name: t.priority || 'Medium' },
      assignee: ME, reporter: { displayName: 'Carla Diaz' }, fixVersions: [{ name: '2.14' }],
      description: doc(`${t.summary}. Acceptance: refunds of part of a split payment are booked against the right payment method, and the ledger stays balanced.`) } });
  }
} else {
  process.stderr.write(`demo acli: not supported: ${args.join(' ')}\n`);
  process.exit(2);
}
