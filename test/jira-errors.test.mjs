import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJira, acliError } from '../lib/modules/jira.mjs';

// What execFile rejects with when a command exits non-zero: "Command failed: <cmd>\n<stderr>".
const failed = (args, { stdout = '', stderr = '', code = 1, killed = false, signal = null } = {}) =>
  Object.assign(new Error(`Command failed: acli ${args.join(' ')}\n${stderr}`), { stdout, stderr, code, killed, signal });
const search = ['workitem', 'search', '--jql', 'assignee = currentUser()', '--json'];

test('acli errors say what acli said, also when it says it on stdout', () => {
  assert.equal(acliError(search, failed(search, { stderr: '✗ Error: bad JQL\n' })).message, 'acli jira workitem search failed: ✗ Error: bad JQL');
  const e = acliError(search, failed(search, { stdout: '\x1b[31m✗ Error: unauthorized: use \'acli jira auth login\' to authenticate\x1b[0m\n' }));
  assert.match(e.message, /failed: ✗ Error: unauthorized: use 'acli jira auth login' to authenticate \(the Atlassian login looks expired/);
  assert.equal(e.auth, true);
  assert.doesNotMatch(e.message, /Command failed/);
});

test('acli errors with nothing said give the exit code, and timeouts say so', () => {
  assert.equal(acliError(search, failed(search, { code: 2 })).message, 'acli jira workitem search failed: exited with 2 and said nothing');
  assert.equal(acliError(search, failed(search, { code: null, killed: true, signal: 'SIGTERM' })).message, 'acli jira workitem search failed: no answer within 60s (stopped). Does "acli jira auth status" answer quickly in a terminal?');
  assert.equal(acliError(search, failed(search, { stderr: 'Error: bad JQL' })).auth, undefined);
});

const jiraWith = (answer) => createJira({
  config: { days: 14, jira: { acli: 'acli', url: 'https://acme.atlassian.net', assignedJql: 'assignee = currentUser()' } },
  execFileP: async (_bin, args) => answer(args.slice(1)),
  settle: (p) => p.catch((e) => ({ error: e.message, ...(e.auth && { needsLogin: true }) })),
});

test('mentions pass on acli\'s own error instead of asking for an account id', async () => {
  const j = jiraWith((args) => { throw failed(args, { stdout: 'Error: unauthorized\n' }); });
  await assert.rejects(j.jiraMe(), (e) => /unauthorized/.test(e.message) && e.auth && !/JIRA_ACCOUNT_ID/.test(e.message));
  const both = await j.fetchJira();
  assert.equal(both.needsLogin, true, 'so the page links to logging in again');
  assert.match(both.error, /workitem search failed: Error: unauthorized/);
});

test('your account id comes from a ticket you created when none is assigned to or reported by you', async () => {
  const asked = [];
  const j = jiraWith((args) => {
    const jql = args[args.indexOf('--jql') + 1];
    asked.push(jql);
    return { stdout: JSON.stringify(jql.startsWith('creator') ? [{ key: 'ABC-1', fields: { creator: { accountId: 'abc123', displayName: 'Alex' } } }] : []) };
  });
  assert.deepEqual(await j.jiraMe(), { id: 'abc123', name: 'Alex' });
  assert.equal(asked.length, 3);
  await j.jiraMe();
  assert.equal(asked.length, 3, 'found once and kept');
  const none = jiraWith(() => ({ stdout: '[]' }));
  await assert.rejects(none.jiraMe(), /no Jira ticket names you yet/);
});

test('acli gets its input closed, so a prompt can\'t hang it', async () => {
  let ended = 0;
  const j = createJira({
    config: { days: 14, jira: { acli: 'acli', url: 'https://acme.atlassian.net' } },
    execFileP: () => Object.assign(Promise.resolve({ stdout: '[]' }), { child: { stdin: { end: () => ended++ } } }),
    settle: (p) => p,
  });
  await j.jiraSearch('assignee = currentUser()', ['key']);
  assert.equal(ended, 1);
});
