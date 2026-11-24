import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const root = mkdtempSync(join(tmpdir(), 'cs-cp-'));
process.env.CLEARSKY_CHECKPOINTS = join(root, 'store');
const cp = await import('../lib/checkpoints.mjs');
const repo = join(root, 'repo'), C = 'chat-abcdef12';
mkdirSync(join(repo, 'target'), { recursive: true });
const g = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a]);
g('init', '-q'); writeFileSync(join(repo, 'a.txt'), 'a'); writeFileSync(join(repo, '.gitignore'), 'target/\n'); writeFileSync(join(repo, 'target', 'x'), 'built');
g('add', '.'); g('commit', '-qm', 'init');
const head = () => String(g('rev-parse', 'HEAD')).trim();

test('rewind puts files back, leaves ignored files and git history alone, and can be undone', async () => {
  const before = head();
  const first = await cp.snapshot(C, join(repo, 'target'), 'Fix the bug please');
  assert.equal(first.root, repo);
  writeFileSync(join(repo, 'a.txt'), 'changed'); writeFileSync(join(repo, 'new.txt'), 'n'); writeFileSync(join(repo, 'target', 'x'), 'rebuilt');
  g('add', '-A'); g('commit', '-qm', 'agent commit');
  await cp.snapshot(C, repo, 'second');
  const list = await cp.list(C);
  assert.deepEqual(list.map((x) => [x.text, x.files]), [['second', 0], ['Fix the bug please', 2]]);
  const r = await cp.rewind(C, first.id);
  assert.deepEqual(r.changed.sort(), ['a.txt', 'new.txt']);
  assert.equal(readFileSync(join(repo, 'a.txt'), 'utf8'), 'a');
  assert.ok(!existsSync(join(repo, 'new.txt')));
  assert.equal(readFileSync(join(repo, 'target', 'x'), 'utf8'), 'rebuilt'); // ignored: untouched
  assert.notEqual(head(), before); // the agent's commit is still there
  const note = cp.takeNote(C);
  assert.ok(note.startsWith(cp.REWIND_INTRO) && note.includes('Fix the bug please'));
  assert.equal(cp.takeNote(C), null);
  // Undo: the "before rewind" checkpoint is the newest.
  const undo = (await cp.list(C))[0];
  assert.equal(undo.kind, 'rewind');
  assert.equal(undo.id, r.undo);
  await cp.rewind(C, undo.id);
  assert.equal(readFileSync(join(repo, 'a.txt'), 'utf8'), 'changed');
  assert.ok(existsSync(join(repo, 'new.txt')));
});

test('no checkpoints outside a git repo, for bad ids, or in the home folder', async () => {
  const plain = join(root, 'plain'); mkdirSync(plain);
  assert.equal(await cp.snapshot('chat-plain123', plain, 'x'), null);
  assert.equal(await cp.snapshot('../../etc', repo, 'x'), null);
  assert.deepEqual(await cp.list('../x'), []);
  await assert.rejects(cp.rewind(C, 'nope'), /gone/);
});

test('old chats lose their checkpoints', async () => {
  cp.prune({ now: Date.now() + (cp.MAX_AGE_DAYS + 1) * 864e5, force: true });
  assert.deepEqual(readdirSync(process.env.CLEARSKY_CHECKPOINTS), []);
  rmSync(root, { recursive: true, force: true });
});
