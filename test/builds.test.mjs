import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOf, buildRepos, buildQuery } from '../lib/builds.mjs';

const node = (state, checks, extra = {}) => ({ nameWithOwner: 'acme/api', url: 'https://github.com/acme/api',
  defaultBranchRef: { name: 'main', target: { oid: 'abcdef123', abbreviatedOid: 'abcdef1', committedDate: '2026-11-04T08:00:00Z', messageHeadline: 'Fix it', url: 'u', author: { user: { login: 'anna' } },
    statusCheckRollup: state && { state, contexts: { nodes: checks } } } }, latestRelease: null, refs: { nodes: [{ name: 'v1.2.0' }] }, ...extra });

test('a main branch: passing, failing (with the check to look at), building or without checks', () => {
  const run = (name, status, conclusion) => ({ __typename: 'CheckRun', name, status, conclusion, detailsUrl: `https://ci/${name}` });
  assert.equal(buildOf(node('SUCCESS', [run('build', 'COMPLETED', 'SUCCESS')])).state, 'passing');
  const bad = buildOf(node('FAILURE', [run('lint', 'COMPLETED', 'SUCCESS'), run('test', 'COMPLETED', 'FAILURE')]));
  assert.equal(bad.state, 'failing');
  assert.deepEqual(bad.check, { name: 'test', state: 'failing', url: 'https://ci/test' });
  assert.equal(buildOf(node('PENDING', [run('build', 'IN_PROGRESS', null)])).check.state, 'running');
  assert.equal(buildOf(node(null, [])).state, 'none');
  assert.equal(buildOf(node('SUCCESS', [{ __typename: 'StatusContext', context: 'jenkins', state: 'ERROR', targetUrl: 'j' }])).check.state, 'failing');
  assert.equal(bad.tag, 'v1.2.0');
  assert.deepEqual(bad.commit, { sha: 'abcdef1', at: '2026-11-04T08:00:00Z', title: 'Fix it', url: 'u', by: 'anna' });
});

test('the newest artifact is from the main branch, not expired', () => {
  const arts = [
    { name: 'dist', created_at: '2026-11-04T09:00:00Z', expired: false, size_in_bytes: 10, workflow_run: { id: 7, head_branch: 'feature', head_sha: 'aaaaaaa1' } },
    { name: 'dist', created_at: '2026-11-04T08:30:00Z', expired: true, workflow_run: { id: 6, head_branch: 'main' } },
    { name: 'dist', created_at: '2026-11-04T08:10:00Z', expired: false, size_in_bytes: 20, workflow_run: { id: 5, head_branch: 'main', head_sha: 'abcdef1999' } },
  ];
  const b = buildOf(node('SUCCESS', []), arts);
  assert.deepEqual(b.artifact, { name: 'dist', at: '2026-11-04T08:10:00Z', size: 20, url: 'https://github.com/acme/api/actions/runs/5', sha: 'abcdef1' });
  assert.equal(buildOf(node('SUCCESS', []), [arts[0]]).artifact, null);
});

test('repos: the ones you named, else the ones your PRs and reviews are in', () => {
  assert.deepEqual(buildRepos('acme/a, acme/b bad', {}), ['acme/a', 'acme/b']);
  assert.deepEqual(buildRepos('', { myPrs: [{ repo: 'acme/x' }, { repo: 'acme/y' }, { repo: 'acme/y' }], reviewRequested: [{ repo: 'acme/z' }] }), ['acme/y', 'acme/x', 'acme/z']);
  assert.match(buildQuery(['acme/api']), /r0: repository\(owner: "acme", name: "api"\)/);
});
