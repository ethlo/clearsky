import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostAllowed, makeContext } from '../lib/sources.mjs';
import { workItems as githubItems } from '../lib/modules/github.mjs';
import { workItems as jiraItems } from '../lib/modules/jira.mjs';
import { ticketKeys, prNext } from '../lib/items.mjs';

test('a source reaches only the hosts in its manifest, and sees only its own settings', async () => {
  assert.ok(hostAllowed('https://api.foresatt.visma.no/v1/x', ['api.foresatt.visma.no']));
  assert.ok(hostAllowed('https://a.b.example.net/', ['*.example.net']));
  assert.ok(!hostAllowed('https://github.com/', ['*.example.net', 'api.foresatt.visma.no']));
  const ctx = makeContext({ label: 'School', settings: { FLYT_SCHOOL_KEY: {} }, manifest: { hosts: ['api.foresatt.visma.no'] } },
    { FLYT_SCHOOL_KEY: 'k', GITHUB_TOKEN: 'secret' });
  assert.deepEqual(ctx.env, { FLYT_SCHOOL_KEY: 'k' });
  await assert.rejects(ctx.json('https://api.github.com/user'), /not in its manifest/);
});

test('modules turn their data into work items with the next step', () => {
  const pr = { repo: 'acme/api', number: 1, title: 'ABC-5: Fix', url: 'u1', branch: 'feature/ops-1-x', issues: ['acme/api#9'], updatedAt: 'now', stamp: 's',
    status: { label: 'No reviewer yet', owner: 'me', tone: 'warn' }, approvals: [], changesRequested: [], pendingReviewers: [], botSuggestions: 0 };
  const [it] = githubItems({ myPrs: [pr] });
  assert.equal(it.kind, 'pr');
  assert.deepEqual(it.links, ['issue:ABC-5', 'issue:OPS-1', 'gh:acme/api#9']);
  assert.deepEqual(it.next, { label: 'Request review', run: 'review' });
  assert.equal(prNext({ ...pr, status: { label: '2 unresolved threads' } }).skill, 'continue');
  assert.equal(prNext({ ...pr, status: { label: 'In review rounds', owner: 'me' } }).label, 'Address Copilot\'s comments');
  assert.ok(prNext({ ...pr, status: { label: 'In review rounds', owner: 'others' } }).wait);
  const [t, w] = jiraItems({ assigned: [{ key: 'ABC-5', summary: 'x', url: 'j', status: 'In Progress', statusCategory: 'indeterminate' },
    { key: 'ABC-6', summary: 'y', url: 'k', status: 'In Review', statusCategory: 'indeterminate', waiting: true }] });
  assert.equal(t.next.run, 'start');
  assert.deepEqual(w.next, { label: 'Waiting: In Review', wait: true });
  assert.deepEqual(ticketKeys('UTF-8 and ABC-5', 'ops-2-y'), ['UTF-8', 'ABC-5', 'OPS-2']);
});

test('"Merge it" merges your PR the way the repo allows, and says why GitHub refused', async () => {
  const { createGitHub } = await import('../lib/modules/github.mjs');
  assert.deepEqual(prNext({ repo: 'acme/api', number: 7, url: 'https://github.com/acme/api/pull/7', status: { label: 'Ready to merge' } }),
    { label: 'Merge it', run: 'merge', repo: 'acme/api', number: 7, url: 'https://github.com/acme/api/pull/7' });
  const calls = [];
  const http = async (url, o = {}) => { calls.push([o.method || 'GET', url, o.body]); return url.endsWith('/repos/acme/api') ? { allow_squash_merge: false, allow_merge_commit: true } : { merged: true }; };
  const gh = createGitHub({ config: { github: { api: 'https://gh.test', token: 't' } }, http, execFileP: async () => ({ stdout: '' }), daysAgoIso: () => '' });
  assert.deepEqual(await gh.mergePr('acme/api', 7), { method: 'merge' });
  assert.deepEqual(calls.at(-1), ['PUT', 'https://gh.test/repos/acme/api/pulls/7/merge', { merge_method: 'merge' }]);
});
