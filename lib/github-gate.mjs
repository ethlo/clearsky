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
    graphqlBodies.set(req, body);
    const ops = [];
    for (const b of Array.isArray(body) ? body : [body]) {
      const found = operations(String(b?.query || ''));
      if (!found) return unreadable;
      ops.push(...found);
    }
    // Every change in the request is named: one mutation can hold several (and so can a batch).
    const changes = graphqlChanges(ops);
    return changes.length ? `GitHub change (${changes.join(', ')})` : null;
  }
  // A branch or tag made or moved through the API: say which.
  if (/^\/repos\/[\w.-]+\/[\w.-]+\/git\/refs(\/|$)/.test(u.pathname) && (m === 'POST' || m === 'PATCH')) {
    let ref = u.pathname.split('/git/refs/')[1] ? `refs/${decodeURIComponent(u.pathname.split('/git/refs/')[1])}` : '';
    try { ref = JSON.parse(await (req.clone?.() || req).text() || '{}').ref || ref; } catch {}
    const kind = ref.startsWith('refs/tags/') ? 'tag' : ref.startsWith('refs/heads/') ? 'branch' : null;
    if (kind) return `${m === 'POST' ? 'create' : 'move'} ${kind} ${ref.replace(/^refs\/(heads|tags)\//, '')} in ${repo}`;
  }
  return `${m} ${u.pathname.replace(/^\/repos\//, '')}`.trim();
}

// The operations in a GraphQL document: [{kind: 'query'|'mutation'|'subscription', field, fields, spread}].
// `fields` are all the fields the operation asks for at its top level (each one is a change of its
// own in a mutation; `field` is the first). `spread`: it also takes fields from a fragment
// (`...F`, `... on Mutation {…}`), which this doesn't follow. Fragment definitions are skipped (gh
// puts them first in its read queries). null when it can't be read.
export function operations(doc) {
  const src = doc.replace(/"""[\s\S]*?"""|"(?:[^"\\\n]|\\.)*"/g, '""').replace(/#[^\n]*/g, '');
  const ops = [];
  let depth = 0, parens = 0, head = '', cur = null, sel = '';
  const close = () => {
    if (!cur) return;
    const text = sel.replace(/@\w+/g, ' ');
    cur.spread = text.includes('...');
    // `alias: field` counts as its field; a spread's own words (`...F`, `... on Type`) aren't fields.
    cur.fields = [...text.replace(/\.\.\.\s*(on\s+)?\w*/g, ' ').matchAll(/(\w+)\s*(:)?/g)].filter((m) => !m[2]).map((m) => m[1]);
    cur.field = cur.fields[0] || '';
  };
  for (const ch of src) {
    // Arguments and variable definitions: their braces are input objects, not selections.
    if (ch === '(') { parens++; continue; }
    if (ch === ')') { if (--parens < 0) return null; continue; }
    if (parens) continue;
    if (ch === '{') {
      if (depth === 0) {
        const h = head.trim();
        const kind = h === '' ? 'query' : (h.match(/^(query|mutation|subscription|fragment)\b/) || [])[1];
        if (!kind) return null;
        cur = kind === 'fragment' ? null : { kind, field: '', fields: [], spread: false };
        if (cur) ops.push(cur);
        head = ''; sel = '';
      } else if (depth === 1) sel += ' ';
      depth++;
    } else if (ch === '}') {
      if (--depth < 0) return null;
      if (depth === 0) close();
    } else if (depth === 0) head += ch;
    else if (depth === 1) sel += ch;
  }
  if (depth !== 0 || parens !== 0 || head.trim() || !ops.length) return null;
  return ops;
}

// The changes a GraphQL document makes, by name: every top-level field of every mutation (or
// subscription). A mutation that takes its fields from a fragment can't be told: 'fragment'.
export function graphqlChanges(ops) {
  return ops.filter((o) => o.kind !== 'query').flatMap((o) => [...(o.fields.length ? o.fields : o.spread ? [] : [o.kind]), ...(o.spread ? ['fragment'] : [])]);
}

