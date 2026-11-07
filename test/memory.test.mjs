import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseRemember, addNotes, writeMemory, readMemory, memoryHint, memoryDir, MAX_BYTES } from '../lib/memory.mjs';

test('a remember block: an optional repo line, then one note per line', () => {
  assert.deepEqual(parseRemember('repo: acme/api\n- Tests need the VM\n\nSmall PRs,  please\n'), { repo: 'acme/api', lines: ['Tests need the VM', 'Small PRs, please'] });
  assert.deepEqual(parseRemember('Prefers rebase\nrepo: acme/api'), { repo: null, lines: ['Prefers rebase', 'repo: acme/api'] });
  assert.deepEqual(parseRemember('repo: nope\nNote'), { repo: null, lines: ['Note'] });
});

test('notes go under their heading, once each', () => {
  let r = addNotes('', { lines: ['Small PRs'] });
  assert.equal(r.added, 1);
  assert.match(r.text, /^# Copilot's memory\n[\s\S]*\n## All chats\n- Small PRs\n$/);
  r = addNotes(r.text, { lines: ['Tests need the VM'], repo: 'acme/api' });
  r = addNotes(r.text, { lines: ['Answer in English', 'Small PRs'] });
  assert.equal(r.added, 1, 'a note already there is skipped');
  assert.match(r.text, /## All chats\n- Small PRs\n- Answer in English\n\n## acme\/api\n- Tests need the VM\n$/);
  assert.deepEqual(addNotes(r.text, { lines: ['Small PRs'] }), { text: r.text, added: 0 });
});

test('memory stays short', () => {
  const big = addNotes('x'.repeat(MAX_BYTES - 10), { lines: ['one more note'] });
  assert.match(big.error, /Memory is full/);
  const dir = mkdtempSync(join(tmpdir(), 'clearsky-mem-'));
  const file = join(dir, 'memory', 'memory.md');
  assert.equal(readMemory(file), '');
  assert.match(writeMemory(file, 'y'.repeat(MAX_BYTES + 1)).error, /full/);
  assert.deepEqual(writeMemory(file, '# Mine\r\n- a\r\n'), { text: '# Mine\n- a\n' });
  assert.equal(readFileSync(file, 'utf8'), '# Mine\n- a\n');
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
});

test('a new chat is told where its memory is, and not to change it', () => {
  const home = '/home/me', file = join(memoryDir({}, home), 'memory.md');
  assert.equal(file, '/home/me/.local/share/clearsky/memory/memory.md');
  const h = memoryHint(file, '- a note', home);
  assert.match(h, /in ~\/\.local\/share\/clearsky\/memory\/memory\.md/);
  assert.match(h, /Never change that file yourself/);
  assert.match(h, /```remember\n/);
  assert.match(memoryHint(file, '', home), /empty so far/);
  assert.equal(memoryDir({ CLEARSKY_MEMORY_DIR: '/x' }, home), '/x');
});
