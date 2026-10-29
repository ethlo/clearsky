#!/usr/bin/env node
// Stand-in for the GitHub Copilot CLI in tests: lists skills, answers one-shot prompts by
// echoing what it was asked, and speaks a little Agent Client Protocol with --acp.
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
const out = (o) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...o })}\n`);

if (args[0] === 'skill' && args[1] === 'list') {
  process.stdout.write('Personal skills:\n  standup - Write my stand-up\n\nBuiltin skills:\n  github-pr-media - Add media to PRs\n');
} else if (args.includes('--acp')) {
  let waiting = null;
  createInterface({ input: process.stdin }).on('line', (line) => {
    const m = JSON.parse(line);
    if (m.method === 'initialize') out({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: false } } });
    else if (m.method === 'session/new') out({ id: m.id, result: { sessionId: 'acp-session-1' } });
    else if (m.method === 'session/prompt') {
      const say = (text) => out({ method: 'session/update', params: { sessionId: 'acp-session-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
      say(`flags=${args.filter((a) => a.startsWith('--')).join(' ')} `);
      out({ method: 'session/update', params: { update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'git status', kind: 'execute', status: 'pending' } } });
      waiting = { prompt: m.id, say };
      out({ id: 900, method: 'session/request_permission', params: { sessionId: 'acp-session-1', toolCall: { toolCallId: 't1', title: 'Run git status', rawInput: { command: 'git status' } },
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