// srt 0.0.79 crashes the process when a denied request's body was never read (its tee keeps
// writing to the cancelled branch), so read it before saying no.
const deny = async (req, reason) => {
  if (req.body && !req.bodyUsed) await req.arrayBuffer().catch(() => {});
  return { action: 'deny', reason };
};

// GitHub node ids a GraphQL change names (a repo, a PR, a review thread…): the request doesn't
// say which repo it's for, but those ids do, when looked up (see bin/clearsky.mjs). They come in
// two shapes: today's (R_kgDO…, PR_kwDO…) and the older base64 ones (MDEwOlJlcG9zaXRvcnkx…) that
// GitHub still hands out for repos and PRs made before 2021, which gh then sends back as it got
// them. So ids are taken from where GraphQL puts them (`id`, `…Id`, `…Ids`, in the variables or
// written into the query) as well as by today's prefixes. The target comes first: a repo, PR or
// issue before what's attached to it, and a fork's headRepositoryId last.
const graphqlBodies = new WeakMap();
const ID_KEY = /^(id|\w+Ids?)$/;
const NOT_A_PLACE = /^(clientMutation|user|team|actor|bot|assignee|reviewer|project|label|milestone|org|organization|owner|enterprise|emoji)/i;
const LOOKS_LIKE_ID = /^[\w+/=-]{8,120}$/;
const NEW_ID = /\b(?:PR|PRR|PRRT|PRRC|R|I|IC)_[\w-]{6,}\b/g;
export function graphqlNodeIds(body) {
  const first = [], later = [], last = [];
  const keep = (key, v) => {
    if (typeof v !== 'string' || !LOOKS_LIKE_ID.test(v) || NOT_A_PLACE.test(key)) return;
    (/^headRepositoryId$/.test(key) ? last : first).push(v);
  };
  const walk = (v, depth = 0) => {
    if (depth > 8 || !v || typeof v !== 'object') return;
    for (const [k, x] of Object.entries(v)) {
      if (ID_KEY.test(k)) for (const one of Array.isArray(x) ? x : [x]) keep(k, one);
      if (x && typeof x === 'object') walk(x, depth + 1);
    }
  };
  for (const b of Array.isArray(body) ? body : [body]) {
    walk(b?.variables);
    // Written into the query: input: {pullRequestId: "PR_…", labelIds: ["…"]}
    for (const m of String(b?.query || '').matchAll(/\b(id|\w+Ids?)\s*:\s*(\[[^\]]*\]|"[^"]*")/g)) {
      for (const q of m[2].matchAll(/"([^"]*)"/g)) keep(m[1], q[1]);
    }
  }
  for (const m of JSON.stringify(body).matchAll(NEW_ID)) later.push(m[0]);
  return [...new Set([...first, ...later.filter((id) => !last.includes(id)), ...last])].slice(0, 8);
}

// A repo a GraphQL change names outright: createCommitOnBranch's branch {repositoryNameWithOwner}.
export function graphqlRepo(body) {
  const m = JSON.stringify(body).match(/\\?"repositoryNameWithOwner\\?"\s*:\s*\\?"([\w.-]+\/[\w.-]+)\\?"/);
  return m ? m[1].toLowerCase() : null;
}

// Looking those ids up (as you, read only): the repo each one is in. Ids GitHub doesn't know
// come back as null with an error beside them; the others still count.
export const NODES_REPO_QUERY = `query($ids: [ID!]!) { nodes(ids: $ids) { __typename ... on Repository { nameWithOwner }
  ... on PullRequest { repository { nameWithOwner } } ... on Issue { repository { nameWithOwner } }
  ... on PullRequestReview { repository { nameWithOwner } } ... on PullRequestReviewComment { repository { nameWithOwner } }
  ... on PullRequestReviewThread { pullRequest { repository { nameWithOwner } } } ... on IssueComment { repository { nameWithOwner } }
  ... on Ref { repository { nameWithOwner } } ... on Commit { repository { nameWithOwner } } ... on Discussion { repository { nameWithOwner } } } }`;
