import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actOf, buildMap, buildKind } from '../lib/map.mjs';

test('map: what each logged step was, in words', () => {
  assert.deepEqual(actOf({ where: 'github', what: 'git push to acme/api (feature/abc-1)', decided: 'auto' }), { act: 'pushed', detail: 'feature/abc-1' });
  assert.equal(actOf({ where: 'github', what: 'POST acme/api/pulls', decided: 'auto' }).act, 'opened a PR');
  assert.deepEqual(actOf({ where: 'github', what: 'POST acme/api/issues/7/comments', decided: 'auto' }), { act: 'commented', detail: '', pr: 7 });
  assert.equal(actOf({ where: 'github', what: 'GitHub change (resolveReviewThread)', decided: 'auto' }).act, 'resolved a thread');
  assert.equal(actOf({ where: 'github', what: 'create branch abc-2 in acme/ops', decided: 'allowed' }).act, 'created branch abc-2');
  assert.equal(actOf({ where: 'jira', what: "acli jira workitem transition --key ABC-1 --status 'In Review'", decided: 'auto' }).act, 'moved to In Review');
  assert.equal(actOf({ where: 'jira', what: 'acli jira workitem create --project ABC --summary x', decided: 'allowed' }).act, 'created a ticket');
  assert.equal(actOf({ where: 'build', kind: 'test', what: './mvnw verify', decided: 'failed' }).act, 'tests failed');
  assert.equal(actOf({ where: 'review', what: 'review --ticket ABC-1', decided: 'reviewed', verdict: 'fix first' }).act, 'self-review: fix first');
  assert.equal(actOf({ where: 'github', what: 'POST acme/api/pulls', decided: 'declined' }).act, 'declined');
});

test('map: per chat, what it was started on, then each repo and ticket it found, with its acts in order', () => {
  const writes = [ // newest first, as readWrites gives them
    { at: '2026-01-01T10:05:00Z', where: 'jira', what: 'acli jira workitem create --project ABC', target: 'ABC', chats: [{ id: 'c1' }], decided: 'allowed' },
    { at: '2026-01-01T10:04:00Z', where: 'github', what: 'create branch abc-2 in acme/ops', target: 'acme/ops', chats: [{ id: 'c1' }], decided: 'allowed' },
    { at: '2026-01-01T10:03:00Z', where: 'github', what: 'git push to acme/api (abc-1)', target: 'acme/api', chats: [{ id: 'c1' }], decided: 'auto' },
    { at: '2026-01-01T10:02:00Z', where: 'build', kind: 'test', what: './mvnw verify', repo: 'acme/api', target: '~/dev/api', chats: [{ id: 'c1' }], decided: 'passed' },
    { at: '2026-01-01T10:01:00Z', where: 'build', kind: 'test', what: './mvnw verify', repo: 'acme/api', target: '~/dev/api', chats: [{ id: 'c1' }], decided: 'passed' },
    { at: '2026-01-01T09:00:00Z', where: 'github', what: 'POST acme/web/pulls', target: 'acme/web', chats: [{ id: 'c2' }], decided: 'auto' },
  ];
  const [c1, c2] = buildMap(writes, { scope: (id) => (id === 'c1' ? { repos: ['acme/api'], tickets: ['ABC-1'] } : {}) });
  assert.equal(c1.id, 'c1'); assert.equal(c2.id, 'c2');
  assert.deepEqual(c1.nodes.map((n) => `${n.kind}:${n.key}${n.scope ? '*' : ''}`), ['repo:acme/api*', 'ticket:ABC-1*', 'repo:acme/ops', 'project:ABC']);
  const api = c1.nodes[0];
  assert.deepEqual(api.acts.map((a) => a.act), ['tests passed', 'tests passed', 'pushed']);
  assert.deepEqual(api.branches, ['abc-1']);
  assert.deepEqual(c1.nodes[2].branches, ['abc-2']);
});

test('map: builds and test runs are told from other shell steps', () => {
  assert.equal(buildKind('./mvnw -q verify -pl core'), 'test');
  assert.equal(buildKind('vm ./mvnw test'), 'test');
  assert.equal(buildKind('npm test'), 'test');
  assert.equal(buildKind('npm run build'), 'build');
  assert.equal(buildKind('npm install'), null);
  assert.equal(buildKind('go test ./...'), 'test');
  assert.equal(buildKind('git status'), null);
  assert.equal(buildKind('cd api && ./gradlew build'), 'build');
});
