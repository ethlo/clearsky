// A minimal Agent Client Protocol client: JSON-RPC 2.0, one message per line over the
// agent's stdin/stdout. Used for Copilot's "Ask" mode, where the agent asks before each
// tool call and the answer comes from buttons in the chat panel.

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export class AcpAgent {
  // `acp: false` when args already end in --acp (a sandbox wraps the whole command).
  constructor(bin, args, { env, onExit, acp = true } = {}) {
    this.child = spawn(bin, acp ? [...args, '--acp'] : args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
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
    if (msg.method === 'session/update') {
      const u = msg.params?.update || {};
      if (u.sessionUpdate === 'available_commands_update') {
        this.commands = (u.availableCommands || []).map((c) => ({ name: c.name, description: c.description || '', hint: c.input?.hint || '' }));
      }
      return this.onUpdate(u);
    }
    if (msg.method === 'session/request_permission' && msg.id != null) {
      Promise.resolve(this.onPermission(msg.params || {}))
        .then((outcome) => this.#send({ id: msg.id, result: { outcome } }))
        .catch(() => this.#send({ id: msg.id, result: { outcome: { outcome: 'cancelled' } } }));
      return;
    }
    // We don't offer file or terminal access to the agent; it uses its own tools.
    if (msg.id != null) this.#send({ id: msg.id, error: { code: -32601, message: `${msg.method} is not supported` } });
  }

  async initialize() {
    this.init ||= await this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    return this.init;
  }

  async start(cwd, resumeId) {
    const init = await this.initialize();
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

  // Every Copilot session on this machine, wherever it was started (CLI, IDE, Clearsky).
  async listSessions({ cwd, max = 500 } = {}) {
    const init = await this.initialize();
    if (!init?.agentCapabilities?.sessionCapabilities?.list) throw new Error('this Copilot version can’t list sessions; update the Copilot CLI');
    const all = [];
    let cursor;
    do {
      const r = await this.request('session/list', { ...(cwd ? { cwd } : {}), ...(cursor ? { cursor } : {}) });
      all.push(...(r?.sessions || []));
      cursor = r?.nextCursor;
    } while (cursor && all.length < max);
    return all;
  }

  // Load a session and collect the conversation Copilot replays while loading it.
  async history(sessionId, cwd) {
    const init = await this.initialize();
    if (!init?.agentCapabilities?.loadSession) throw new Error('this Copilot version can’t reopen sessions; update the Copilot CLI');
    const messages = [];
    this.onUpdate = (u) => {
      const last = messages.at(-1);
      if (u.sessionUpdate === 'user_message_chunk') {
        const text = u.content?.type === 'text' ? u.content.text : '';
        if (last?.role === 'me') last.text += text; else messages.push({ role: 'me', text });
        return;
      }
      const e = chatEvent(u);
      if (!e || (e.type === 'text' && !e.text)) return;
      const segs = last?.role === 'cp' ? last.segs : (messages.push({ role: 'cp', segs: [] }), messages.at(-1).segs);
      const prev = segs.at(-1);
      if (e.type === 'text') { if (prev?.type === 'text') prev.text += e.text; else segs.push(e); return; }
      const t = segs.find((g) => g.type === 'tool' && g.id === e.id);
      if (t) Object.assign(t, Object.fromEntries(Object.entries(e).filter(([, v]) => v != null))); else segs.push(e);
    };
    await this.request('session/load', { sessionId, cwd, mcpServers: [] });
    this.onUpdate = () => {};
    return messages;
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
