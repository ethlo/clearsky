// What the sandbox may do on GitHub, judged at srt's proxy (so however a command is written):
// reading and the everyday work of a branch and its PR, in the repo the chat works on, go through
// (and show as a line in the chat and in the agent's log); other repos, and what is hard to undo
// or reaches past your branch, wait for your OK: pushing to a main
// or release branch, deleting a branch or tag, pushing tags, merging, deleting anything, and
// repo or org settings. The sandbox never holds your GitHub login: srt adds it on the way out
// (lib/sandbox.mjs).

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

// The repo a REST write goes to (api.github.com/repos/<owner>/<repo>/…).
export function writeRepo(req) {
  const u = new URL(req.url);
  return u.hostname === 'api.github.com' ? (u.pathname.match(/^\/repos\/([\w.-]+\/[\w.-]+)\//) || [])[1] || null : null;
}

// Branches whose history others build on: a push there asks, unless GitHub's branch protection
// is on for it (then GitHub decides). Your feature branches are the sandbox's to push.
export const SHARED_BRANCH = /^(main|master|develop|development|trunk|production|prod|release[/-].*|hotfix[/-].*|v?\d+(\.\d+)*(\.x)?)$/i;
const ZERO = /^0{40}$/;

// The refs a push updates, from the start of git's receive-pack request (pkt-lines).
export function pushedRefs(buf) {
  const refs = [];
  let i = 0;
  while (i + 4 <= buf.length) {
    const n = parseInt(buf.subarray(i, i + 4).toString('latin1'), 16);
    if (!Number.isFinite(n) || n === 0) break;
    const line = buf.subarray(i + 4, i + n).toString('latin1').split('\0')[0].trim();
    const [oldSha, newSha, ref] = line.split(' ');
    if (!ref) break;
    refs.push({ ref, old: oldSha, new: newSha, create: ZERO.test(oldSha), remove: ZERO.test(newSha) });
    i += n;
  }
  return refs;
}

const RISKY_MUTATION = /^(merge|delete|archive|unarchive|transfer|enablePullRequestAutoMerge|createRepository|updateRepository|cloneTemplateRepository|updateRef$|updateRefs$|.*(Protection|Ruleset|Collaborator|Member|Secret|Variable|DeployKey|Webhook|Environment|Permission|Visibility).*)/i;
const RISKY_PATH = /^\/repos\/[\w.-]+\/[\w.-]+\/(pulls\/\d+\/merge|merges|collaborators|hooks|keys|branches\/[^/]+\/(protection|rename)|rulesets|actions\/(secrets|variables|permissions)|environments|transfer|invitations|pages|deployments|releases|git\/refs|git\/tags|dependabot|codespaces|teams|topics|vulnerability-alerts|automated-security-fixes)(\/|$)/;

// Whether a ref's changes (against the default branch) touch CI's workflows: a build run by
// hand gets the repo's secrets, and changed workflows are how those would leak.
async function touchesWorkflows(look, repo, ref) {
  const base = await look.defaultBranch(repo);
  const cmp = await look.compare(repo, base, ref);
  return (cmp.files || []).some((f) => f.filename?.startsWith('.github/'));
}

// Why a write needs your OK, or null when it's everyday work on a branch or PR. `look` reads
// GitHub as you (bin/clearsky.mjs): to tell a force push and to see what a CI run would build.
export async function risky(req, what, look = null) {
  const u = new URL(req.url), m = req.method.toUpperCase();
  if (what.startsWith('git push')) {
    if (m !== 'POST') return null; // the ref list; the push itself comes next
    let buf;
    try { buf = Buffer.from(await req.arrayBuffer()); } catch { return 'a push Clearsky couldn\'t read'; }
    const refs = pushedRefs(buf);
    if (!refs.length) return 'a push Clearsky couldn\'t read';
    for (const r of refs) {
      const name = r.ref.replace(/^refs\/heads\//, '');
      if (r.remove) return `deletes ${name}`;
      if (!r.ref.startsWith('refs/heads/')) return `pushes ${r.ref.replace(/^refs\//, '')}`;
    }
    const repo = (what.match(/^git push to (\S+)/) || [])[1];
    // A shared branch with GitHub's protection on (all changes via PRs) is GitHub's to refuse.
    for (const r of refs) {
      const name = r.ref.replace(/^refs\/heads\//, '');
      if (SHARED_BRANCH.test(name) && !await look?.protected?.(repo, name).catch(() => false)) return `pushes to ${name}`;
    }
    for (const r of refs.filter((x) => !x.create)) {
      // A push that drops commits (a force push) shows as "diverged" or "behind" old → new.
      // The new commits aren't on GitHub until this push lands, so ask the clone they come from
      // first (look.fastForward: true, false, or null when no clone here has them).
      const ff = await look.fastForward?.(repo, r.old, r.new).catch(() => null);
      if (ff === false) return `force-pushes ${r.ref.replace(/^refs\/heads\//, '')}`;
      if (ff === true) continue;
      try { if (['diverged', 'behind'].includes((await look.compare(repo, r.old, r.new)).status)) return `force-pushes ${r.ref.replace(/^refs\/heads\//, '')}`; }
      catch { return `a push to ${r.ref.replace(/^refs\/heads\//, '')} Clearsky couldn't check`; }
    }
    return null;
  }
  // Starting CI by hand: fine, unless the branch changes the workflows (they'd run with secrets).
  const runRepo = writeRepo(req);
  const dispatch = /\/actions\/workflows\/[^/]+\/dispatches$/.test(u.pathname), rerun = u.pathname.match(/\/actions\/runs\/(\d+)\/rerun/);
  if (runRepo && (dispatch || rerun)) {
    try {
      const ref = dispatch ? JSON.parse(await req.text()).ref : (await look.run(runRepo, rerun[1])).head_sha;
      return await touchesWorkflows(look, runRepo, ref) ? 'runs CI on a branch that changes its workflows' : null;
    } catch { return 'a CI run Clearsky couldn\'t check'; }
  }
  const field = (what.match(/^GitHub change \((\w+)\)$/) || [])[1];
  if (field) return RISKY_MUTATION.test(field) ? field : null;
  if (what.startsWith('a GitHub GraphQL request')) return 'a request Clearsky couldn\'t read';
  if (u.hostname === 'github.com') return 'a change on github.com outside git';
  if (m === 'DELETE') return 'deletes something';
  if (u.pathname.startsWith('/repos/')) {
    if (/^\/repos\/[\w.-]+\/[\w.-]+\/?$/.test(u.pathname)) return 'repo settings';
    return RISKY_PATH.test(u.pathname) ? 'merges, releases or changes repo settings' : null;
  }
  // Uploading release assets, gists, your profile, orgs…: not a branch or PR's work.
  return 'outside a repo\'s branches and PRs';
}

// Docker Hub: pulls only. A push (with a login Copilot was handed somewhere) would carry your
// code out; the proxy reads these hosts' HTTPS (lib/sandbox.mjs, `inspect`) so it sees one.
export const REGISTRY_HOSTS = ['registry-1.docker.io', 'index.docker.io', 'auth.docker.io'];
export function registryWrite(req) {
  const u = new URL(req.url);
  if (!REGISTRY_HOSTS.includes(u.hostname.toLowerCase())) return null;
  if (!READ_METHODS.has(req.method.toUpperCase())) return `${req.method.toUpperCase()} ${u.hostname}${u.pathname}`;
  // A login for pushing starts with a token asking for push.
  if (u.hostname === 'auth.docker.io' && u.searchParams.getAll('scope').some((s) => /:(\*|[\w,]*push[\w,]*)$/.test(s))) return 'a Docker Hub login for pushing';
  return null;
}

// srt's filterRequest. Everyday writes go through and `told(what, { repo, nodes })` shows them
// in the chat; risky ones wait for `ask(what, { repo, nodes, why })` (true or false). `scope(info)`
// says why a write is outside the repos the working chats are on (null when it's in one): those
// ask too. Anything that throws denies: srt fails closed.
export function githubFilter(ask, { told = () => {}, look = null, scope = async () => null } = {}) {
  return async (req) => {
    const push = registryWrite(req);
    if (push) return deny(req, `Docker Hub is read only from Clearsky's sandbox and VMs (${push}).`);
    const what = await githubWrite(req);
    if (!what) return { action: 'allow' };
    if (what.startsWith('Copilot\'s GitHub tools')) return deny(req, 'Copilot\'s built-in GitHub tools are off in Clearsky\'s sandbox; use git and gh.');
    const repo = writeRepo(req) || (what.match(/^git push to (\S+)/) || [])[1] || null;
    const info = { repo, nodes: nodeIds.get(req) || [] };
    const fetchRefs = what.startsWith('git push') && req.method.toUpperCase() !== 'POST'; // the ref list; the push comes next
    const why = fetchRefs ? null : await risky(req, what, look) || await scope(info);
    if (!why) { if (!fetchRefs) told(what, info); return { action: 'allow' }; }
    const ok = await ask(`${what} (${why})`, { ...info, why });
    return ok ? { action: 'allow' } : deny(req, `The user declined: ${what}. Ask them what to do instead.`);
  };
}
