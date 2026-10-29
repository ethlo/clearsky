import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { dismissed, setDismissed, isDismissed, muted, setMuted } from '../lib/state.mjs';

test('dismissed and muted items are kept in a private state file', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'clearsky-state-')), 'sub', 'state.json');
  assert.deepEqual(dismissed(file), {});

  setDismissed(file, { key: 'https://x/1', stamp: '2026-10-29T10:00:00Z' });
  setDismissed(file, { key: 'jira-mention:SSP-1', stamp: 1042 });
  const d = dismissed(file);
  assert.ok(isDismissed(d, 'https://x/1', '2026-10-29T10:00:00Z'));
  assert.ok(!isDismissed(d, 'https://x/1', '2026-10-29T11:00:00Z'), 'new activity brings it back');
  assert.ok(isDismissed(d, 'jira-mention:SSP-1', '1042'));
  assert.equal(statSync(file).mode & 0o777, 0o600);

  setDismissed(file, { key: 'https://x/1', stamp: null });
  assert.deepEqual(Object.keys(dismissed(file)), ['jira-mention:SSP-1']);
  setDismissed(file, { clear: true });
  assert.deepEqual(dismissed(file), {});
  assert.throws(() => setDismissed(file, { stamp: 'x' }), /bad key/);

  const soon = new Date(Date.now() + 36e5).toISOString();
  setMuted(file, { key: 'u1', until: soon });
  setMuted(file, { key: 'u2', until: new Date(Date.now() - 1000).toISOString() });
  assert.deepEqual(muted(file), { u1: soon }, 'expired mutes are gone');
  setMuted(file, { key: 'u1', until: null });
  assert.deepEqual(muted(file), {});
  assert.throws(() => setMuted(file, { key: 'u1', until: 'soon' }), /bad time/);
});

test('read marks are kept per item, and can be taken back', async () => {
  const { readMarks, setRead } = await import('../lib/state.mjs');
  const file = join(mkdtempSync(join(tmpdir(), 'clearsky-state-')), 'state.json');
  assert.deepEqual(readMarks(file), {});
  setRead(file, [{ key: 'flyt:flyt:notice:1:5', at: '2026-10-29T09:00:00.000Z' }, { key: 'flyt:flyt:direct:1:7', at: '2026-10-28T07:15:00.000Z' }]);
  assert.equal(readMarks(file)['flyt:flyt:notice:1:5'], '2026-10-29T09:00:00.000Z');
  setRead(file, [{ key: 'flyt:flyt:notice:1:5', at: null }]);
  assert.deepEqual(Object.keys(readMarks(file)), ['flyt:flyt:direct:1:7']);
  assert.throws(() => setRead(file, [{ key: '', at: 'x' }]), /bad key/);
});
