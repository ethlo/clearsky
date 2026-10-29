// A minimal Agent Client Protocol client: JSON-RPC 2.0, one message per line over the
// agent's stdin/stdout. Used for Copilot's "Ask" mode, where the agent asks before each
// tool call and the answer comes from buttons in the chat panel.

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export class AcpAgent {
  constructor(bin, args, { env, onExit } = {}) {
    this.child = spawn(bin, [...args, '--acp'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = '';
    this.onUpdate = () => {};
    this.onPermission = async () => ({ outcome: 'cancelled' });
    this.closed = false;
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; } // not protocol output
      this.#handle(msg);
    });
    this.child.stderr.on('data', (d) => { this.stderr = (this.stderr + d).slice(-4000); });
    const fail = (why) => {
      this.closed = true;
      for (const { reject } of this.pending.values()) reject(new Error(why));
      this.pending.clear();
      onExit?.();
    };
    this.child.on('error', (e) => fail(e.message));
    this.child.on('close', (code) => fail(`Copilot stopped (exit ${code})${this.stderr ? `: ${this.stderr.trim().split('\n').slice(-3).join(' ')}` : ''}`));
  }

  #send(msg) {
    if (!this.closed) this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error('Copilot is not running'));
      this.pending.set(id, { resolve, reject });
      this.#send({ id, method, params });
    });
  }

  #handle(msg) {
    if (msg.id != null && !msg.method) { // a reply to one of our requests
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) p?.reject(new Error(msg.error.message || 'Copilot error'));
      else p?.resolve(msg.result);
      return;
    }
    if (msg.method === 'session/update') return this.onUpdate(msg.params?.update || {});
    if (msg.method === 'session/request_permission' && msg.id != null) {
      Promise.resolve(this.onPermission(msg.params || {}))
        .then((outcome) => this.#send({ id: msg.id, result: { outcome } }))
        .catch(() => this.#send({ id: msg.id, result: { outcome: { outcome: 'cancelled' } } }));
      return;
    }
    // We don't offer file or terminal access to the agent; it uses its own tools.
    if (msg.id != null) this.#send({ id: msg.id, error: { code: -32601, message: `${msg.method} is not supported` } });
  }

  async start(cwd, resumeId) {
    const init = await this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    if (resumeId && init?.agentCapabilities?.loadSession) {
      try {
        await this.request('session/load', { sessionId: resumeId, cwd, mcpServers: [] });
        this.sessionId = resumeId;
        return this.sessionId;
      } catch { /* start fresh below */ }
    }
    this.sessionId = (await this.request('session/new', { cwd, mcpServers: [] })).sessionId;
    return this.sessionId;
  }

  prompt(text) {
    return this.request('session/prompt', { sessionId: this.sessionId, prompt: [{ type: 'text', text }] });
  }

  cancel() {
    this.#send({ method: 'session/cancel', params: { sessionId: this.sessionId } });
  }

  close() {
    this.closed = true;
    this.child.kill('SIGTERM');
  }
}

// Turn an ACP session update into the small events the chat panel understands.
export function chatEvent(u) {
  const text = (c) => (c?.type === 'text' ? c.text : '');
  switch (u.sessionUpdate) {
    case 'agent_message_chunk': return { type: 'text', text: text(u.content) };
    case 'tool_call':
    case 'tool_call_update':
      return { type: 'tool', id: u.toolCallId, title: u.title || undefined, kind: u.kind || undefined, status: u.status || undefined };
    default: return null;
  }
}
