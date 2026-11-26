import { test } from 'node:test';
import assert from 'node:assert/strict';
import { logChats } from '../lib/app/chat-gate.mjs';

const chat = (id, repos) => ({ id, repos: new Set(), known: { at: Date.now(), repos: new Set(repos) } });

test('gate log: a change is a chat\'s only when it is the one chat, on that repo', () => {
  const a = chat('a', ['acme/api']), b = chat('b', ['other/web']);
  assert.deepEqual(logChats([a], 'acme/api'), { chats: [{ id: 'a' }] });
  assert.deepEqual(logChats([a], 'ACME/API'), { chats: [{ id: 'a' }] });
  // The only working chat, but the push went to a repo it isn't on: some other chat's (a job, a late request).
  assert.deepEqual(logChats([b], 'acme/api'), { chats: [{ id: 'b' }], unsure: true });
  assert.deepEqual(logChats([a, b], 'acme/api'), { chats: [{ id: 'a' }, { id: 'b' }], unsure: true });
  assert.deepEqual(logChats([a]), { chats: [{ id: 'a' }] });
  assert.deepEqual(logChats([]), { chats: [], unsure: true });
});
