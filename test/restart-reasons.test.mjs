import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pluginChanges, settingChanges, fileChanges } from '../lib/restart-reasons.mjs';

test('plugins added, removed or updated since start need a restart; other registry fields do not', () => {
  const before = { a: { from: 'github:x/a', version: '1.0.0', commit: 'c1', hash: 'h1', run: 'sandbox', at: '2026-01-01' }, b: { from: 'b', kind: 'bundled' } };
  assert.deepEqual(pluginChanges(before, before), []);
  assert.deepEqual(pluginChanges(before, { ...before, a: { ...before.a, at: '2026-02-02' } }), [], 'only when it was added changed');
  const after = { a: { ...before.a, commit: 'c2', hash: 'h2' }, c: { from: 'github:x/c' } };
  assert.deepEqual(pluginChanges(before, after, (n) => n.toUpperCase()).map((r) => r.text), ['A updated', 'C added', 'B removed']);
});

test('a plugin setting marked "restart" needs a restart when it changes; the rest apply at once', () => {
  const fields = { CLEARSKY_STANDUP_TIME: { secret: false }, WEATHER_PLACE: { restart: true, label: 'Place' } };
  assert.deepEqual(settingChanges({ CLEARSKY_STANDUP_TIME: '09:45' }, { CLEARSKY_STANDUP_TIME: '10:00' }, fields), []);
  assert.deepEqual(settingChanges({}, { WEATHER_PLACE: 'Oslo' }, fields).map((r) => r.text), ['Place changed']);
  assert.deepEqual(settingChanges({ WEATHER_PLACE: 'Oslo' }, { WEATHER_PLACE: 'Oslo' }, fields), [], 'changed back: no notice');
});

test('the settings file edited by hand needs a restart; saved from Settings it does not', () => {
  const atStart = { GITHUB_ORGS: 'acme', GITHUB_TOKEN: 's3cret' };
  assert.deepEqual(fileChanges(atStart, atStart, atStart), []);
  assert.deepEqual(fileChanges(atStart, { ...atStart, GITHUB_ORGS: 'acme,other' }, { ...atStart, GITHUB_ORGS: 'acme,other' }), [], 'saved from Settings: in use already');
  const r = fileChanges(atStart, { GITHUB_ORGS: 'other', AGENT_VM_MAX: '2' }, atStart);
  assert.equal(r.length, 1);
  assert.equal(r[0].text, 'AGENT_VM_MAX, GITHUB_ORGS, GITHUB_TOKEN changed in your settings file');
  assert.doesNotMatch(JSON.stringify(r), /s3cret|other/, 'names only, never values');
});
