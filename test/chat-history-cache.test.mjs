// Switching chats: a conversation already read comes from memory until its log on disk changes,
// and two opens at once read it once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copilotHistory, historyStamp, forgetHistories } from '../lib/app/chat-sessions.mjs';

test('a chat is read once until its stamp changes', async () => {
  forgetHistories();
  let reads = 0;
  const load = async () => { reads++; return [{ role: 'me', text: `hi ${reads}` }]; };
  const a = await copilotHistory(null, 'chat-aaaa', '/w', { stamp: 's1', load });
  assert.equal(a.read, true);
  const b = await copilotHistory(null, 'chat-aaaa', '/w', { stamp: 's1', load });
  assert.equal(b.read, false);
  assert.equal(b.messages[0].text, 'hi 1');
  assert.equal(reads, 1);
  const c = await copilotHistory(null, 'chat-aaaa', '/w', { stamp: 's2', load });
  assert.equal(c.read, true);
  assert.equal(c.messages[0].text, 'hi 2');
  // Another folder is another read; no stamp is never kept.
  await copilotHistory(null, 'chat-aaaa', '/other', { stamp: 's2', load });
  await copilotHistory(null, 'chat-aaaa', '/w', { stamp: null, load });
  await copilotHistory(null, 'chat-aaaa', '/w', { stamp: null, load });
  assert.equal(reads, 5);
});

test('two opens at once start the agent once', async () => {
  forgetHistories();
  let reads = 0;
  const load = () => new Promise((r) => setTimeout(() => r([{ role: 'cp', segs: [{ type: 'text', text: String(++reads) }] }]), 20));
  const [x, y] = await Promise.all([1, 2].map(() => copilotHistory(null, 'chat-bbbb', '', { stamp: 's', load })));
  assert.equal(reads, 1);
  assert.deepEqual(x.messages, y.messages);
});

test('a failed read is not kept', async () => {
  forgetHistories();
  await assert.rejects(copilotHistory(null, 'chat-cccc', '', { stamp: 's', load: async () => { throw new Error('no'); } }));
  const ok = await copilotHistory(null, 'chat-cccc', '', { stamp: 's', load: async () => [] });
  assert.equal(ok.read, true);
});

test('the stamp follows the agent’s log', () => {
  const home = mkdtempSync(join(tmpdir(), 'cs-hist-'));
  const cpHome = join(home, '.copilot');
  mkdirSync(join(cpHome, 'session-state', 'cp-11111111'), { recursive: true });
  const log = join(cpHome, 'session-state', 'cp-11111111', 'events.jsonl');
  writeFileSync(log, '{}\n');
  const s1 = historyStamp('cp-11111111', 'copilot', { home, cpHome });
  assert.ok(s1);
  appendFileSync(log, '{}\n');
  utimesSync(log, new Date(), new Date(Date.now() + 5000));
  assert.notEqual(historyStamp('cp-11111111', 'copilot', { home, cpHome }), s1);
  assert.equal(historyStamp('cp-missing', 'copilot', { home, cpHome }), null);
  // Claude Code: projects/<folder>/<id>.jsonl, whichever folder it is in.
  const prev = process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CLAUDE_CONFIG_DIR;
  mkdirSync(join(home, '.claude', 'projects', '-home-me-dev-x'), { recursive: true });
  writeFileSync(join(home, '.claude', 'projects', '-home-me-dev-x', 'cl-22222222.jsonl'), '{}\n');
  assert.ok(historyStamp('cl-22222222', 'claude', { home, cpHome }));
  if (prev != null) process.env.CLAUDE_CONFIG_DIR = prev;
});
