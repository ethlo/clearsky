#!/usr/bin/env node
// Stand-in for the Copilot CLI in Clearsky's demo: a few past sessions and one that reads like
// real work, replayed when you open it. It speaks just enough Agent Client Protocol.
import { createInterface } from 'node:readline';
import { CHAT, SESSIONS } from './chat.mjs';

const args = process.argv.slice(2);
const out = (o) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...o })}\n`);
if (args[0] === 'skill' && args[1] === 'list') {
  process.stdout.write('Personal skills:\n  continue-work - Check status and continue\n  propose-solution - Find the best fix\n  review-my-queue - Draft my reviews\n  standup - Write my stand-up\n  triage-my-work - Plan my day\n');
} else if (args.includes('--acp')) {
  let sid = 'demo-new';
  createInterface({ input: process.stdin }).on('line', (line) => {
    const m = JSON.parse(line);
    const upd = (sessionId, update) => out({ method: 'session/update', params: { sessionId, update } });
    if (m.method === 'initialize') out({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { list: {} } } } });
    else if (m.method === 'session/list') out({ id: m.id, result: { sessions: SESSIONS } });
    else if (m.method === 'session/load') {
      sid = m.params.sessionId;
      if (sid === CHAT.id) for (const u of CHAT.updates) upd(sid, u);
      out({ id: m.id, result: {} });
    } else if (m.method === 'session/new') out({ id: m.id, result: { sessionId: sid } });
    else if (m.method === 'session/prompt') {
      upd(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'This is a demo: nothing runs here.' } });
      out({ id: m.id, result: { stopReason: 'end_turn' } });
    }
  });
} else {
  process.stdout.write('This is a demo: nothing runs here.');
}
