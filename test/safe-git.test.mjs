import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SAFE_GIT, SAFE_DIFF, localPrograms } from '../lib/safe-git.mjs';

const repo = () => {
  const dir = mkdtempSync(join(tmpdir(), 'safe-git-'));
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  git('init', '-q'); git('config', 'user.email', 'a@example.com'); git('config', 'user.name', 'A');
  writeFileSync(join(dir, 'f.txt'), 'one\n'); git('add', 'f.txt'); git('commit', '-qm', 'first');
  writeFileSync(join(dir, 'f.txt'), 'one\ntwo\n');
  return { dir, git };
};
const script = (dir, name) => {
  const mark = join(dir, `${name}.ran`), file = join(dir, `${name}.sh`);
  writeFileSync(file, `#!/bin/sh\necho ran > '${mark}'\ncat\n`); chmodSync(file, 0o755);
  return { mark, file };
};

test('a repo\'s own file-system monitor and diff program don\'t run under SAFE_GIT', () => {
  const { dir, git } = repo();
  const fsm = script(dir, 'fsm'), ext = script(dir, 'ext');
  git('config', 'core.fsmonitor', fsm.file); git('config', 'diff.external', ext.file);
  const out = execFileSync('git', ['-C', dir, ...SAFE_GIT, 'diff', '--no-color', ...SAFE_DIFF, 'HEAD', '--', 'f.txt'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  assert.match(out, /\+two/);
  assert.equal(existsSync(fsm.mark), false, 'the monitor stayed off');
  assert.equal(existsSync(ext.mark), false, 'the diff program stayed off');
});

test('a repo whose own settings name a program is told apart', async () => {
  const { dir, git } = repo();
  assert.deepEqual(await localPrograms(dir), []);
  git('config', 'core.fsmonitor', 'true'); // git's own monitor: not a program of the repo's
  assert.deepEqual(await localPrograms(dir), []);
  git('config', 'filter.x.clean', 'sh -c "cat"');
  git('config', 'core.fsmonitor', '/tmp/x.sh');
  git('config', 'diff.pdf.textconv', 'pdftotext');
  assert.deepEqual((await localPrograms(dir)).sort(), ['core.fsmonitor', 'diff.pdf.textconv', 'filter.x.clean']);
  assert.deepEqual(await localPrograms(tmpdir()), [], 'not a repo: nothing to run');
});
