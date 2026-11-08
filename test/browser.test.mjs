import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findBrowser } from '../lib/browser.mjs';

test('findBrowser prefers your default browser, then Chrome', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cs-browser-'));
  for (const b of ['chromium', 'google-chrome-stable', 'brave-browser']) writeFileSync(join(dir, b), '');
  const env = { PATH: dir };
  assert.equal(findBrowser(env, { desktop: 'brave-browser.desktop' }), join(dir, 'brave-browser'));
  assert.equal(findBrowser(env, { desktop: '' }), join(dir, 'google-chrome-stable'));
  assert.equal(findBrowser({ ...env, CLEARSKY_BROWSER: '/x/y' }, { desktop: '' }), '/x/y');
});
