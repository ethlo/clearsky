import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { branchesFor, findClones, keyPattern, parseRef } from '../lib/branches.mjs';

test('finds local and remote branches carrying a ticket key', async () => {
  const root = mkdtempSync(join(tmpdir(), 'clearsky-br-'));
  const clone = join(root, 'acme', 'ssp');
  mkdirSync(clone, { recursive: true });
  const git = (...a) => execFileSync('git', ['-C', clone, ...a], { stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('remote', 'add', 'origin', 'git@github.com:acme/ssp.git');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x');
  git('branch', 'feature/ssp-12-login');
  git('branch', 'SSP-120');
  git('update-ref', 'refs/remotes/origin/feature/ssp-12-login', 'HEAD');
  git('update-ref', 'refs/remotes/origin/SSP-7-other', 'HEAD');
  git('worktree', 'add', '-q', '-b', 'SSP-9', join(root, 'acme', 'ssp-9'));
  assert.deepEqual(findClones([root]), [clone], 'a worktree is not a clone of its own');
  const got = await branchesFor(['SSP-12', 'SSP-7', 'SSP-9', 'SSP-1'], [root], { maxAgeMs: 0 });
  assert.deepEqual(got['SSP-12'], [{ repo: 'acme/ssp', clone, branch: 'feature/ssp-12-login', local: true, remote: true }]);
  assert.deepEqual(got['SSP-7'], [{ repo: 'acme/ssp', clone, branch: 'SSP-7-other', local: false, remote: true }]);
  assert.equal(got['SSP-9'][0].branch, 'SSP-9');
  assert.equal(got['SSP-1'], undefined, 'SSP-1 is not SSP-12 or SSP-120');
});

test('key and ref parsing', () => {
  assert.ok(keyPattern('SSP-12').test('fix/ssp-12_x'));
  assert.ok(!keyPattern('SSP-12').test('XSSP-12'));
  assert.ok(!keyPattern('SSP-12').test('SSP-123'));
  assert.deepEqual(parseRef('refs/remotes/origin/a/b'), { branch: 'a/b', remote: true });
  assert.equal(parseRef('refs/remotes/origin/HEAD'), null);
});
