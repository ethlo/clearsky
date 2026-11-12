import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trackerName, ghIssue, ticketRef, trackerHint, ticketArgv, TICKET_USAGE } from '../lib/tracker.mjs';
import { groupStandup } from '../lib/standup.mjs';
import { parseReviewArgs } from '../lib/review.mjs';
import { checks } from '../lib/doctor.mjs';
import { validate } from '../lib/settings.mjs';
import { commandAction } from '../lib/copilot-events.mjs';
import { parsePack } from '../lib/team.mjs';

test('the tracker: as set, else Jira when Jira is set up or acli is there, else GitHub Issues', () => {
  const none = () => false, some = () => true;
  assert.equal(trackerName({ TRACKER: 'github', JIRA_URL: 'https://acme.atlassian.net' }, { acli: some }), 'github');
  assert.equal(trackerName({ TRACKER: 'None' }, { acli: some }), 'none');
  assert.equal(trackerName({ TRACKER: 'linear' }, { acli: none }), 'github', 'an unknown value counts as unset');
  assert.equal(trackerName({ JIRA_STARRED_PROJECTS: 'PAY' }, { acli: none }), 'jira');
  assert.equal(trackerName({}, { acli: some }), 'jira', 'nothing changes for people with acli');
  assert.equal(trackerName({}, { acli: none }), 'github');
});

test('ticket refs: Jira keys and GitHub issues', () => {
  assert.deepEqual(ghIssue('acme/api#12'), { repo: 'acme/api', number: 12 });
  assert.deepEqual(ghIssue('https://github.com/acme/api/issues/7'), { repo: 'acme/api', number: 7 });
  assert.equal(ghIssue('PAY-1'), null);
  assert.deepEqual(ticketRef('pay-12', 'jira'), { kind: 'issue', key: 'PAY-12' });
  assert.deepEqual(ticketRef('https://acme.atlassian.net/browse/PAY-3', 'jira'), { kind: 'issue', key: 'PAY-3' });
  assert.deepEqual(ticketRef('acme/api#12', 'github'), { kind: 'gh', repo: 'acme/api', number: 12 });
  assert.equal(ticketRef('PAY-12', 'github'), null);
  assert.equal(ticketRef('PAY-12', 'none'), null);
});

