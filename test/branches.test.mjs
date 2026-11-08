import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { branchesFor, findClones, keyPattern, parseRef } from '../lib/branches.mjs';

test('finds local and remote branches carrying a ticket key', async () => {
  const root = mkdtempSync(join(tmpdir(), 'clearsky-br-'));
  const clone = join(root, 'acme', 'abc');
  mkdirSync(clone, { recursive: true });
  const git = (...a) => execFileSync('git', ['-C', clone, ...a], { stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('remote', 'add', 'origin', 'git@github.com:acme/abc.git');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x');
  git('branch', 'feature/abc-12-login');
  git('branch', 'ABC-120');
  git('update-ref', 'refs/remotes/origin/feature/abc-12-login', 'HEAD');
  git('update-ref', 'refs/remotes/origin/ABC-7-other', 'HEAD');
  git('worktree', 'add', '-q', '-b', 'ABC-9', join(root, 'acme', 'abc-9'));
  assert.deepEqual(findClones([root]), [clone], 'a worktree is not a clone of its own');
  const got = await branchesFor(['ABC-12', 'ABC-7', 'ABC-9', 'ABC-1'], [root], { maxAgeMs: 0 });
  assert.deepEqual(got['ABC-12'], [{ repo: 'acme/abc', clone, branch: 'feature/abc-12-login', local: true, remote: true }]);
  assert.deepEqual(got['ABC-7'], [{ repo: 'acme/abc', clone, branch: 'ABC-7-other', local: false, remote: true }]);
  assert.equal(got['ABC-9'][0].branch, 'ABC-9');
  assert.equal(got['ABC-1'], undefined, 'ABC-1 is not ABC-12 or ABC-120');
});

test('key and ref parsing', () => {
  assert.ok(keyPattern('ABC-12').test('fix/abc-12_x'));
  assert.ok(!keyPattern('ABC-12').test('XSSP-12'));
  assert.ok(!keyPattern('ABC-12').test('ABC-123'));
  assert.deepEqual(parseRef('refs/remotes/origin/a/b'), { branch: 'a/b', remote: true });
  assert.equal(parseRef('refs/remotes/origin/HEAD'), null);
});
