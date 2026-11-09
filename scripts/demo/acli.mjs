#!/usr/bin/env node
// Stand-in for the Atlassian CLI in Clearsky's demo: the made-up tickets in data.mjs.
import { tickets, mentionTickets, ago, jiraProjects, jiraVersions, versionTickets } from './data.mjs';

const args = process.argv.slice(2);
const arg = (n) => args[args.indexOf(n) + 1];
const print = (o) => process.stdout.write(JSON.stringify(o));
const self = (key) => `https://acme.atlassian.net/rest/api/3/issue/${key}`;
const ME = { accountId: 'me-1', displayName: 'Alex Kim' };
const status = (name, cat) => ({ name, statusCategory: { key: cat } });
const doc = (text) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
const t_ = (text, marks) => ({ type: 'text', text, ...(marks && { marks }) });
const p_ = (...content) => ({ type: 'paragraph', content });
const li = (text) => ({ type: 'listItem', content: [p_(t_(text))] });
// A description with Jira's usual formatting: a heading, a list, code and a table.
const richDoc = (summary) => ({ type: 'doc', content: [
  p_(t_(`${summary}. `), t_('Refunds of part of a split payment', [{ type: 'strong' }]), t_(' are booked against the right payment method, and the ledger stays balanced.')),
  { type: 'heading', attrs: { level: 3 }, content: [t_('Acceptance')] },
  { type: 'bulletList', content: [li('A partial refund splits by the original amounts'), li('Rounding goes to the largest payment'), li('The ledger total is unchanged')] },
  p_(t_('Use '), t_('RefundSplitter.split()', [{ type: 'code' }]), t_(' and see the '), t_('design note', [{ type: 'link', attrs: { href: 'https://example.com/design/refunds' } }]), t_('.')),
  { type: 'codeBlock', attrs: { language: 'json' }, content: [t_('{ "refund": 30.00, "payments": ["card", "gift"] }')] },
  { type: 'table', content: [
    { type: 'tableRow', content: ['Paid', 'Refund', 'Result'].map((x) => ({ type: 'tableHeader', content: [p_(t_(x))] })) },
    { type: 'tableRow', content: ['60 card + 40 gift', '30', '18 card, 12 gift'].map((x) => ({ type: 'tableCell', content: [p_(t_(x))] })) }] },
] });

if (args[1] === 'auth' && args[2] === 'status') {
  process.stdout.write('✓ Authenticated\n  Site: acme.atlassian.net\n  Email: alex@example.com\n');
} else if (args[1] === 'project' && args[2] === 'list') {
  print(jiraProjects.map((p) => ({ key: p.key, name: p.name, projectTypeKey: 'software' })));
} else if (args[1] === 'project' && args[2] === 'view') {
  const key = arg('--key'), p = jiraProjects.find((x) => x.key === key);
  if (!p) { process.stderr.write(`✗ Error: project ${key} not found\n`); process.exit(1); }
  print({ key, name: p.name, versions: jiraVersions[key] || [] });
} else if (args[1] === 'workitem' && args[2] === 'search') {
  const jql = arg('--jql');
  const fv = jql.match(/^project = "([^"]+)" AND fixVersion = "((?:[^"\\]|\\.)*)"/);
  if (fv) print((versionTickets[`${fv[1]} ${fv[2].replace(/\\(.)/g, '$1')}`] || []).map((t) => ({ key: t.key, self: self(t.key), fields: { summary: t.summary, status: status(t.status, t.cat),
    priority: { name: t.priority }, updated: t.updated, issuetype: { name: t.type }, assignee: t.assignee ? { displayName: t.assignee } : null } })));
  else if (/fixVersion is not EMPTY/.test(jql)) print([]);
  else if (/^(assignee|reporter) = currentUser\(\) ORDER/.test(jql)) print([{ key: 'PAY-412', self: self('PAY-412'), fields: { assignee: ME, reporter: ME } }]);
  else if (/comment ~ currentUser|watcher/.test(jql)) print(mentionTickets.map((t) => ({ key: t.key, self: self(t.key), fields: { summary: t.summary, status: status(t.status, 'indeterminate') } })));
  else print(tickets.map((t) => ({ key: t.key, self: self(t.key), fields: { summary: t.summary, status: status(t.status, t.cat), priority: { name: t.priority },
    updated: t.updated, issuetype: { name: t.type }, project: { key: t.key.split('-')[0] }, assignee: ME } })));
} else if (args[1] === 'workitem' && args[2] === 'view') {
  const key = args[3], fields = arg('--fields') || '';
  const t = tickets.find((x) => x.key === key) || mentionTickets.find((x) => x.key === key) || { key, summary: 'A ticket', status: 'To Do', cat: 'new', type: 'Task' };
  const m = mentionTickets.find((x) => x.key === key);
  if (fields === 'comment') {
    print({ key, fields: { comment: { comments: m ? [{ id: '1', author: { accountId: 'u-anna', displayName: m.by }, created: ago(m.h), body: { type: 'doc', content: [{ type: 'paragraph', content: [
      { type: 'mention', attrs: { id: 'me-1', text: '@Alex Kim' } }, { type: 'text', text: ` ${m.text}` }] },
      { type: 'bulletList', content: [li('Check the rounding case'), li('Then move it to review')] }] } }] : [] } } });
  } else if (fields === 'fixVersions') {
    print({ key, fields: { fixVersions: key.startsWith('PAY') ? [{ name: '2.14' }] : [] } });
  } else {
    print({ key, self: self(key), fields: { summary: t.summary, status: status(t.status, t.cat || 'indeterminate'), issuetype: { name: t.type || 'Story' }, priority: { name: t.priority || 'Medium' },
      assignee: ME, reporter: { displayName: 'Carla Diaz' }, fixVersions: [{ name: '2.14' }],
      description: richDoc(t.summary) } });
  }
} else {
  process.stderr.write(`demo acli: not supported: ${args.join(' ')}\n`);
  process.exit(2);
}
