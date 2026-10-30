// What the sandbox may do on GitHub, judged at srt's proxy (so however a command is written):
// reading goes through; a push, an API write or a GraphQL mutation waits for your OK in the
// chat. The sandbox never holds your GitHub login: srt adds it on the way out (lib/sandbox.mjs).

export const GITHUB_HOSTS = ['github.com', 'api.github.com', 'uploads.github.com'];
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// What a request is, for the question you're asked; null when it only reads.
export async function githubWrite(req) {
  const u = new URL(req.url);
  const host = u.hostname.toLowerCase();
  const m = req.method.toUpperCase();
  // Copilot's own GitHub tools (its MCP server) can change things: off in the sandbox.
  if (/(^|\.)githubcopilot\.com$/.test(host)) return /^\/mcp(\/|$)/.test(u.pathname) ? 'Copilot\'s GitHub tools' : null;
  if (!GITHUB_HOSTS.includes(host)) return null;
  const repo = u.pathname.replace(/^\/repos\//, '/').split('/').slice(1, 3).join('/').replace(/\.git$/, '');
  if (host === 'github.com') {
    if (u.searchParams.get('service') === 'git-receive-pack' || /\/git-receive-pack$/.test(u.pathname)) return `git push to ${repo}`;
    if (READ_METHODS.has(m) || /\/git-upload-pack$/.test(u.pathname)) return null; // fetch, clone, pages
    return `${m} github.com${u.pathname}`;
  }
  if (READ_METHODS.has(m)) return null;
  if (host === 'api.github.com' && /^\/copilot_internal\//.test(u.pathname)) return null; // Copilot's own sign-in
  if (host === 'api.github.com' && u.pathname === '/graphql' && m === 'POST') {
    const unreadable = 'a GitHub GraphQL request Clearsky couldn\'t read';
    let body;
    try { body = JSON.parse(await req.text()); } catch { return unreadable; }
    const ops = [];
    for (const b of Array.isArray(body) ? body : [body]) {
      const found = operations(String(b?.query || ''));
      if (!found) return unreadable;
      ops.push(...found);
    }
    const change = ops.find((o) => o.kind !== 'query');
    return change ? `GitHub change (${change.field || change.kind})` : null;
  }
  return `${m} ${u.pathname.replace(/^\/repos\//, '')}`.trim();
}

// The operations in a GraphQL document: [{kind: 'query'|'mutation'|'subscription', field}].
// Fragments are skipped (gh puts them first in its read queries). null when it can't be read.
export function operations(doc) {
  const src = doc.replace(/"""[\s\S]*?"""|"(?:[^"\\\n]|\\.)*"/g, '""').replace(/#[^\n]*/g, '');
  const ops = [];
  let depth = 0, head = '', cur = null, field = '';
  for (const ch of src) {
    if (ch === '{') {
      if (depth === 0) {
        const h = head.replace(/\([^)]*\)/g, '').trim();
        const kind = h === '' ? 'query' : (h.match(/^(query|mutation|subscription|fragment)\b/) || [])[1];
        if (!kind) return null;
        cur = kind === 'fragment' ? null : { kind, field: '' };
        if (cur) ops.push(cur);
        head = '';
      } else if (depth === 1 && cur && !cur.field) cur.field = (field.match(/(\w+)\s*(\(|$)/) || [])[1] || '';
      depth++; field = '';
    } else if (ch === '}') {
      if (--depth < 0) return null;
      field = '';
    } else if (depth === 0) head += ch;
    else if (depth === 1) field += ch;
  }
  if (depth !== 0 || head.trim() || !ops.length) return null;
  return ops;
}

// srt's filterRequest: reads pass; a write asks (`ask(what)` resolves true or false). A push is
// two requests (the ref list, then the pack), so one OK lets the same repo's push through for
// two minutes. Anything that throws denies: srt fails closed.
// srt 0.0.79 crashes the process when a denied request's body was never read (its tee keeps
// writing to the cancelled branch), so read it before saying no.
const deny = async (req, reason) => {
  if (req.body && !req.bodyUsed) await req.arrayBuffer().catch(() => {});
  return { action: 'deny', reason };
};

export function githubFilter(ask, { now = Date.now } = {}) {
  const granted = new Map();
  return async (req) => {
    const what = await githubWrite(req);
    if (!what) return { action: 'allow' };
    for (const [k, t] of granted) if (now() - t > 120_000) granted.delete(k);
    if (granted.has(what)) return { action: 'allow' };
    if (what.startsWith('Copilot\'s GitHub tools')) return deny(req, 'Copilot\'s built-in GitHub tools are off in Clearsky\'s sandbox; use git and gh, which ask the user for changes.');
    const ok = await ask(what);
    if (ok && what.startsWith('git push')) granted.set(what, now());
    return ok ? { action: 'allow' } : deny(req, `The user declined: ${what}. Ask them what to do instead.`);
  };
}
