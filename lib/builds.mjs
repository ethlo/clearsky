// Builds: for each repo you work in, how its main branch (the repo's default branch, main or
// master) builds now, and the newest thing it produced: the latest Actions artifact built from
// that branch, and the latest release or tag. Read only, through your GitHub login.

// One GraphQL query for all the repos, an alias each.
export function buildQuery(repos) {
  const one = (r, i) => `r${i}: repository(owner: ${JSON.stringify(r.split('/')[0])}, name: ${JSON.stringify(r.split('/')[1])}) {
    nameWithOwner url
    defaultBranchRef { name target { ... on Commit {
      oid abbreviatedOid committedDate messageHeadline url author { user { login } name }
      statusCheckRollup { state contexts(first: 50) { nodes { __typename
        ... on CheckRun { name conclusion status detailsUrl completedAt }
        ... on StatusContext { context state targetUrl createdAt } } } } } } }
    latestRelease { tagName name publishedAt url }
    refs(refPrefix: "refs/tags/", first: 1, orderBy: { field: TAG_COMMIT_DATE, direction: DESC }) { nodes { name } }
  }`;
  return `query { ${repos.map(one).join('\n')} }`;
}

const BAD = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);

// What a repo's main branch looks like, from its GraphQL node and its Actions artifacts
// (GET /repos/{repo}/actions/artifacts). `state`: passing, failing, running or none.
export function buildOf(node, artifacts = []) {
  const branch = node.defaultBranchRef?.name || null;
  const c = node.defaultBranchRef?.target || {};
  const roll = c.statusCheckRollup;
  const checks = (roll?.contexts?.nodes || []).map((x) => (x.__typename === 'CheckRun'
    ? { name: x.name, state: x.status !== 'COMPLETED' ? 'running' : BAD.has(x.conclusion) ? 'failing' : 'passing', url: x.detailsUrl }
    : { name: x.context, state: x.state === 'PENDING' || x.state === 'EXPECTED' ? 'running' : BAD.has(x.state) ? 'failing' : 'passing', url: x.targetUrl }));
  const state = !roll ? 'none' : BAD.has(roll.state) ? 'failing' : roll.state === 'SUCCESS' ? 'passing' : 'running';
  const failed = checks.find((x) => x.state === 'failing'), running = checks.find((x) => x.state === 'running');
  const art = artifacts.filter((a) => !a.expired && (!branch || a.workflow_run?.head_branch === branch))
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
  const tag = node.refs?.nodes?.[0]?.name || null;
  return {
    repo: node.nameWithOwner, url: node.url, branch, state,
    commit: c.oid ? { sha: c.abbreviatedOid, at: c.committedDate, title: c.messageHeadline, url: c.url, by: c.author?.user?.login || c.author?.name || null } : null,
    // The check to look at: the failing one, else the one still running, else any.
    check: failed || running || checks[0] || null,
    checks: checks.length,
    artifact: art ? { name: art.name, at: art.created_at, size: art.size_in_bytes,
      url: art.workflow_run?.id ? `${node.url}/actions/runs/${art.workflow_run.id}` : `${node.url}/actions`, sha: (art.workflow_run?.head_sha || '').slice(0, 7) || null } : null,
    release: node.latestRelease ? { tag: node.latestRelease.tagName, name: node.latestRelease.name, at: node.latestRelease.publishedAt, url: node.latestRelease.url } : null,
    tag,
  };
}

// The repos to show: the ones you named (Settings → GitHub), else the ones your PRs and review
// requests are in, most used first.
export function buildRepos(named, github, max = 10) {
  const list = String(named || '').split(/[\s,]+/).filter((r) => /^[\w.-]+\/[\w.-]+$/.test(r));
  if (list.length) return [...new Set(list)].slice(0, 20);
  const count = new Map();
  for (const p of [...(github?.myPrs || []), ...(github?.reviewRequested || [])]) if (p.repo) count.set(p.repo, (count.get(p.repo) || 0) + 1);
  return [...count].sort((a, b) => b[1] - a[1]).map(([r]) => r).slice(0, max);
}
