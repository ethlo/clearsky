#!/usr/bin/env node
// Stand-in for the Copilot CLI in Clearsky's demo: a few past sessions and one that reads like
// real work, replayed when you open it. It speaks just enough Agent Client Protocol. With no
// arguments it is Claude Code's ACP adapter instead (CLEARSKY_DEMO_AGENT=claude).
import { createInterface } from 'node:readline';
import { CHAT, SESSIONS, plan } from './chat.mjs';

const args = process.argv.slice(2);
const out = (o) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...o })}\n`);
if (args[0] === 'skill' && args[1] === 'list') {
  process.stdout.write('Personal skills:\n  continue-work - Check status and continue\n  feature-delivery - Build a ticket from branch to PR\n  propose-solution - Find the best fix\n  review-my-queue - Draft my reviews\n  standup - Write my stand-up\n  triage-my-work - Plan my day\n');
} else if (args.includes('--acp') || !args.length) {
  let sid = 'demo-new';
  createInterface({ input: process.stdin }).on('line', (line) => {
    const m = JSON.parse(line);
    const upd = (sessionId, update) => out({ method: 'session/update', params: { sessionId, update } });
    if (m.method === 'initialize') out({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { list: {} }, promptCapabilities: { image: true } } } });
    else if (m.method === 'session/list') out({ id: m.id, result: { sessions: args.length ? SESSIONS : [] } }); // as Claude Code: no past sessions
    else if (m.method === 'session/load') {
      sid = m.params.sessionId;
      if (sid === CHAT.id) for (const u of CHAT.updates) upd(sid, u);
      out({ id: m.id, result: {} });
    } else if (m.method === 'session/new') out({ id: m.id, result: { sessionId: sid } });
    else if (m.method === 'session/prompt' && /\bplan\b/i.test(m.params.prompt.find((b) => b.type === 'text')?.text || '')) {
      // Asked for a plan: act one out slowly, so it can be watched (DEMO_PLAN_MS a step).
      const steps = ['Find where the ledger export splits amounts', 'Write a failing test for the lost cent', 'Fix the split', 'Run the tests'], ms = Number(process.env.DEMO_PLAN_MS) || 6000;
      const s = sid, id = m.id;
      steps.forEach((_, i) => setTimeout(() => {
        upd(s, plan(i, steps));
        upd(s, { sessionUpdate: 'tool_call', toolCallId: `p${i}`, title: ['rg -n "split" src/main/java/com/acme/ledger', 'Edit src/test/java/com/acme/ledger/CsvExportTest.java', 'Edit src/main/java/com/acme/ledger/CsvExport.java', './mvnw -q test -pl ledger'][i], kind: i === 0 || i === 3 ? 'execute' : 'edit', status: 'pending' });
        setTimeout(() => upd(s, { sessionUpdate: 'tool_call_update', toolCallId: `p${i}`, status: 'completed' }), ms / 2);
      }, i * ms));
      setTimeout(() => { upd(s, plan(steps.length, steps)); upd(s, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done: the export keeps every cent now (demo).' } }); out({ id, result: { stopReason: 'end_turn' } }); }, steps.length * ms);
    } else if (m.method === 'session/prompt') {
      upd(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `This is a demo: nothing runs here.${(n => n ? ` (I got ${n === 1 ? 'your image' : `your ${n} images`}.)` : '')(m.params.prompt.filter((b) => b.type === 'image').length)}` } });
      out({ id: m.id, result: { stopReason: 'end_turn' } });
    } else if (m.id != null) out({ id: m.id, result: {} }); // session/set_mode and the like
  });
} else {
  process.stdout.write('This is a demo: nothing runs here.');
}
