import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkFolder } from '../lib/chat-folders.mjs';

test('a chat gets real folders in your home, never secrets, hidden ones or home itself', () => {
  const home = mkdtempSync(join(tmpdir(), 'cs-home-'));
  for (const d of ['dev/other', '.config/clearsky', '.ssh', 'dev/x']) mkdirSync(join(home, d), { recursive: true });
  assert.deepEqual(checkFolder('~/dev/other', home), { path: join(home, 'dev/other') });
  assert.deepEqual(checkFolder(join(home, 'dev'), home), { path: join(home, 'dev') });
  assert.match(checkFolder('~', home).error, /not your home itself/);
  assert.match(checkFolder('/etc', home).error, /inside your home/);
  assert.match(checkFolder('~/.config/clearsky', home).error, /hidden/);
  assert.match(checkFolder('~/.ssh', home).error, /hidden/);
  assert.match(checkFolder('~/nope', home).error, /isn't a folder/);
  assert.match(checkFolder('', home).error, /Say which/);
  assert.match(checkFolder('~/dev/../.ssh', home).error, /hidden/);
});
