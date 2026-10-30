#!/usr/bin/env node
// Stand-in for the Atlassian CLI in tests. Logs its arguments and prints canned JSON.
import { appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (process.env.FAKE_ACLI_LOG) appendFileSync(process.env.FAKE_ACLI_LOG, JSON.stringify(args) + '\n');
const arg = (name) => args[args.indexOf(name) + 1];
const hoursAgo = (h) => new Date(Date.now() - h * 36e5).toISOString();
// Like real acli, `self` points at an internal API host, not the site.
const self = (key) => `https://jira-prod-eu-1.prod.atl-paas.net/rest/api/3/issue/${key}`;
const print = (o) => process.stdout.write(JSON.stringify(o));

if (args[1] === 'auth' && args[2] === 'status') {
  process.stdout.write('✓ Authenticated\n  Site: acme.atlassian.net\n  Email: me@work.test\n');
} else if (args[1] === 'workitem' && args[2] === 'search') {
  const jql = arg('--jql');
  // Real acli rejects some fields in search.
  const refused = arg('--fields').split(',').filter((f) => ['duedate', 'updated', 'project'].includes(f));
  if (refused.length) {
    process.stderr.write(`✗ Error: fields '${refused.join(', ')}' are not allowed\n`);
    process.exit(1);
  }
  if (jql.startsWith('assignee = currentUser() ORDER')) {
    print([{ key: 'OPS-1', self: self('OPS-1'), fields: { assignee: { accountId: 'abc123', displayName: 'Alex' } } }]);
  } else if (jql.startsWith('assignee')) {
    print([{ key: 'OPS-1', self: self('OPS-1'), fields: { summary: 'Rotate certs',
      status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } }, priority: { name: 'High' },
      duedate: null, updated: hoursAgo(1), issuetype: { name: 'Task' }, project: { key: 'OPS' } } }]);
  } else if (jql.startsWith('issuekey IN updatedBy(')) {
    print([{ key: 'OPS-9', self: self('OPS-9'), fields: { summary: 'Pager rotation', status: { name: 'In Review', statusCategory: { key: 'indeterminate' } } } }]);
  } else if (jql.startsWith('comment ~ currentUser()')) {
    print({ issues: [{ key: 'OPS-2', self: self('OPS-2'), fields: { summary: 'Outage follow-up', status: { name: 'Open' } } }] });
  } else {
    print([]);
  }
} else if (args[1] === 'workitem' && args[2] === 'comment' && args[3] === 'list') {
  // Real acli flattens bodies to text, drops mentions and gives author as a string.
  print({ comments: [{ id: '10', author: 'Anna', body: 'Hi , can you check this?' }], isLast: false });
} else if (args[1] === 'workitem' && args[2] === 'view') {
  print({ key: args[3], fields: { comment: { comments: [
    { id: '10', author: { accountId: 'zzz', displayName: 'Anna' }, created: hoursAgo(2), body: { type: 'doc', content: [
      { type: 'paragraph', content: [
        { type: 'text', text: 'Hi ' }, { type: 'mention', attrs: { id: 'abc123', text: '@Alex' } },
        { type: 'text', text: ', can you ' }, { type: 'text', text: 'check', marks: [{ type: 'strong' }] }, { type: 'text', text: ' this?' },
      ] },
    ] } },
    { id: '11', author: { accountId: 'zzz', displayName: 'Anna' }, created: hoursAgo(1), body: 'No mention here' },
    { id: '12', author: { accountId: 'abc123', displayName: 'Alex' }, created: hoursAgo(1), body: 'me: [~accountid:abc123]' },
    { id: '13', author: { accountId: 'yyy', displayName: 'Bob' }, created: hoursAgo(24 * 30), body: 'old [~accountid:abc123]' },
  ] } } });
} else {
  process.stderr.write(`unexpected: ${args.join(' ')}\n`);
  process.exit(2);
}
