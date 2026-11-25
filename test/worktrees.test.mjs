import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { chatWorktree, freePath, slug } from '../lib/worktrees.mjs';

const root = mkdtempSync(join(tmpdir(), 'cs-wt-'));
const g = (dir, ...a) => String(execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a])).trim();
const origin = join(root, 'origin'), clone = join(root, 'payments');
execFileSync('git', ['init', '-q', '-b', 'main', origin]);
writeFileSync(join(origin, 'a.txt'), 'a'); g(origin, 'add', '.'); g(origin, 'commit', '-qm', 'init');
g(origin, 'branch', 'PAY-12-refunds');
execFileSync('git', ['clone', '-q', origin, clone]);

test('names', () => {
  assert.equal(slug('feature/PAY-12 refunds'), 'feature-PAY-12-refunds');
  assert.equal(slug('../..'), 'chat');
  assert.equal(freePath('/d/repo', 'x', (p) => p === '/d/repo-x'), '/d/repo-x-2');
});

test('a PR branch only on the remote gets a tracking worktree next to the clone', async () => {
  const w = await chatWorktree({ clone, branch: 'PAY-12-refunds' });
  assert.equal(w.dir, join(root, 'payments-PAY-12-refunds'));
  assert.ok(w.made);
  assert.equal(g(w.dir, 'symbolic-ref', '--short', 'HEAD'), 'PAY-12-refunds');
  assert.equal(g(clone, 'symbolic-ref', '--short', 'HEAD'), 'main'); // your clone stays put
});

test('the branch your clone is on: the clone itself', async () => {
  assert.deepEqual(await chatWorktree({ clone, branch: 'main' }), { dir: clone, why: 'your clone is on that branch' });
});

test('a new task gets a detached worktree at the default branch', async () => {
  const w = await chatWorktree({ clone, name: 'PAY-50' });
  assert.equal(w.dir, join(root, 'payments-PAY-50'));
  assert.equal(g(w.dir, 'rev-parse', 'HEAD'), g(clone, 'rev-parse', 'origin/HEAD'));
});

test('a repo whose own config runs a program gets none, and no hook runs', async () => {
  g(clone, 'config', 'core.fsmonitor', 'touch /tmp/nope');
  const w = await chatWorktree({ clone, branch: 'other' });
  assert.equal(w.dir, null);
  assert.match(w.why, /programs/);
  g(clone, 'config', '--unset', 'core.fsmonitor');
  writeFileSync(join(clone, '.git', 'hooks', 'post-checkout'), `#!/bin/sh\ntouch ${join(root, 'hook-ran')}\n`, { mode: 0o755 });
  const w2 = await chatWorktree({ clone, name: 'hooks' });
  assert.ok(w2.dir);
  assert.ok(!existsSync(join(root, 'hook-ran')));
});

test('a branch that is nowhere: none, with git\'s reason', async () => {
  const w = await chatWorktree({ clone, branch: 'no-such-branch' });
  assert.equal(w.dir, null);
  assert.ok(w.why);
  rmSync(root, { recursive: true, force: true });
});
