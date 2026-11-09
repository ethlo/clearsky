// The map of a chat's work: every repo, ticket and environment it touched, and what the agent did
// to each (built, tested, reviewed, pushed, opened a PR, commented, moved a ticket…), from the
// agent log (lib/agent-log.mjs). A task that turns up a second repo or a new ticket shows it.

const GRAPHQL_ACTS = [
  [/^createPullRequest$/, 'opened a PR'], [/^mergePullRequest$/, 'merged a PR'], [/^updatePullRequest$/, 'edited a PR'],
  [/^(addPullRequestReviewThreadReply|addPullRequestReviewComment|addComment)$/, 'commented'],
  [/^(addPullRequestReview|submitPullRequestReview)$/, 'reviewed a PR'], [/^resolveReviewThread$/, 'resolved a thread'],
  [/^requestReviews$/, 'asked for review'], [/^(createIssue)$/, 'opened an issue'], [/^closePullRequest$/, 'closed a PR'],
  [/^deleteRef$/, 'deleted a branch'], [/^createRef$/, 'created a branch'],
];

// One log entry as { act, detail, pr } for the map, or null when it's not something done.
export function actOf(e) {
  const what = String(e.what || '');
  if (e.decided === 'declined') return { act: 'declined', detail: what };
  if (e.where === 'build') return { act: `${e.kind === 'test' ? 'tests' : 'build'} ${e.decided}`, detail: what };
  if (e.where === 'review') return { act: e.decided === 'reviewed' ? `self-review: ${e.verdict || 'no verdict'}` : 'self-review failed', detail: what };
  if (e.where === 'grafana') return e.decided === 'read' || e.decided === 'allowed' ? { act: 'read logs or metrics', detail: what } : null;
  // Other plugins' doors (`door slack …`): what they read.
  if (e.door) return e.decided === 'read' || e.decided === 'allowed' ? { act: `read ${e.where}`, detail: what } : null;
  if (e.where === 'jira') {
    const key = what.match(/--key\s+(\S+)/)?.[1] || null;
    if (/workitem transition/.test(what)) return { act: `moved to ${what.match(/--status\s+('([^']*)'|\S+)/)?.[2] || what.match(/--status\s+(\S+)/)?.[1] || 'a new status'}`, detail: what, key };
    if (/workitem comment/.test(what)) return { act: 'commented', detail: what, key };
    if (/workitem create/.test(what)) return { act: 'created a ticket', detail: what, key };
    if (/workitem (edit|assign)/.test(what)) return { act: /assign/.test(what) ? 'assigned' : 'edited', detail: what, key };
    if (/workitem link/.test(what)) return { act: 'linked tickets', detail: what, key };
    return { act: 'changed', detail: what, key };
  }
  // GitHub
  let m;
  if ((m = what.match(/^git push to \S+(?: \((.+)\))?/))) return { act: 'pushed', detail: m[1] || '' };
  if ((m = what.match(/^(create|move) (branch|tag) (\S+)/))) return { act: `${m[1] === 'create' ? 'created' : 'moved'} ${m[2]} ${m[3]}`, detail: '' };
  if ((m = what.match(/^GitHub change \((\w+)\)/))) {
    const hit = GRAPHQL_ACTS.find(([re]) => re.test(m[1]));
    return { act: hit ? hit[1] : m[1], detail: '' };
  }
  const [method, path = ''] = what.split(' ');
  const pr = path.match(/\/(?:pulls|issues)\/(\d+)/)?.[1] || null;
  const rest = (act) => ({ act, detail: '', ...(pr && { pr: Number(pr) }) });
  if (/\/pulls$/.test(path) && method === 'POST') return rest('opened a PR');
  if (/\/pulls\/\d+\/merge$/.test(path)) return rest('merged a PR');
  if (/\/pulls\/\d+\/requested_reviewers$/.test(path)) return rest('asked for review');
  if (/\/pulls\/\d+\/reviews/.test(path)) return rest('reviewed a PR');
  if (/\/(pulls|issues)\/\d+\/comments|\/comments\/\d+\/replies/.test(path)) return rest('commented');
  if (/\/pulls\/\d+$/.test(path) && method === 'PATCH') return rest('edited a PR');
  if (/\/issues\/\d+\/labels/.test(path)) return rest('labelled');
  if (/\/issues$/.test(path) && method === 'POST') return rest('opened an issue');
  if (/\/actions\/workflows\/[^/]+\/dispatches$|\/actions\/runs\/\d+\/rerun/.test(path)) return rest('started CI');
  if (/\/git\/refs\//.test(path) && method === 'DELETE') return rest('deleted a branch');
  return rest(`${method} ${path.split('/').slice(2).join('/') || path}`.trim());
}

const repoOf = (e) => (e.where === 'github' ? e.target : e.repo) || null;

// The chats in `writes` (newest first from readWrites) as { id, at, nodes }, each node one repo,
// ticket or environment with what was done to it, oldest act first. `scope(id)` adds what a
// chat was started on (repos, tickets) even before it did anything there.
export function buildMap(writes, { scope = () => ({}) } = {}) {
  const chats = new Map();
  for (const e of [...writes].reverse()) {
    const a = actOf(e);
    if (!a) continue;
    for (const c of e.chats || []) {
      if (!chats.has(c.id)) chats.set(c.id, { id: c.id, first: e.at, at: e.at, nodes: new Map(), shared: 0 });
      const ch = chats.get(c.id);
      ch.at = e.at;
      if ((e.chats || []).length > 1) ch.shared++;
      const targets = [];
      if (e.where === 'jira') {
        const keys = String(e.target || '').split(/,\s*/).filter((k) => /^[A-Z][A-Z0-9_]+-\d+$/.test(k));
        if (keys.length) targets.push(...keys.map((k) => ['ticket', k]));
        else if (e.target) targets.push(['project', e.target]);
      } else if (e.where === 'grafana') targets.push(['env', e.target || 'Grafana']);
      else if (e.door) targets.push(['env', e.where]);
      else if (repoOf(e)) targets.push(['repo', repoOf(e)]);
      else if (e.target) targets.push(['folder', e.target]);
      for (const [kind, key] of targets) {
        const id = `${kind}:${key}`;
        if (!ch.nodes.has(id)) ch.nodes.set(id, { kind, key, first: e.at, acts: [], prs: new Set(), branches: new Set() });
        const n = ch.nodes.get(id);
        n.acts.push({ at: e.at, act: a.act, detail: a.detail || '', decided: e.decided, ...(a.pr && { pr: a.pr }) });
        if (a.pr) n.prs.add(a.pr);
        for (const b of String(a.detail || '').split(/,\s*/)) if (a.act === 'pushed' && b) n.branches.add(b);
        const made = a.act.match(/^created branch (\S+)/)?.[1];
        if (made) n.branches.add(made);
      }
    }
  }
  for (const [id, ch] of chats) {
    const s = scope(id) || {};
    for (const [kind, keys] of [['repo', s.repos || []], ['ticket', s.tickets || []]]) {
      for (const k of keys) {
        const id = `${kind}:${k}`;
        if (ch.nodes.has(id)) ch.nodes.get(id).scope = true;
        else ch.nodes.set(id, { kind, key: k, first: null, acts: [], prs: new Set(), branches: new Set(), scope: true });
      }
    }
  }
  // What it was started on first, then what it found, each in the order it was first touched.
  const order = (a, b) => (!!b.scope - !!a.scope) || (a.first == null) - (b.first == null) || String(a.first).localeCompare(String(b.first));
  return [...chats.values()].sort((a, b) => (a.at < b.at ? 1 : -1)).map((ch) => ({
    id: ch.id, first: ch.first, at: ch.at, shared: ch.shared,
    nodes: [...ch.nodes.values()].map((n) => ({ ...n, prs: [...n.prs], branches: [...n.branches] }))
      .sort(order),
  }));
}

// What a shell step is, when it's a build or tests: 'test', 'build' or null.
const TOOLS = /(^|[\s;&|(])(\.\/mvnw|mvn|\.\/gradlew|gradle|npm|pnpm|yarn|node --test|pytest|go|cargo|make|dotnet|tsc|jest|vitest|bazel|sbt)(\s|$)/;
export function buildKind(command = '') {
  const c = String(command).replace(/^vm\s+/, '');
  if (!TOOLS.test(c)) return null;
  if (/^(npm|pnpm|yarn)\b/.test(c.trim()) && !/\b(test|build|ci|run|verify|check|lint)\b/.test(c)) return null; // installs, versions
  if (/^go\b/.test(c.trim()) && !/\bgo (test|build|vet)\b/.test(c)) return null;
  if (/^make\b/.test(c.trim()) && /\bmake\s*$/.test(c)) return 'build';
  return /\b(test|tests|verify|check|pytest|jest|vitest|--test)\b/.test(c) ? 'test' : 'build';
}
