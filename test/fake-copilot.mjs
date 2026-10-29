#!/usr/bin/env node
// Stand-in for the GitHub Copilot CLI in tests: lists skills, answers one-shot prompts by
// echoing what it was asked, and speaks a little Agent Client Protocol with --acp.
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
const out = (o) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...o })}\n`);

if (args[0] === 'skill' && args[1] === 'list') {
  process.stdout.write('Personal skills:\n  standup - Write my stand-up\n\nBuiltin skills:\n  github-pr-media - Add media to PRs\n');
} else if (args.includes('--acp') && args.includes('--assisted-approval')) {
  // Like the real CLI 1.0.105: the judge only works in one-shot runs.
  process.stderr.write('--assisted-approval is only supported in non-interactive prompt mode or direct workflow mode.\n');
  process.exit(1);
} else if (args.includes('--acp')) {
  let waiting = null;
  // FAKE_COPILOT_IDS=random gives each new chat its own id (for trying several chats by hand).
  let sid = 'acp-session-1';
  createInterface({ input: process.stdin }).on('line', (line) => {
    const m = JSON.parse(line);
    const upd = (sessionId, update) => out({ method: 'session/update', params: { sessionId, update } });
    if (m.method === 'initialize') out({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { list: {} } } } });
    else if (m.method === 'session/list') {
      out({ id: m.id, result: m.params.cursor
        ? { sessions: [{ sessionId: 'personal-1', cwd: '/tmp/me', title: 'Personal hack', updatedAt: new Date().toISOString() }, { sessionId: 'cli-old-session', cwd: '/tmp', title: 'From the terminal', updatedAt: '2026-10-01T10:00:00Z' }] }
        : { sessions: [{ sessionId: 'acp-session-1', cwd: '/tmp/work', title: 'Check the repo', updatedAt: new Date(Date.now() - 36e5).toISOString() }], nextCursor: 'p2' } });
    } else if (m.method === 'session/load') {
      if (m.params.sessionId.startsWith('sess-')) { sid = m.params.sessionId; out({ id: m.id, result: {} }); return; }
      if (m.params.sessionId !== 'cli-old-session') { out({ id: m.id, error: { code: -32002, message: 'no such session' } }); return; }
      upd(m.params.sessionId, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'You are helping me with my work. This is my work dashboard right now:\n\nstuff\n\n---\nMy message:\nWhat broke?' } });
      upd(m.params.sessionId, { sessionUpdate: 'tool_call', toolCallId: 'x', title: 'Read log', status: 'pending' });
      upd(m.params.sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'x', status: 'completed' });
      upd(m.params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'The build ' } });
      upd(m.params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'broke.' } });
      out({ id: m.id, result: {} });
    }
    else if (m.method === 'session/new') {
      if (process.env.FAKE_COPILOT_IDS === 'random') sid = `acp-${Math.random().toString(16).slice(2, 10)}`;
      out({ id: m.id, result: { sessionId: sid } });
      upd(sid, { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'standup', description: 'Write my stand-up' }, { name: 'review', description: 'Review changes', input: { hint: 'what' } }] });
    }
    else if (m.method === 'session/prompt') {
      const say = (text) => out({ method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
      const flags = args.filter((a, i) => a.startsWith('--') || ['shell', 'write', 'plan'].includes(a) && args[i - 1]?.startsWith('--'));
      say(`flags=${args.filter((a) => a.startsWith('--')).join(' ')} `);
      say(`info=${JSON.stringify({ prompt: m.params.prompt[0].text, flags, session: sid, model: args.includes('--model') ? args[args.indexOf('--model') + 1] : null, hasToken: !!process.env.GITHUB_TOKEN })}\n`);
      // Allowed tools run without asking, except a prompt that says "gated" (like a step Copilot's judge wants you to OK).
      if (args.includes('--allow-all-tools') && !m.params.prompt[0].text.includes('gated')) { out({ id: m.id, result: { stopReason: 'end_turn' } }); return; }
      out({ method: 'session/update', params: { update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'git status', kind: 'execute', status: 'pending' } } });
      waiting = { prompt: m.id, say };
      out({ id: 900, method: 'session/request_permission', params: { sessionId: sid, toolCall: { toolCallId: 't1', title: 'Run git status', kind: m.params.prompt[0].text.includes('just read') ? 'read' : 'execute', rawInput: { command: m.params.prompt[0].text.includes('just look') ? 'git status' : 'git push' } },
        options: [{ optionId: 'yes', name: 'Allow once', kind: 'allow_once' }, { optionId: 'no', name: 'Deny', kind: 'reject_once' }] } });
    } else if (m.id === 900 && waiting) {
      out({ method: 'session/update', params: { update: { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' } } });
      waiting.say(`answer=${m.result.outcome.optionId || m.result.outcome.outcome}`);
      out({ id: waiting.prompt, result: { stopReason: 'end_turn' } });
      waiting = null;
    }
  });
} else {
  const prompt = args[args.indexOf('-p') + 1];
  const flags = args.filter((a, i) => a.startsWith('--') || ['shell', 'write', 'plan'].includes(a) && args[i - 1]?.startsWith('--'));
  process.stdout.write('Hello ');
  setTimeout(() => {
    process.stdout.write(JSON.stringify({ prompt, flags, session: args[args.indexOf('--session-id') + 1] || null,
      resume: args.includes('--resume') ? args[args.indexOf('--resume') + 1] : false,
      model: args.includes('--model') ? args[args.indexOf('--model') + 1] : null, hasToken: !!process.env.GITHUB_TOKEN }));
  }, 50);
}
