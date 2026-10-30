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
  const pr = { repo: 'acme/api', number: 1, title: 'SSP-5: Fix', url: 'u1', branch: 'feature/ops-1-x', issues: ['acme/api#9'], updatedAt: 'now', stamp: 's',
    status: { label: 'No reviewer yet', owner: 'me', tone: 'warn' }, approvals: [], changesRequested: [], pendingReviewers: [], botSuggestions: 0 };
  const [it] = githubItems({ myPrs: [pr] });
  assert.equal(it.kind, 'pr');
  assert.deepEqual(it.links, ['issue:SSP-5', 'issue:OPS-1', 'gh:acme/api#9']);
  assert.deepEqual(it.next, { label: 'Request review', run: 'review' });
  assert.equal(prNext({ ...pr, status: { label: '2 unresolved threads' } }).skill, 'continue');
  const [t, w] = jiraItems({ assigned: [{ key: 'SSP-5', summary: 'x', url: 'j', status: 'In Progress', statusCategory: 'indeterminate' },
    { key: 'SSP-6', summary: 'y', url: 'k', status: 'In Review', statusCategory: 'indeterminate', waiting: true }] });
  assert.equal(t.next.run, 'start');
  assert.deepEqual(w.next, { label: 'Waiting: In Review', wait: true });
  assert.deepEqual(ticketKeys('UTF-8 and SSP-5', 'ops-2-y'), ['UTF-8', 'SSP-5', 'OPS-2']);
});
