import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, symlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { changeDiff } from '../lib/app/chat-outputs.mjs';

test('the review pane gets every changed file of the branch, new ones too, never through a link', async () => {
  const d = mkdtempSync(join(tmpdir(), 'cs-review-'));
  const g = (...a) => execFileSync('git', ['-C', d, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a]);
  g('init', '-q', '-b', 'main');
  writeFileSync(join(d, 'a.txt'), 'one\ntwo\n');
  g('add', '.'); g('commit', '-qm', 'base');
  g('checkout', '-qb', 'feature');
  writeFileSync(join(d, 'a.txt'), 'one\nTWO\n');
  g('commit', '-qam', 'change');
  writeFileSync(join(d, 'new.txt'), 'hello\n');
  writeFileSync(join(tmpdir(), 'cs-review-secret'), 'secret\n');
  symlinkSync(join(tmpdir(), 'cs-review-secret'), join(d, 'link.txt'));
  const r = await changeDiff(d);
  assert.equal(r.root, d);
  assert.deepEqual(r.files.map((f) => f.path).sort(), ['a.txt', 'new.txt']);
  assert.match(r.diff, /\+TWO/);
  assert.match(r.diff, /\+\+\+ b\/new\.txt\n@@ -0,0 \+1,1 @@\n\+hello/);
  assert.doesNotMatch(r.diff, /secret/);
});

test('outside a git clone there is nothing to review', async () => {
  const r = await changeDiff(mkdtempSync(join(tmpdir(), 'cs-review-')));
  assert.equal(r.root, null);
  assert.deepEqual(r.files, []);
});