test('chats are told where tickets live', () => {
  assert.match(trackerHint('jira'), /Jira.*`ticket view/);
  assert.match(trackerHint('github'), /GitHub issues.*Fixes owner\/name#12/);
  assert.match(trackerHint('none'), /don't use an issue tracker/);
  assert.doesNotMatch(trackerHint('github'), /Jira|acli/);
});

test('`ticket` on Jira runs acli', () => {
  assert.deepEqual(ticketArgv('jira', ['view', 'pay-12']).args.slice(0, 4), ['jira', 'workitem', 'view', 'PAY-12']);
  assert.deepEqual(ticketArgv('jira', ['comment', 'PAY-12', '--body-file', 'note.md']), { bin: 'acli', args: ['jira', 'workitem', 'comment', 'create', '--key', 'PAY-12', '--body-file', 'note.md'] });
  assert.deepEqual(ticketArgv('jira', ['move', 'PAY-12', 'In', 'Progress']), { bin: 'acli', args: ['jira', 'workitem', 'transition', '--key', 'PAY-12', '--status', 'In Progress', '--yes'] });
  assert.deepEqual(ticketArgv('jira', ['new', '--project', 'pay', '--title', 'Fix it', '--body', 'Why']),
    { bin: 'acli', args: ['jira', 'workitem', 'create', '--project', 'PAY', '--type', 'Task', '--summary', 'Fix it', '--description', 'Why'] });
  assert.match(ticketArgv('jira', ['new', '--title', 'x']).error, /--project/);
  assert.match(ticketArgv('jira', ['view', 'acme/api#1']).error, /ABC-123/);
  assert.equal(ticketArgv('jira', ['mine']).args[2], 'search');
});

test('`ticket` on GitHub runs gh issue', () => {
  assert.deepEqual(ticketArgv('github', ['view', 'acme/api#12']), { bin: 'gh', args: ['issue', 'view', '12', '-R', 'acme/api', '--comments'] });
  assert.deepEqual(ticketArgv('github', ['view', '#12']).args, ['issue', 'view', '12', '--comments'], 'in the repo folder, gh knows the repo');
  assert.deepEqual(ticketArgv('github', ['comment', 'acme/api#12', '--body', 'Done']).args, ['issue', 'comment', '12', '-R', 'acme/api', '--body', 'Done']);
  assert.deepEqual(ticketArgv('github', ['move', 'acme/api#12', 'Done']).args, ['issue', 'close', '12', '-R', 'acme/api', '--reason', 'completed']);
  assert.deepEqual(ticketArgv('github', ['move', 'acme/api#12', 'open']).args, ['issue', 'reopen', '12', '-R', 'acme/api']);
  assert.match(ticketArgv('github', ['move', 'acme/api#12', 'In Review']).error, /open or closed/);
  assert.deepEqual(ticketArgv('github', ['new', '--repo', 'acme/api', '--title', 'Fix it']).args, ['issue', 'create', '-R', 'acme/api', '--title', 'Fix it', '--body', '']);
  assert.match(ticketArgv('github', ['new', '--repo', 'nope', '--title', 'x']).error, /owner\/name/);
  assert.deepEqual(ticketArgv('github', ['mine']).args.slice(0, 2), ['search', 'issues']);
});

test('`ticket` with no tracker, and its help', () => {
  assert.match(ticketArgv('none', ['view', 'PAY-1']).error, /no issue tracker/);
  assert.ok(ticketArgv('none', ['help']).help);
  assert.match(ticketArgv('github', ['frobnicate']).error, /unknown verb/);
  assert.match(ticketArgv('github', ['comment', 'acme/api#1', '--bogus']).error, /unknown option/);
  assert.match(TICKET_USAGE, /ticket move <ref> <status>/);
});

const pr = (number, title, o = {}) => ({ repo: 'acme/api', number, title, url: `https://github.com/acme/api/pull/${number}`, ...o });

test('stand-up with GitHub Issues: a PR goes with the issue it closes', () => {
  const g = groupStandup({
    tracker: 'github', sinceLabel: 'Monday 09:45',
    issueTitles: { 'acme/api#12': 'Retry webhooks' },
    yesterday: {
      tickets: { done: [{ key: 'acme/api#9', summary: 'Old bug', status: 'Closed' }], touched: [] },
      github: { merged: [pr(40, 'Retry with backoff', { issues: ['acme/api#12'] })], opened: [pr(41, 'PAY-7: not a Jira key here')] },
    },
    today: {},
  });
  assert.ok(g.yesterday.some((l) => /^Merged, ready to test: acme\/api#12: Retry webhooks \(acme\/api#40\)$/.test(l)), g.yesterday.join('\n'));
  assert.ok(g.yesterday.some((l) => /Finished: acme\/api#9: Old bug/.test(l)));
  assert.ok(g.yesterday.some((l) => /acme\/api#41 PAY-7: not a Jira key here/.test(l)), 'a Jira-looking key is just text');
  assert.ok(g.details.some((l) => /GitHub: Closed/.test(l)));
});

test('stand-up with no tracker: each PR on its own, nothing about Jira', () => {
  const g = groupStandup({
    tracker: 'none', sinceLabel: 'Monday 09:45',
    yesterday: { github: { merged: [pr(40, 'PAY-1: Retry', { issues: ['acme/api#12'], branch: 'PAY-1-retry' })] } },
    today: {},
  });
  assert.deepEqual(g.yesterday, ['Merged, ready to test: acme/api#40 PAY-1: Retry']);
  assert.ok(!g.details.join(' ').includes('Jira'));
});

test('review --ticket takes a GitHub issue as written', () => {
  assert.deepEqual(parseReviewArgs(['--ticket', 'Acme/Api#12']), { ticket: 'Acme/Api#12' });
  assert.deepEqual(parseReviewArgs(['--ticket', 'pay-3']), { ticket: 'PAY-3' });
  assert.match(parseReviewArgs(['--ticket', 'nope']).error, /owner\/name#12/);
});

test('doctor: acli is only recommended when Jira is the tracker', async () => {
  const run = async () => ({ ok: false, missing: true, out: '' });
  const base = { platform: 'linux', env: {}, has: () => true, srt: async () => true, run };
  const jira = (await checks({ ...base, tracker: 'jira' })).find((c) => c.id === 'acli');
  const gh = (await checks({ ...base, tracker: 'github' })).find((c) => c.id === 'acli');
  assert.equal(jira.need, 'recommended');
  assert.ok(jira.fix);
  assert.equal(gh.need, 'optional');
  assert.match(gh.detail, /not needed: your tickets are GitHub issues/);
  assert.equal(gh.fix, undefined);
  assert.equal(gh.login, null);
});

test('settings: the tracker and starred repos are checked', () => {
  assert.deepEqual(validate({ TRACKER: 'GitHub' }), { TRACKER: 'github' });
  assert.throws(() => validate({ TRACKER: 'linear' }), /jira, github or none/);
  assert.deepEqual(validate({ GITHUB_STARRED_REPOS: 'acme/api acme/web, acme/api' }), { GITHUB_STARRED_REPOS: 'acme/api, acme/web' });
  assert.throws(() => validate({ GITHUB_STARRED_REPOS: 'api' }), /owner\/name/);
});

test('a team pack can say where tickets live', () => {
  const p = parsePack(JSON.stringify({ name: 'T', settings: { TRACKER: 'github', GITHUB_STARRED_REPOS: 'acme/api' } }));
  assert.deepEqual(p.settings, { TRACKER: 'github', GITHUB_STARRED_REPOS: 'acme/api' });
});

test('what a chat did with `ticket` shows on the item', () => {
  assert.deepEqual(commandAction('ticket move pay-4 Done'), { text: 'moved PAY-4 to Done', key: 'issue:PAY-4' });
  assert.deepEqual(commandAction('ticket comment acme/api#3 --body-file x.md'), { text: 'commented on acme/api#3', key: 'gh:acme/api#3' });
  assert.equal(commandAction('ticket view PAY-4'), null);
});

test('the `ticket` command runs what it translates to, from PATH', async () => {
  const { mkdtempSync, writeFileSync, chmodSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join, dirname } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const dir = mkdtempSync(join(tmpdir(), 'cs-ticket-'));
  writeFileSync(join(dir, 'gh'), `#!/bin/sh\necho "gh $*"\n`);
  chmodSync(join(dir, 'gh'), 0o755);
  const bin = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'ticket-bin', 'ticket');
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, CLEARSKY_TRACKER: 'github' };
  const r = spawnSync(process.execPath, [bin, 'comment', 'acme/api#3', '--body', 'Looks good'], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'gh issue comment 3 -R acme/api --body Looks good');
  const h = spawnSync(process.execPath, [bin, 'help'], { env, encoding: 'utf8' });
  assert.match(h.stdout, /your tracker: GitHub Issues/);
  const n = spawnSync(process.execPath, [bin, 'view', 'PAY-1'], { env: { ...env, CLEARSKY_TRACKER: 'none' }, encoding: 'utf8' });
  assert.equal(n.status, 2);
  assert.match(n.stderr, /no issue tracker/);
});
