import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeAdvice, deleteAdvice, githubAdvice, jiraAdvice, outsideAdvice, reviewTriage, ruleLabel, parseRules } from '../lib/advice.mjs';
import { validate } from '../lib/settings.mjs';

const ready = { number: 12, ours: true, ci: 'SUCCESS', approvals: ['alex'], changesRequested: [], mergeable: true, draft: false };

test('merging: fine only for the chat\'s green, approved PR without conflicts', () => {
  const a = mergeAdvice(ready);
  assert.equal(a.level, 'fine');
  assert.equal(a.rule, 'merge-ready');
  assert.match(a.text, /#12 is this chat's PR, CI is green and alex approved it/);
  for (const [change, why] of [[{ ours: false }, /isn't a PR this chat works on/], [{ ci: 'FAILURE' }, /CI is failing/], [{ ci: 'PENDING' }, /still running/],
    [{ ci: null }, /no CI result/], [{ approvals: [] }, /nobody has approved/], [{ changesRequested: ['sam'] }, /sam asked for changes/],
    [{ mergeable: false }, /conflicts/], [{ draft: true }, /draft/]]) {
    const b = mergeAdvice({ ...ready, ...change });
    assert.equal(b.level, 'check');
    assert.match(b.text, why);
    assert.equal(b.rule, undefined);
  }
  assert.equal(mergeAdvice(null).level, 'check');
});

test('deleting a branch: fine when its PR is merged', () => {
  assert.equal(deleteAdvice({ name: 'feat/x', merged: 3 }).rule, 'delete-merged-branch');
  assert.equal(deleteAdvice({ name: 'feat/x', merged: 3, open: 4 }).level, 'check');
  assert.equal(deleteAdvice({ name: 'main', merged: 3, shared: true }).level, 'check');
  assert.match(deleteAdvice({ name: 'feat/x' }).text, /only copy/);
});

test('other GitHub questions say why to check, and a repo can become a rule', () => {
  const a = githubAdvice('goes to acme/other, not a repo this chat works on', { chatRepos: new Set(['acme/app']) });
  assert.equal(a.level, 'check');
  assert.equal(a.rule, 'repo:acme/other');
  assert.match(a.text, /works on acme\/app, not acme\/other \(same owner/);
  assert.match(githubAdvice('pushes to develop').text, /not through a PR/);
  assert.match(githubAdvice('force-pushes feat/x').text, /dropped/);
  assert.match(githubAdvice('a one-off CI run of x, whose branch changes the workflows: workflows/b.yaml').text, /secrets/);
  assert.match(githubAdvice('deletes something').text, /can't be undone/);
  assert.equal(githubAdvice('merges, releases or changes repo settings', { merge: ready }).level, 'fine');
  assert.equal(githubAdvice('deletes feat/x', { branch: { name: 'feat/x', merged: 1 } }).level, 'fine');
});

test('Jira and outside questions', () => {
  const j = jiraAdvice({ keys: ['ABC-1'], projects: ['ABC'], bulk: false }, new Set(['DEF']));
  assert.match(j.text, /ABC-1 is in ABC, and this chat works on DEF/);
  assert.equal(j.rule, 'jira:ABC');
  assert.match(jiraAdvice({ keys: [], projects: [], bulk: true }).text, /every ticket a search finds/);
  assert.match(outsideAdvice({ vm: true }).text, /VM keeps it in/);
});

test('review requests: routine or verify, from sizes, paths and CI only', () => {
  const small = { size: { additions: 20, deletions: 5, files: 2 }, paths: ['src/main/java/app/Order.java', 'src/test/java/app/OrderTest.java'], ci: 'SUCCESS' };
  assert.deepEqual(reviewTriage(small), { level: 'routine', text: 'Routine: 25 lines in 2 files, CI green' });
  assert.match(reviewTriage({ ...small, paths: ['.github/workflows/build.yaml', 'x.java'] }).text, /Verify: touches CI workflows/);
  assert.match(reviewTriage({ ...small, paths: ['pom.xml', 'x.java'] }).text, /dependencies or the build/);
  assert.match(reviewTriage({ ...small, paths: ['src/auth/LoginFilter.java', 'x'] }).text, /security-related/);
  assert.match(reviewTriage({ ...small, paths: ['db/migration/V3__add.sql', 'x'] }).text, /database schema/);
  assert.match(reviewTriage({ ...small, size: { additions: 900, deletions: 10, files: 2 } }).text, /large/);
  assert.equal(reviewTriage({ size: { additions: 900, deletions: 10, files: 2 }, paths: ['docs/a.md', 'src/test/java/ATest.java'], ci: 'SUCCESS' }).text, 'Routine: only tests and docs, CI green');
  assert.match(reviewTriage({ ...small, ci: 'FAILURE' }).text, /CI is failing/);
  assert.match(reviewTriage({ ...small, ci: null }).text, /no CI result/);
  assert.match(reviewTriage({ ...small, botSuggestions: 2 }).text, /2 open Copilot suggestions/);
  assert.match(reviewTriage({ ...small, size: { additions: 20, deletions: 5, files: 150 } }).text, /more than Clearsky checked/);
  assert.equal(reviewTriage({ ...small, ci: 'PENDING' }).level, 'routine');
});

test('rules: labels, parsing, and only known kinds are accepted', () => {
  assert.match(ruleLabel('repo:acme/app'), /acme\/app/);
  assert.deepEqual([...parseRules('merge-ready, repo:acme/app jira:ABC')], ['merge-ready', 'repo:acme/app', 'jira:ABC']);
  assert.equal(validate({ COPILOT_GATE_RULES: 'merge-ready repo:acme/app,jira:ABC' }).COPILOT_GATE_RULES, 'merge-ready, repo:acme/app, jira:ABC');
  assert.throws(() => validate({ COPILOT_GATE_RULES: 'everything' }), /not a rule/);
});
