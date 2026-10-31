import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { logWrite, readWrites } from '../lib/agent-log.mjs';
import { jiraTargets, remoteRepo } from '../bin/clearsky.mjs';

test('every write Copilot makes as you is kept, newest first, per chat', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'alog-')), 'sub', 'agent-writes.jsonl');
  logWrite(file, { where: 'github', what: 'POST repos/acme/api/pulls', target: 'acme/api', chats: [{ id: 'c1' }], decided: 'auto' }, new Date('2026-01-01T10:00:00Z'));
  logWrite(file, { where: 'jira', what: 'acli jira workitem transition --key ABC-1', target: 'ABC-1', chats: [{ id: 'c2' }], decided: 'allowed' }, new Date('2026-01-01T11:00:00Z'));
  assert.deepEqual(readWrites(file).map((e) => e.where), ['jira', 'github']);
  assert.deepEqual(readWrites(file, { chat: 'c1' }).map((e) => [e.at, e.target]), [['2026-01-01T10:00:00.000Z', 'acme/api']]);
  assert.deepEqual(readWrites(join(file, 'missing')), []);
});

test('which Jira tickets and projects an acli command changes', () => {
  assert.deepEqual(jiraTargets(['jira', 'workitem', 'transition', '--key', 'ABC-1,ABC-2', '--status', 'Done']), { keys: ['ABC-1', 'ABC-2'], projects: ['ABC'], bulk: false });
  assert.deepEqual(jiraTargets(['jira', 'workitem', 'create', '--project=OPS', '--summary', 'x']), { keys: [], projects: ['OPS'], bulk: false });
  assert.equal(jiraTargets(['jira', 'workitem', 'edit', '--jql', 'project = ABC', '--assignee', 'x']).bulk, true);
  assert.deepEqual(jiraTargets(['jira', 'workitem', 'comment', 'create', '--key', 'ABC-1', '--body', 'see XYZ-9']).projects, ['ABC']);
});

test('the repo of a git remote, however the GitHub host is written', () => {
  assert.equal(remoteRepo('git@github.com:Acme/API.git'), 'acme/api');
  assert.equal(remoteRepo('git@github.com-work:acme/api.git'), 'acme/api');
  assert.equal(remoteRepo('https://github.com/acme/api'), 'acme/api');
  assert.equal(remoteRepo('ssh://git@github.com/acme/api.git/'), 'acme/api');
  assert.equal(remoteRepo('git@gitlab.example.com:acme/api.git'), null);
});