export function repoFromNodes(data) {
  for (const n of data?.nodes || []) {
    const r = n?.nameWithOwner || n?.repository?.nameWithOwner || n?.pullRequest?.repository?.nameWithOwner;
    if (r) return r.toLowerCase();
  }
  return null;
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

const RISKY_MUTATION = /^(merge|delete|archive|unarchive|transfer|enqueue|dequeue|dismiss|approve|reject|enablePullRequestAutoMerge|createRepository|updateRepository|cloneTemplateRepository|updateRef$|updateRefs$|.*(Protection|Ruleset|Collaborator|Member|Secret|Variable|DeployKey|Webhook|Environment|Deployment|Permission|Visibility).*)/i;
const RISKY_PATH = /^\/repos\/[\w.-]+\/[\w.-]+\/(pulls\/\d+\/merge|merges|collaborators|hooks|keys|branches\/[^/]+\/(protection|rename)|rulesets|actions\/(secrets|variables|permissions|runners|oidc)|environments|transfer|invitations|pages|deployments|releases|git\/tags|dependabot|codespaces|teams|topics|vulnerability-alerts|automated-security-fixes)(\/|$)/;

// Everyday work on a branch, PR or issue. In the chat's repos these go through without asking;
// any other change asks. GitHub has hundreds of calls and gains more, so the list is of what's
// routine, not of what's risky: a call nobody thought of asks instead of slipping through.
export const EVERYDAY_MUTATIONS = new Set(['addComment', 'updateIssueComment', 'createIssue', 'updateIssue', 'closeIssue', 'reopenIssue',
  'createPullRequest', 'updatePullRequest', 'closePullRequest', 'reopenPullRequest', 'markPullRequestReadyForReview', 'convertPullRequestToDraft',
  'updatePullRequestBranch', 'revertPullRequest', 'disablePullRequestAutoMerge', 'requestReviews', 'addPullRequestReview', 'submitPullRequestReview',
  'updatePullRequestReview', 'addPullRequestReviewComment', 'updatePullRequestReviewComment', 'addPullRequestReviewThread',
  'addPullRequestReviewThreadReply', 'resolveReviewThread', 'unresolveReviewThread', 'markFileAsViewed', 'unmarkFileAsViewed',
  'addLabelsToLabelable', 'removeLabelsFromLabelable', 'clearLabelsFromLabelable', 'createLabel', 'updateLabel',
  'addAssigneesToAssignable', 'removeAssigneesFromAssignable', 'replaceActorsForAssignable', 'updateIssueIssueType',
  'addSubIssue', 'removeSubIssue', 'reprioritizeSubIssue', 'addReaction', 'removeReaction', 'minimizeComment', 'unminimizeComment',
  'lockLockable', 'unlockLockable', 'pinIssue', 'unpinIssue', 'updateSubscription', 'createRef', 'createCommitOnBranch', 'createLinkedBranch',
  'addProjectV2ItemById', 'addProjectV2DraftIssue', 'updateProjectV2ItemFieldValue', 'clearProjectV2ItemFieldValue', 'updateProjectV2ItemPosition',
  'updateProjectV2DraftIssue', 'createDiscussion', 'updateDiscussion', 'addDiscussionComment', 'updateDiscussionComment']);
const EVERYDAY_PATH = /^\/repos\/[\w.-]+\/[\w.-]+\/(issues|pulls|comments|labels|milestones|git\/(blobs|trees|commits)|commits\/[^/]+\/comments|actions\/(runs\/\d+\/(rerun|rerun-failed-jobs|cancel|force-cancel)|jobs\/\d+\/rerun|workflows\/[^/]+\/dispatches)|check-(runs|suites)\/\d+\/rerequest|subscription|notifications)(\/|$)/;
export const NOT_EVERYDAY = 'not everyday work on a branch, PR or issue';
// In a PR: your approval, taking a review away, and a codespace (which costs) aren't everyday.
const APPROVES = 'approves a pull request';
const approving = (text) => /(^|[^A-Za-z_])APPROVE([^A-Za-z_]|$)/.test(text);
async function pullRisk(req, path, m) {
  if (/\/pulls\/\d+\/reviews\/\d+\/dismissals$/.test(path)) return 'dismisses a review';
  if (/\/pulls\/\d+\/codespaces$/.test(path)) return 'starts a codespace';
  if (/\/pulls\/\d+\/reviews(\/\d+\/events)?$/.test(path) && (m === 'POST' || m === 'PUT')) {
    let text;
    try { text = await (req.clone?.() || req).text(); JSON.parse(text || '{}'); } catch { return 'a review Clearsky couldn\'t read'; }
    if (approving(text)) return APPROVES;
  }
  return null;
}

// What a risky REST call does, in words.
const PATH_LABELS = [
  [/\/pulls\/\d+\/merge$|\/merges$/, 'merges into a branch'],
  [/\/releases(\/|$)/, 'makes or changes a release'],
  [/\/git\/tags(\/|$)/, 'creates a tag'],
  [/\/deployments(\/|$)|\/environments(\/|$)|\/pages(\/|$)/, 'deploys or changes deployment settings'],
  [/\/(collaborators|invitations|teams)(\/|$)/, 'changes who has access'],
  [/\/(hooks|keys)(\/|$)/, 'changes webhooks or deploy keys'],
  [/\/actions\/(secrets|variables)(\/|$)/, 'changes CI secrets or variables'],
  [/\/actions\/(runners|oidc|permissions)(\/|$)/, 'changes how CI runs'],
  [/\/branches\/[^/]+\/rename$/, 'renames a branch'],
  [/\/branches\/[^/]+\/protection|\/rulesets(\/|$)/, 'changes branch protection'],
  [/\/transfer$/, 'transfers the repo'],
];
function riskyPathLabel(path) {
  return PATH_LABELS.find(([re]) => re.test(path))?.[1] || 'changes repo settings';
}
// Other calls in a repo that aren't everyday, and are worth their own words.
const OTHER_LABELS = [
  [/\/statuses\/[^/]+$|\/check-(runs|suites)(\/\d+)?$/, 'sets a check result on a commit'],
  [/\/actions\/runs\/\d+\/(pending_deployments|deployment_protection_rule|approve)$/, 'approves a CI run or deployment that waits for an OK'],
  [/\/actions\/workflows\/[^/]+\/(enable|disable)$/, 'turns a workflow on or off'],
  [/\/dispatches$/, 'starts workflows with its own input'],
  [/\/(forks|generate)$/, 'makes a new repo from this one'],
  [/\/(code-scanning|secret-scanning|security-advisories)(\/|$)/, 'changes security alerts'],
];

// Whether a ref's changes (against the default branch) touch CI's workflows: a build run by
// hand gets the repo's secrets, and changed workflows are how those would leak.
// Only workflows and the repo's own actions run in CI; other files under .github don't.
async function touchesWorkflows(look, repo, ref) {
  const base = await look.defaultBranch(repo);
  const cmp = await look.compare(repo, base, ref);
  return (cmp.files || []).map((f) => f.filename || '').filter((f) => /^\.github\/(workflows|actions)\//.test(f));
}

// GraphQL's own ways to make a branch or tag (createRef) and to commit to a branch without git
// (createCommitOnBranch), told like the push they are: a tag or a shared branch asks, unless the
// shared branch has GitHub's protection on (then GitHub decides).
async function graphqlRefRisk(field, body, look) {
  const text = JSON.stringify(body ?? null);
  const str = (key) => (text.match(new RegExp(`(?:^|[^\\w])(?:\\\\?")?${key}(?:\\\\?")?\\s*:\\s*\\\\?"([^"\\\\]+)`)) || [])[1] || null;
  if (field === 'createRef') {
    const ref = str('name');
    if (!ref) return 'a branch or tag change Clearsky couldn\'t read';
    const name = ref.replace(/^refs\/(heads|tags)\//, '');
    if (ref.startsWith('refs/tags/')) return `creates tag ${name}`;
    if (!ref.startsWith('refs/heads/')) return `changes ${ref}`;
    return SHARED_BRANCH.test(name) ? `creates ${name}` : null;
  }
  const name = str('branchName')?.replace(/^refs\/heads\//, '');
  if (!name) return 'a commit Clearsky couldn\'t place';
  if (!SHARED_BRANCH.test(name)) return null;
  const repo = body ? graphqlRepo(body) : null;
  return repo && await look?.protected?.(repo, name).catch(() => false) ? null : `pushes to ${name}`;
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
      const files = await touchesWorkflows(look, runRepo, ref);
      const name = (f) => f.replace(/^\.github\//, '');
      return files.length ? `a one-off CI run of ${String(ref).slice(0, 60)}, whose branch changes the workflows: ${files.slice(0, 3).map(name).join(', ')}${files.length > 3 ? ` and ${files.length - 3} more` : ''}` : null;
    } catch { return 'a CI run Clearsky couldn\'t check'; }
  }
  const fields = (what.match(/^GitHub change \(([\w, ]+)\)$/) || [])[1]?.split(', ');
  if (fields) {
    // Several changes in one request: each is judged, and what's left still asks, since the
    // repo check below it (bin/clearsky.mjs, githubScope) places a request by one target only.
    const bad = fields.find((f) => RISKY_MUTATION.test(f));
    if (bad) return bad;
    if (fields.some((f) => ['fragment', 'mutation', 'subscription'].includes(f))) return 'a change Clearsky couldn\'t read';
    if (fields.length > 1) return `${fields.length} changes in one request`;
    const [field] = fields;
    if (field === 'createRef' || field === 'createCommitOnBranch') return graphqlRefRisk(field, graphqlBodies.get(req), look);
    // Your approval is what lets a PR merge: `gh pr review --approve` asks.
    if ((field === 'addPullRequestReview' || field === 'submitPullRequestReview') && approving(JSON.stringify(graphqlBodies.get(req) ?? ''))) return APPROVES;
    return EVERYDAY_MUTATIONS.has(field) ? null : `${field}: ${NOT_EVERYDAY}`;
  }
  if (what.startsWith('a GitHub GraphQL request')) return 'a request Clearsky couldn\'t read';
  if (u.hostname === 'github.com') return 'a change on github.com outside git';
  // Branches and tags made through the API (gh api …/git/refs), told like the push they are.
  const refPath = u.pathname.match(/^\/repos\/[\w.-]+\/[\w.-]+\/git\/refs(?:\/(.+))?$/);
  if (refPath) {
    let body = {};
    if (m === 'POST' || m === 'PATCH') { try { body = JSON.parse(await (req.clone?.() || req).text() || '{}'); } catch { return 'a branch or tag change Clearsky couldn\'t read'; } }
    const ref = String(m === 'POST' ? body.ref || '' : `refs/${decodeURIComponent(refPath[1] || '')}`);
    const name = ref.replace(/^refs\/(heads|tags)\//, '');
    const tag = ref.startsWith('refs/tags/'), branch = ref.startsWith('refs/heads/');
    if (m === 'DELETE') return tag ? `deletes tag ${name}` : branch ? `deletes branch ${name}` : `deletes ${ref}`;
    if (tag) return m === 'POST' ? `creates tag ${name}` : `moves tag ${name}`;
    if (!branch) return `changes ${ref || 'a ref'}`;
    if (m === 'PATCH' && body.force) return `force-moves ${name}`;
    // A new branch, or a branch moved forward (GitHub refuses a move that drops commits without
    // force): everyday work, unless it's a shared branch.
    if (SHARED_BRANCH.test(name)) return m === 'POST' ? `creates ${name}` : `pushes to ${name}`;
    return null;
  }
  if (m === 'DELETE') return 'deletes something';
  // A file committed through the API (gh api …/contents/…) is a push to its branch: the default
  // branch when it names none. Told like the push it is.
  const contents = u.pathname.match(/^\/repos\/([\w.-]+\/[\w.-]+)\/contents\//);
  if (contents && m === 'PUT') {
    let body;
    try { body = JSON.parse(await (req.clone?.() || req).text() || '{}'); } catch { return 'a commit Clearsky couldn\'t read'; }
    const name = String(body.branch || await look?.defaultBranch?.(contents[1]).catch(() => '') || '');
    if (!name) return 'a commit Clearsky couldn\'t place';
    if (body.branch && !SHARED_BRANCH.test(name)) return null;
    return await look?.protected?.(contents[1], name).catch(() => false) ? null : `pushes to ${name}`;
  }
  if (u.pathname.startsWith('/repos/')) {
    if (/^\/repos\/[\w.-]+\/[\w.-]+\/?$/.test(u.pathname)) return 'repo settings';
    if (RISKY_PATH.test(u.pathname)) return riskyPathLabel(u.pathname);
    if (EVERYDAY_PATH.test(u.pathname)) return pullRisk(req, u.pathname, m);
    return OTHER_LABELS.find(([re]) => re.test(u.pathname))?.[1] || NOT_EVERYDAY;
  }
  if (/^\/markdown(\/raw)?$/.test(u.pathname)) return null; // renders text, changes nothing
  // Uploading release assets, gists, your profile, orgs…: not a branch or PR's work.
  return 'outside a repo\'s branches and PRs';
}

// Docker Hub: pulls only. A push (with a login Copilot was handed somewhere) would carry your
// code out; the proxy reads these hosts' HTTPS (lib/sandbox.mjs, `inspect`) so it sees one.
export const REGISTRY_HOSTS = ['registry-1.docker.io', 'index.docker.io', 'auth.docker.io'];
// Where GitHub Actions serves CI logs and artifacts from (a download is a redirect there; seen up
// to number 32, so 0–99). Read
// only, like Docker Hub: a write to Azure storage would be a way out for your code.
export const GITHUB_LOG_HOSTS = Array.from({ length: 100 }, (_, i) => `productionresultssa${i}.blob.core.windows.net`);
export const READONLY_HOSTS = [...REGISTRY_HOSTS, ...GITHUB_LOG_HOSTS];
export function readOnlyWrite(req) {
  const u = new URL(req.url);
  if (GITHUB_LOG_HOSTS.includes(u.hostname.toLowerCase()) && !READ_METHODS.has(req.method.toUpperCase())) return `${req.method.toUpperCase()} ${u.hostname}${u.pathname}`;
  return registryWrite(req);
}
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
    const push = readOnlyWrite(req);
    if (push) return deny(req, `${/docker\.io/.test(push) ? 'Docker Hub' : 'GitHub\'s CI log storage'} is read only from Clearsky's sandbox and VMs (${push}).`);
    let what = await githubWrite(req);
    if (!what) return { action: 'allow' };
    if (what.startsWith('Copilot\'s GitHub tools')) return deny(req, 'Copilot\'s built-in GitHub tools are off in Clearsky\'s sandbox; use git and gh.');
    const body = graphqlBodies.get(req);
    const repo = writeRepo(req) || (what.match(/^git push to (\S+)/) || [])[1] || (body && graphqlRepo(body)) || null;
    const info = { repo, nodes: body ? graphqlNodeIds(body) : [] };
    const fetchRefs = what.startsWith('git push') && req.method.toUpperCase() !== 'POST'; // the ref list; the push comes next
    // Which branches a push is for, in what's told and logged (the chat's map).
    let branches = [];
    if (what.startsWith('git push') && !fetchRefs) {
      try { branches = pushedRefs(Buffer.from(await req.clone().arrayBuffer())).map((r) => r.ref.replace(/^refs\/heads\//, '')); } catch { /* told without them */ }
    }
    const why = fetchRefs ? null : await risky(req, what, look) || await scope(info);
    if (branches.length) what = `${what} (${branches.join(', ')})`;
    if (!why) { if (!fetchRefs) told(what, info); return { action: 'allow' }; }
    const ok = await ask(`${what} (${why})`, { ...info, why });
    return ok ? { action: 'allow' } : deny(req, `The user declined: ${what}. Ask them what to do instead.`);
  };
}
