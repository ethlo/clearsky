import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logEvent } from '../lib/event-log.mjs';

test('logEvent appends a timestamped line and rotates a big file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cs-log-'));
  const file = join(dir, 'sub', 'clearsky.log');
  logEvent('restart asked (when idle), 1 busy chat(s)', { file, echo: false, now: new Date('2026-11-02T09:55:30Z') });
  assert.equal(readFileSync(file, 'utf8'), '2026-11-02T09:55:30.000Z restart asked (when idle), 1 busy chat(s)\n');
  writeFileSync(file, 'x'.repeat(600 * 1024));
  logEvent('started', { file, echo: false });
  assert.ok(existsSync(`${file}.1`));
  assert.match(readFileSync(file, 'utf8'), /^\S+ started\n$/);
});
