import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { hooksConfig, hookFiles, runHook, failText, tail } from '../lib/hooks.mjs';

const run = promisify(execFile);

test('hooks are off until one is set', () => {
  assert.equal(hooksConfig({}), null);
  assert.deepEqual(hooksConfig({ AGENT_HOOK_BEFORE_DONE: ' npm test ' }), { afterEdit: null, beforeDone: 'npm test', retries: 2 });
  assert.equal(hooksConfig({ AGENT_HOOK_AFTER_EDIT: 'x', AGENT_HOOK_RETRIES: '9' }).retries, 2);
  assert.equal(hooksConfig({ AGENT_HOOK_AFTER_EDIT: 'x', AGENT_HOOK_RETRIES: '0' }).retries, 0);
});

test('a hook gets the changed files in the chat folder, relative, existing only', () => {
  const have = new Set(['/r/a.js', '/r/src/b.js', '/other/c.js']);
  assert.deepEqual(hookFiles(['/r/a.js', '/r/src/b.js', '/r/gone.js', '/other/c.js', '/r/a.js', '/rx/d.js'], '/r', (p) => have.has(p)), ['a.js', 'src/b.js']);
});

test('running: files as "$@", exit codes and output', async () => {
  const ok = await runHook(run, 'printf "%s|" "$@"', ['a b.js', 'c.js']);
  assert.deepEqual(ok, { code: 0, out: 'a b.js|c.js|' });
  const bad = await runHook(run, 'echo broken >&2; exit 3', []);
  assert.equal(bad.code, 3);
  assert.match(bad.out, /broken/);
  const slow = await runHook(run, 'sleep 5', [], { timeout: 200 });
  assert.equal(slow.code, 124);
});

test('what the chat is told', () => {
  const t = failText('npm test', { code: 1, out: 'line\n'.repeat(100) + 'FAIL x' }, { tries: 2, retries: 2 });
  assert.match(t, /^\[Clearsky\] Your "before done" check `npm test` failed \(exit 1\)/);
  assert.match(t, /FAIL x\n```/);
  assert.match(t, /last time/);
  assert.equal(tail('a\nb\nc', 2), 'b\nc');
});
