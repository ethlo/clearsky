import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseReviewArgs, changeOf, reviewPrompt, writeBaseFiles, reviewDecision } from '../lib/review.mjs';

test('review: the goal is a ticket or a short sentence, never an essay', () => {
  assert.deepEqual(parseReviewArgs(['--ticket', 'abc-12']), { ticket: 'ABC-12' });
  assert.deepEqual(parseReviewArgs(['--goal', 'Retry uploads', '--base', 'develop']), { goal: 'Retry uploads', base: 'develop' });
  assert.match(parseReviewArgs([]).error, /--ticket KEY/);
  assert.match(parseReviewArgs(['--goal', 'x'.repeat(601)]).error, /at most 600/);
  assert.match(parseReviewArgs(['--base', 'a;rm']).error, /bad --base/);
  assert.match(parseReviewArgs(['--context', 'my reasoning']).error, /unknown argument --context/);
  assert.equal(parseReviewArgs(['help']).help, true);
});

test('review: the change is the branch against where it left base, uncommitted and new files too', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cs-review-'));
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'a@example.com'); git('config', 'user.name', 'A');
  writeFileSync(join(dir, 'a.txt'), 'one\n'); git('add', '.'); git('commit', '-qm', 'base');
  git('checkout', '-qb', 'feature/abc-1');
  writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n'); git('commit', '-qam', 'change');
  writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\n');
  writeFileSync(join(dir, 'new.txt'), 'fresh\n');
  const c = await changeOf(dir, 'main');
  assert.equal(c.branch, 'feature/abc-1');
  assert.match(c.diff, /\+two/); assert.match(c.diff, /\+three/); assert.match(c.diff, /\+fresh/);
  assert.deepEqual(c.untracked, ['new.txt']);
  const p = reviewPrompt({ ticket: { key: 'ABC-1', type: 'Bug', summary: 'Fix it', description: 'Must not crash.' }, change: c });
  assert.match(p, /Ticket ABC-1 \(Bug\): Fix it\n\nMust not crash\./);
  assert.match(p, /VERDICT: ready/);
  assert.match(p, /New files not yet added to git .*: new.txt/);
  assert.match(p, /feature\/abc-1 against main/);
  const base = join(mkdtempSync(join(tmpdir(), 'cs-base-')), 'b');
  assert.deepEqual(await writeBaseFiles(dir, c, base), ['a.txt'], 'new files have no base side');
  assert.equal(readFileSync(join(base, 'a.txt'), 'utf8'), 'one\n');
  assert.equal(existsSync(join(base, 'new.txt')), false);
  const pb = reviewPrompt({ goal: 'g', change: c, baseDir: base, baseFiles: ['a.txt'] });
  assert.ok(pb.includes(`${base} holds the changed files as they were before`));
  git('checkout', '-q', '.'); execFileSync('rm', [join(dir, 'new.txt')]); git('checkout', '-q', 'main');
  await assert.rejects(changeOf(dir, 'main'), /nothing changed/);
  await assert.rejects(changeOf(dir, 'nope'), /can't find nope/);
});

test('review: the reviewer reads the repo and the base copies, nothing else', () => {
  const roots = ['/w/repo', '/t/base'];
  const ask = (kind, rawInput, extra = {}) => reviewDecision({ toolCall: { kind, rawInput, ...extra } }, roots);
  assert.equal(ask('read', { path: 'src/a.js' }).ok, true);
  assert.equal(ask('read', { path: '/w/repo/src/a.js' }).ok, true);
  assert.equal(ask('read', { path: '/t/base/src/a.js' }).ok, true);
  assert.equal(ask('search', {}, { locations: [{ path: '/w/repo' }] }).ok, true);
  const out = ask('read', { path: '/w/main-checkout/src/a.js' });
  assert.equal(out.ok, false);
  assert.equal(out.what, 'read /w/main-checkout/src/a.js (outside the repo)');
  assert.equal(ask('read', { path: '../repo-other/x' }).ok, false);
  assert.equal(ask('execute', { command: 'git diff main' }, { title: 'git diff main' }).what, 'git diff main');
  assert.equal(ask('execute', {}).ok, false);
});
