// A small MCP client over Streamable HTTP (JSON-RPC 2.0 by POST; the answer is JSON or an SSE
// stream), for any plugin (lent to plugins as `mcpClient`). Enough for initialize, tools/list
// and tools/call.

export const PROTOCOL = '2025-06-18';

// The JSON-RPC answer with `id` from an SSE body: `data:` lines, events split by blank lines.
export function fromSse(text, id) {
  for (const ev of text.split(/\r?\n\r?\n/)) {
    const data = ev.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
    if (!data) continue;
    try { const m = JSON.parse(data); if (m.id === id) return m; } catch { /* not ours */ }
  }
  return null;
}

// `token()` gives the current access token; `onAuth()` is called once on a 401 and gives a new
// one (or throws). Errors from a lost login have `auth: true`.
export function mcpClient({ url, token, onAuth = null, fetchImpl = fetch, clientInfo = { name: 'clearsky', version: '1' } }) {
  let session = null, ready = null, nextId = 1;

  async function post(msg, { retried = false } = {}) {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${await token()}` };
    if (session) headers['Mcp-Session-Id'] = session;
    if (msg.method !== 'initialize') headers['MCP-Protocol-Version'] = PROTOCOL;
    const res = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(msg) });
    if (res.status === 401 || res.status === 403) {
      if (onAuth && !retried) { await onAuth(); return post(msg, { retried: true }); }
      throw Object.assign(new Error(`${new URL(url).host} refused the login; log in again in Settings`), { auth: true });
    }
    // The server forgot the session: start a new one and send it again.
    if (res.status === 404 && session && msg.method !== 'initialize' && !retried) {
      session = null; ready = null;
      await init();
      return post(msg, { retried: true });
    }
    const sid = res.headers.get('mcp-session-id');
    if (sid) session = sid;
    if (msg.id == null) return null;
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} from ${new URL(url).host}`);
    const text = await res.text();
    const answer = /text\/event-stream/.test(res.headers.get('content-type') || '') ? fromSse(text, msg.id) : JSON.parse(text);
    if (!answer) throw new Error('no answer from the MCP server');
    if (answer.error) throw new Error(`MCP ${msg.method}: ${answer.error.message || answer.error.code}`);
    return answer.result;
  }
  const call = (method, params) => post({ jsonrpc: '2.0', id: nextId++, method, params });
  function init() {
    ready ||= (async () => {
      const r = await call('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo });
      await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
      return r;
    })().catch((e) => { ready = null; throw e; });
    return ready;
  }

  return {
    init,
    async tools() {
      await init();
      const out = [];
      let cursor;
      do {
        const r = await call('tools/list', cursor ? { cursor } : {});
        out.push(...(r?.tools || []));
        cursor = r?.nextCursor;
      } while (cursor && out.length < 500);
      return out;
    },
    async callTool(name, args = {}) {
      await init();
      return call('tools/call', { name, arguments: args });
    },
    reset() { session = null; ready = null; },
  };
}

// A tool result as text: its text parts, else its structured content as JSON.
export function resultText(r) {
  const text = (r?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  return text || (r?.structuredContent ? JSON.stringify(r.structuredContent, null, 2) : '');
}

// Read only: a tool the server marks read only, or one whose name only reads. Anything that
// sends, posts, creates, changes, reacts, uploads or drafts is left out, whatever it's marked.
const WRITES = /(^|_)(send|post|create|update|edit|delete|remove|add|set|schedule|draft|upload|complete|invite|kick|join|leave|archive|rename|react|pin|unpin|mark|write|share|open|close)(_|$)/i;
const READS = /(^|_)(search|read|get|list|find|lookup|view|fetch|history|info|profile|members|replies|emoji)(_|$)/i;
export function readOnly(tool) {
  const name = String(tool?.name || '');
  if (WRITES.test(name)) return false;
  const a = tool?.annotations || {};
  if (a.destructiveHint === true) return false;
  if (a.readOnlyHint === true) return true;
  if (a.readOnlyHint === false) return false;
  return READS.test(name);
}
