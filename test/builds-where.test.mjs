import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildsWhere, buildsHint } from '../bin/clearsky.mjs';
import { validate } from '../lib/settings.mjs';

test('builds go to the chat\'s VM unless Settings say sandbox or there is no VM', () => {
  assert.equal(buildsWhere('', true), 'vm');
  assert.equal(buildsWhere(undefined, true), 'vm');
  assert.equal(buildsWhere('sandbox', true), 'sandbox');
  assert.equal(buildsWhere('', false), 'sandbox');
});

test('the chat is told where its builds run', () => {
  const vm = buildsHint('vm'), sb = buildsHint('sandbox');
  assert.match(vm, /Run every build and test in this chat's VM, never directly in the sandbox/);
  assert.match(vm, /bg vm <command>/);
  assert.doesNotMatch(vm, /always run them normally first/);
  assert.match(sb, /always run them normally\s+first, and use `vm` only after/);
});

test('Run builds in takes vm or sandbox', () => {
  assert.equal(validate({ COPILOT_BUILDS: 'sandbox' }).COPILOT_BUILDS, 'sandbox');
  assert.throws(() => validate({ COPILOT_BUILDS: 'laptop' }), /vm or sandbox/);
});
