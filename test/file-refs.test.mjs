import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileRoots, checkFileRef, findFiles, fileRefLine } from '../lib/file-refs.mjs';

const setup = () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'cs-refs-')));
  for (const d of ['dev/app/src', 'dev/app/node_modules/dep', 'dev/app/.git', 'other', '.ssh']) mkdirSync(join(home, d), { recursive: true });
  for (const f of ['dev/app/src/Main.java', 'dev/app/README.md', 'dev/app/node_modules/dep/Main.js', 'dev/app/.git/config', 'other/Main.txt', '.ssh/id_ed25519']) writeFileSync(join(home, f), 'x');
  return { home, roots: fileRoots(['~/dev', join(home, 'nope'), '~/dev'], home) };
};

test('roots are the real folders that exist, once each', () => {
  const { home, roots } = setup();
  assert.deepEqual(roots, [join(home, 'dev')]);
});

test('a pointed-at path must be inside the chat\'s folders and not a secret', () => {
  const { home, roots } = setup();
  const cwd = join(home, 'dev/app');
  assert.deepEqual(checkFileRef('~/dev/app/README.md', { roots, home, cwd }), { path: join(home, 'dev/app/README.md'), dir: false, size: 1 });
  assert.deepEqual(checkFileRef('src', { roots, home, cwd }), { path: join(home, 'dev/app/src'), dir: true, size: null });
  assert.match(checkFileRef('~/other/Main.txt', { roots, home, cwd }).error, /outside this chat's folders/);
  assert.match(checkFileRef('~/.ssh/id_ed25519', { roots: [home], home, cwd }).error, /keeps hidden/);
  assert.match(checkFileRef('~/dev/nothing', { roots, home, cwd }).error, /isn't on this machine/);
  assert.match(checkFileRef('', { roots, home, cwd }).error, /Say which/);
});

test('the picker finds names under the folders, skipping dependencies, and lists typed paths', () => {
  const { home, roots } = setup();
  const cwd = join(home, 'dev/app');
  assert.deepEqual(findFiles('main', { roots, home, cwd }).map((f) => f.shown), ['~/dev/app/src/Main.java']);
  assert.deepEqual(findFiles('~/dev/app/', { roots, home, cwd }).map((f) => [f.name, f.dir]), [['node_modules', true], ['src', true], ['README.md', false]]);
  assert.deepEqual(findFiles('src/M', { roots, home, cwd }).map((f) => f.name), ['Main.java']);
  assert.deepEqual(findFiles('~/', { roots, home, cwd }).map((f) => f.name), ['dev'], 'nothing outside the folders but the way in');
  assert.deepEqual(findFiles('m', { roots, home, cwd }), [], 'one letter is too little to search');
});

test('the message names paths only', () => {
  const home = '/home/u';
  assert.equal(fileRefLine([{ path: '/home/u/dev/a.log' }, { path: '/home/u/dev/src', dir: true }], home),
    "Files I'm pointing you at (read them from disk, and only the parts you need): ~/dev/a.log, ~/dev/src/");
  assert.equal(fileRefLine([], home), '');
});
