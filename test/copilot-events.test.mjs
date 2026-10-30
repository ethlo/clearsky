import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commandAction, parseEvents } from '../lib/copilot-events.mjs';

test("Copilot's own steps, from its session log", () => {
  assert.deepEqual(commandAction('cd ~/dev/abc && git push -u origin ABC-1'), { text: 'pushed' });
  assert.deepEqual(commandAction('gh pr edit 12 --add-reviewer anna,bob'), { text: 'asked anna, bob to review' });
  assert.deepEqual(commandAction('acli jira workitem transition --key ABC-6519 --status "Code Review" --yes'), { text: 'moved ABC-6519 to Code Review', key: 'issue:ABC-6519' });
  assert.equal(commandAction('git status && gh pr view 12'), null);

  const ev = (o) => JSON.stringify(o);
  const log = [
    ev({ type: 'session.start', timestamp: '2026-10-29T10:00:00Z', data: { context: { branch: 'main' } } }),
    ev({ type: 'tool.execution_start', timestamp: '2026-10-29T10:05:00Z', data: { toolCallId: 'a', toolName: 'bash', arguments: { command: 'git push' } } }),
    ev({ type: 'tool.execution_complete', timestamp: '2026-10-29T10:05:03Z', data: { toolCallId: 'a', success: true, shellExecution: { exitCode: 0 } } }),
    ev({ type: 'tool.execution_start', timestamp: '2026-10-29T10:06:00Z', data: { toolCallId: 'b', toolName: 'bash', arguments: { command: 'gh pr merge 12' } } }),
    ev({ type: 'tool.execution_complete', timestamp: '2026-10-29T10:06:01Z', data: { toolCallId: 'b', success: false, error: { code: 'denied' } } }),
    ev({ type: 'session.resume', timestamp: '2026-10-29T11:00:00Z', data: { context: { branch: 'feature/ABC-1-x' } } }),
    'not json',
  ].join('\n');
  const r = parseEvents(log);
  assert.deepEqual(r.branches, ['main', 'feature/ABC-1-x'], 'every branch it started or resumed on');
  assert.deepEqual(r.actions, [{ text: 'pushed', at: '2026-10-29T10:05:03Z' }], 'only steps that succeeded');
});
