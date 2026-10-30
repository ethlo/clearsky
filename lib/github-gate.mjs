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
    nodeIds.set(req, graphqlNodeIds(body));
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

// GitHub node ids a GraphQL change names (a PR, a review thread, a repo…): the request doesn't
// say which repo it's for, but those ids do, when looked up (see bin/clearsky.mjs).
const nodeIds = new WeakMap();
export function graphqlNodeIds(body) {
  const ids = new Set();
  for (const m of JSON.stringify(body).matchAll(/\b(?:PR|PRR|PRRT|PRRC|R|I|IC)_[\w-]{6,}\b/g)) ids.add(m[0]);
  return [...ids].slice(0, 5);
}

// The repo a REST write goes to (api.github.com/repos/<owner>/<repo>/…), so you can allow a
// while of changes there with one click.
export function writeRepo(req) {
  const u = new URL(req.url);
  return u.hostname === 'api.github.com' ? (u.pathname.match(/^\/repos\/([\w.-]+\/[\w.-]+)\//) || [])[1] || null : null;
}
// Review work in GraphQL (gh pr review, resolving threads, replies): it doesn't say which repo,
// so a repo you allowed for a while covers these too.
export const REVIEW_MUTATIONS = new Set(['addPullRequestReviewThreadReply', 'addPullRequestReviewComment', 'addPullRequestReview', 'submitPullRequestReview',
  'resolveReviewThread', 'unresolveReviewThread', 'requestReviews', 'addComment', 'updatePullRequest', 'markPullRequestReadyForReview', 'addLabelsToLabelable']);
export const REPO_GRANT_MS = 15 * 6e4;

// `ask(what, { repo })` resolves false (no), true (this once) or 'repo' (changes on that repo,
// pushes aside, for 15 minutes).
export function githubFilter(ask, { now = Date.now } = {}) {
  const granted = new Map(), repos = new Map();
  return async (req) => {
    const what = await githubWrite(req);
    if (!what) return { action: 'allow' };
    for (const [k, t] of granted) if (now() - t > 120_000) granted.delete(k);
    for (const [k, t] of repos) if (now() > t) repos.delete(k);
    if (granted.has(what)) return { action: 'allow' };
    if (what.startsWith('Copilot\'s GitHub tools')) return deny(req, 'Copilot\'s built-in GitHub tools are off in Clearsky\'s sandbox; use git and gh, which ask the user for changes.');
    const push = what.startsWith('git push'), repo = push ? null : writeRepo(req);
    const review = REVIEW_MUTATIONS.has((what.match(/^GitHub change \((\w+)\)$/) || [])[1]);
    if ((repo && repos.has(repo)) || (review && repos.size)) return { action: 'allow' };
    const ok = await ask(what, { repo, nodes: nodeIds.get(req) || [] });
    if (ok === 'repo' && repo) repos.set(repo, now() + REPO_GRANT_MS);
    if (ok && push) granted.set(what, now());
    return ok ? { action: 'allow' } : deny(req, `The user declined: ${what}. Ask them what to do instead.`);
  };
}
