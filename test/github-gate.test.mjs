import { test } from 'node:test';
import assert from 'node:assert/strict';
import { githubWrite, githubFilter, operations, graphqlChanges, risky, graphqlNodeIds, graphqlRepo, repoFromNodes, pushedRefs, GITHUB_LOG_HOSTS } from '../lib/github-gate.mjs';

const req = (method, url, body) => new Request(url, { method, body: body == null ? undefined : JSON.stringify(body) });

test('reads pass; pushes, API writes and GraphQL mutations are named', async () => {
  assert.equal(await githubWrite(req('GET', 'https://github.com/acme/api.git/info/refs?service=git-upload-pack')), null);
  assert.equal(await githubWrite(req('POST', 'https://github.com/acme/api.git/git-upload-pack', {})), null);
  assert.equal(await githubWrite(req('GET', 'https://github.com/acme/api.git/info/refs?service=git-receive-pack')), 'git push to acme/api');
  assert.equal(await githubWrite(req('POST', 'https://github.com/acme/api.git/git-receive-pack', {})), 'git push to acme/api');
  assert.equal(await githubWrite(req('GET', 'https://api.github.com/repos/acme/api/pulls')), null);
  assert.equal(await githubWrite(req('POST', 'https://api.github.com/repos/acme/api/pulls', {})), 'POST acme/api/pulls');
  assert.equal(await githubWrite(req('POST', 'https://api.github.com/graphql', { query: 'query { viewer { login } }' })), null);
  assert.equal(await githubWrite(req('POST', 'https://api.github.com/graphql', { query: '{ viewer { login } }' })), null);
  assert.equal(await githubWrite(req('POST', 'https://api.github.com/graphql', { query: '# hi\nmutation M { addComment(input: {}) { x } }' })), 'GitHub change (addComment)');
  assert.ok(await githubWrite(req('POST', 'https://api.github.com/graphql', 'not json')));
  assert.equal(await githubWrite(req('POST', 'https://api.github.com/copilot_internal/v2/token', {})), null);
  assert.equal(await githubWrite(req('POST', 'https://api.individual.githubcopilot.com/chat/completions', {})), null);
  assert.ok(await githubWrite(req('POST', 'https://api.githubcopilot.com/mcp/', {})));
  assert.equal(await githubWrite(req('POST', 'https://registry.npmjs.org/x', {})), null);
});

test('GraphQL: fragments and queries read, a mutation anywhere is a change', async () => {
  const gql = (query) => githubWrite(req('POST', 'https://api.github.com/graphql', Array.isArray(query) ? query.map((q) => ({ query: q })) : { query }));
  // The shape gh uses for `gh pr create`'s first look at the repo
  assert.equal(await gql('fragment repo on Repository { id name owner { login } }\nquery RepositoryInfo($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ...repo } }'), null);
  assert.equal(await gql('mutation PullRequestCreate($input: CreatePullRequestInput!) { createPullRequest(input: $input) { pullRequest { url } } }'), 'GitHub change (createPullRequest)');
  assert.equal(await gql('fragment f on User { login }\nmutation { addStar(input: {starrableId: "{"}) { clientMutationId } }'), 'GitHub change (addStar)');
  assert.equal(await gql('query Q { search(query: "is:open } {", type: ISSUE) { issueCount } }'), null);
  assert.equal(await gql(['{ viewer { login } }', 'mutation { deleteRef(input: {}) { x } }']), 'GitHub change (deleteRef)');
  assert.ok(await gql('query { viewer { login }'), 'unbalanced braces don\'t read as a query');
  assert.ok(await gql('nonsense { x }'));
  assert.ok(await gql(''));
});

test('a GraphQL change names its nodes, so Clearsky can find the repo (and the chat) it is for', async () => {
  assert.deepEqual(graphqlNodeIds({ query: 'mutation($t: ID!) { resolveReviewThread(input: {threadId: $t}) { thread { id } } }', variables: { t: 'PRRT_kwDOabc123' } }), ['PRRT_kwDOabc123']);
  assert.deepEqual(graphqlNodeIds({ query: 'mutation { createPullRequest(input: {repositoryId: "R_kgDOxyz789", title: "PR_ is not an id"}) { x } }' }), ['R_kgDOxyz789']);
  const seen = [];
  await githubFilter(async () => true, { told: (what, opts) => seen.push(opts.nodes) })(
    req('POST', 'https://api.github.com/graphql', { query: 'mutation { addComment(input: {subjectId: "PR_kwDOabc999", body: "x"}) { x } }' }));
  assert.deepEqual(seen, [['PR_kwDOabc999']]);
});

test('gh pr create on an older repo: its legacy id is found, the fork head comes last', () => {
  // gh sends the repo id as GitHub gave it: repos from before 2021 still have the base64 kind.
  const legacy = 'MDEwOlJlcG9zaXRvcnkxMjM0NTY3OA==';
  const create = { query: 'mutation PullRequestCreate($input: CreatePullRequestInput!) { createPullRequest(input: $input) { pullRequest { id url } } }',
    variables: { input: { headRepositoryId: 'R_kgDOfork001', repositoryId: legacy, baseRefName: 'main', headRefName: 'feature/abc-1', title: 'Fix R_kgDOnotanid1 in text', body: 'x', draft: false } } };
  assert.deepEqual(graphqlNodeIds(create), [legacy, 'R_kgDOnotanid1', 'R_kgDOfork001']);
  // gh's follow-ups: reviewers and labels on the new PR; people and labels aren't where it goes.
  assert.deepEqual(graphqlNodeIds({ query: 'mutation($input: RequestReviewsInput!) { requestReviews(input: $input) { clientMutationId } }',
    variables: { input: { pullRequestId: 'MDExOlB1bGxSZXF1ZXN0OTg3NjU0', userIds: ['MDQ6VXNlcjEyMzQ1'], union: true } } }), ['MDExOlB1bGxSZXF1ZXN0OTg3NjU0']);
  assert.deepEqual(graphqlNodeIds({ query: 'mutation { updateIssue(input: {id: "MDU6SXNzdWUxMjM0NQ==", labelIds: ["LA_kwDOlabel1"]}) { x } }' }), ['MDU6SXNzdWUxMjM0NQ==']);
  assert.equal(graphqlRepo({ variables: { input: { branch: { repositoryNameWithOwner: 'Acme/Api', branchName: 'x' } } } }), 'acme/api');
});

test('the repo of looked-up ids: the first id GitHub knows that sits in a repo', () => {
  assert.equal(repoFromNodes({ nodes: [null, { __typename: 'User' }, { __typename: 'Repository', nameWithOwner: 'Acme/Api' }] }), 'acme/api');
  assert.equal(repoFromNodes({ nodes: [{ __typename: 'PullRequestReviewThread', pullRequest: { repository: { nameWithOwner: 'acme/web' } } }] }), 'acme/web');
  assert.equal(repoFromNodes({ nodes: [null] }), null);
  assert.equal(repoFromNodes(null), null);
});

test('a PR made through GraphQL goes to the scope check with its repo id', async () => {
  const scoped = [];
  const f = githubFilter(async () => false, { scope: async (info) => { scoped.push(info); return null; } });
  const r = await f(req('POST', 'https://api.github.com/graphql', { query: 'mutation PullRequestCreate($input: CreatePullRequestInput!) { createPullRequest(input: $input) { pullRequest { url } } }',
    variables: { input: { repositoryId: 'MDEwOlJlcG9zaXRvcnkxMjM0NTY3OA==', baseRefName: 'main', headRefName: 'feature/abc-1', title: 't' } } }));
  assert.equal(r.action, 'allow');
  assert.deepEqual(scoped[0].nodes, ['MDEwOlJlcG9zaXRvcnkxMjM0NTY3OA==']);
});

test('GraphQL branches, tags and commits are told like pushes', async () => {
  const asked = [];
  const look = { protected: async (repo, b) => repo === 'acme/api' && b === 'main' };
  const f = githubFilter(async (what) => { asked.push(what.replace(/^.*\((.*)\)$/, '$1')); return true; }, { look });
  const g = (query, variables) => f(req('POST', 'https://api.github.com/graphql', { query, variables }));
  const ref = 'mutation($input: CreateRefInput!) { createRef(input: $input) { ref { name } } }';
  const commit = 'mutation($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid } } }';
  await g(ref, { input: { repositoryId: 'R_kgDOabc123', name: 'refs/heads/feature/abc-2', oid: 'a'.repeat(40) } });
  await g(commit, { input: { branch: { repositoryNameWithOwner: 'acme/web', branchName: 'feature/abc-2' }, expectedHeadOid: 'a', message: { headline: 'x' }, fileChanges: {} } });
  await g(commit, { input: { branch: { repositoryNameWithOwner: 'acme/api', branchName: 'main' }, expectedHeadOid: 'a', message: { headline: 'x' }, fileChanges: {} } });
  assert.deepEqual(asked, [], 'a feature branch, and main where GitHub\'s protection decides');
  await g(ref, { input: { repositoryId: 'R_kgDOabc123', name: 'refs/tags/v1.0', oid: 'a' } });
  await g('mutation { createRef(input: {repositoryId: "R_kgDOabc123", name: "refs/heads/main", oid: "a"}) { ref { id } } }');
  await g(commit, { input: { branch: { repositoryNameWithOwner: 'acme/web', branchName: 'main' }, expectedHeadOid: 'a', message: { headline: 'x' }, fileChanges: {} } });
  await g(commit, { input: { branch: { id: 'REF_kwDOabc1' }, expectedHeadOid: 'a', message: { headline: 'x' }, fileChanges: {} } });
  assert.deepEqual(asked, ['creates tag v1.0', 'creates main', 'pushes to main', 'a commit Clearsky couldn\'t place']);
});

const pkt = (s) => (s.length + 4).toString(16).padStart(4, '0') + s;
const sha = (c) => c.repeat(40);
const push = (...lines) => new Request('https://github.com/acme/api.git/git-receive-pack', { method: 'POST',
  body: Buffer.concat([Buffer.from(lines.map((l, i) => pkt(`${l}${i ? '' : '\0report-status side-band-64k'}\n`)).join('') + '0000'), Buffer.from('PACK...')]) });

test('everyday branch and PR work goes through and is told; what is hard to undo asks', async () => {
  const asked = [], told = [];
  let answer = true;
  const look = { compare: async (repo, base, head) => (head === sha('f') ? { status: 'diverged' } : head === 'wf' ? { files: [{ filename: '.github/workflows/build.yaml' }] } : { status: 'ahead', files: [{ filename: 'src/A.java' }] }),
    run: async () => ({ head_sha: 'wf' }), defaultBranch: async () => 'main' };
  const f = githubFilter(async (what) => { asked.push(what); return answer; }, { told: (what) => told.push(what), look });
  const ok = async (r) => (await f(r)).action === 'allow';
  // Through, without a card
  assert.ok(await ok(req('GET', 'https://github.com/acme/api.git/info/refs?service=git-receive-pack')));
  assert.ok(await ok(push(`${sha('0')} ${sha('a')} refs/heads/feature/abc-1`)));
  assert.ok(await ok(push(`${sha('a')} ${sha('b')} refs/heads/feature/abc-1`)));
  assert.ok(await ok(req('POST', 'https://api.github.com/repos/acme/api/pulls/7/comments/1/replies', {})));
  assert.ok(await ok(req('POST', 'https://api.github.com/repos/acme/api/pulls', {})));
  assert.ok(await ok(req('POST', 'https://api.github.com/graphql', { query: 'mutation { resolveReviewThread(input: {threadId: "PRRT_abcdef1"}) { x } }' })));
  assert.ok(await ok(req('POST', 'https://api.github.com/repos/acme/api/actions/workflows/build.yaml/dispatches', { ref: 'feature/abc-1' })));
  assert.ok(await ok(req('POST', 'https://api.github.com/repos/acme/api/git/refs', { ref: 'refs/heads/abc-2', sha: sha('a') })), 'a new branch through the API');
  assert.equal(told.at(-1), 'create branch abc-2 in acme/api');
  assert.ok(await ok(req('PATCH', 'https://api.github.com/repos/acme/api/git/refs/heads/abc-2', { sha: sha('b') })), 'moved forward');
  assert.equal(asked.length, 0);
  assert.equal(told.length, 8, 'each one shows in the chat (not the ref list)');
  // Asks
  for (const r of [push(`${sha('a')} ${sha('b')} refs/heads/main`), push(`${sha('a')} ${sha('0')} refs/heads/feature/x`), push(`${sha('0')} ${sha('a')} refs/tags/v1.0`),
    push(`${sha('a')} ${sha('f')} refs/heads/feature/x`), push(`${sha('a')} ${sha('b')} refs/heads/v3.1`),
    req('PUT', 'https://api.github.com/repos/acme/api/pulls/7/merge', {}), req('DELETE', 'https://api.github.com/repos/acme/api/git/refs/heads/x'),
    req('PATCH', 'https://api.github.com/repos/acme/api', {}), req('PUT', 'https://api.github.com/repos/acme/api/actions/secrets/X', {}),
    req('POST', 'https://api.github.com/graphql', { query: 'mutation { mergePullRequest(input: {}) { x } }' }),
    req('POST', 'https://api.github.com/repos/acme/api/actions/runs/5/rerun', {})]) await f(r);
  assert.deepEqual(asked.map((a) => a.replace(/^.*\((.*)\)$/, '$1')), ['pushes to main', 'deletes feature/x', 'pushes tags/v1.0', 'force-pushes feature/x', 'pushes to v3.1',
    'merges into a branch', 'deletes branch x', 'repo settings', 'changes CI secrets or variables', 'mergePullRequest',
    'a one-off CI run of wf, whose branch changes the workflows: workflows/build.yaml']);
  answer = false;
  const body = push(`${sha('a')} ${sha('b')} refs/heads/main`);
  const no = await f(body);
  assert.equal(no.action, 'deny'); assert.match(no.reason, /declined/);
  assert.equal((await f(req('POST', 'https://api.githubcopilot.com/mcp/', {}))).action, 'deny');
});

test('a push is checked in the clone it comes from: GitHub hasn\'t got the new commits yet', async () => {
  const asked = [];
  const look = { compare: async () => { throw new Error('404'); }, fastForward: async (repo, o, n) => (n === sha('f') ? false : n === sha('c') ? null : true) };
  const f = githubFilter(async (what) => { asked.push(what); return true; }, { look });
  assert.equal((await f(push(`${sha('a')} ${sha('b')} refs/heads/feature/abc-1`))).action, 'allow');
  assert.equal(asked.length, 0, 'a fast-forward goes through even though GitHub can\'t compare it');
  await f(push(`${sha('a')} ${sha('f')} refs/heads/feature/abc-1`));
  await f(push(`${sha('a')} ${sha('c')} refs/heads/feature/abc-1`));
  assert.deepEqual(asked.map((a) => a.replace(/^.*\((.*)\)$/, '$1')), ['force-pushes feature/abc-1', 'a push to feature/abc-1 Clearsky couldn\'t check']);
});

test('a push to a protected main is GitHub\'s to refuse; writes to other repos ask', async () => {
  const asked = [];
  const look = { compare: async () => ({ status: 'ahead' }), protected: async (repo, b) => repo === 'acme/api' && b === 'main' };
  const scope = async ({ repo }) => (repo === 'acme/api' ? null : repo ? `goes to ${repo}, not a repo this chat works on` : 'Clearsky couldn\'t tell which repo it changes');
  const f = githubFilter(async (what, info) => { asked.push([what.replace(/^.*\((.*)\)$/, '$1'), info.why]); return true; }, { look, scope });
  await f(push(`${sha('a')} ${sha('b')} refs/heads/main`));
  await f(push(`${sha('a')} ${sha('b')} refs/heads/release/2`));
  await f(req('POST', 'https://api.github.com/repos/acme/api/issues/3/comments', {}));
  await f(req('POST', 'https://api.github.com/repos/other/lib/issues/3/comments', {}));
  await f(new Request('https://github.com/other/lib.git/git-receive-pack', { method: 'POST', body: Buffer.from(pkt(`${sha('a')} ${sha('b')} refs/heads/feature/y\0caps\n`) + '0000') }));
  await f(req('POST', 'https://api.github.com/graphql', { query: 'mutation { addComment(input: {body: "x"}) { x } }' }));
  assert.deepEqual(asked.map((a) => a[0]), ['pushes to release/2', 'goes to other/lib, not a repo this chat works on', 'goes to other/lib, not a repo this chat works on',
    'Clearsky couldn\'t tell which repo it changes']);
});

test('the refs a push updates', () => {
  const buf = Buffer.from(pkt(`${sha('a')} ${sha('b')} refs/heads/x\0caps\n`) + pkt(`${sha('0')} ${sha('c')} refs/heads/y\n`) + '0000PACK');
  assert.deepEqual(pushedRefs(buf).map((r) => [r.ref, r.create, r.remove]), [['refs/heads/x', false, false], ['refs/heads/y', true, false]]);
});

test('CI log storage is read only: downloads go through, uploads are refused', async () => {
  const f = githubFilter(async () => true);
  const host = 'https://productionresultssa7.blob.core.windows.net/actions-results/x/logs.txt?sig=abc';
  assert.ok(GITHUB_LOG_HOSTS.includes('productionresultssa32.blob.core.windows.net'), 'seen in a real run');
  assert.equal((await f(new Request(host))).action, 'allow');
  const up = await f(new Request(host, { method: 'PUT', body: 'code' }));
  assert.equal(up.action, 'deny');
  assert.match(up.reason, /CI log storage is read only/);
  assert.equal(GITHUB_LOG_HOSTS.length, 100);
});

test('branches and tags through the API say what they do', async () => {
  const asked = [];
  const f = githubFilter(async (what) => { asked.push(what); return true; }, { look: {} });
  await f(req('POST', 'https://api.github.com/repos/acme/api/git/refs', { ref: 'refs/tags/v2.0', sha: 'a' }));
  await f(req('POST', 'https://api.github.com/repos/acme/api/git/refs', { ref: 'refs/heads/main', sha: 'a' }));
  await f(req('PATCH', 'https://api.github.com/repos/acme/api/git/refs/heads/abc-2', { sha: 'b', force: true }));
  assert.deepEqual(asked, ['create tag v2.0 in acme/api (creates tag v2.0)', 'create branch main in acme/api (creates main)', 'move branch abc-2 in acme/api (force-moves abc-2)']);
});

test('one mutation with several changes: each is named, a risky one after an everyday one still asks', async () => {
  const gql = (query) => req('POST', 'https://api.github.com/graphql', { query });
  const two = 'mutation { addComment(input: {subjectId: "PR_kwDOabc999", body: "x"}) { clientMutationId } mergePullRequest(input: {pullRequestId: "PR_kwDOabc999"}) { clientMutationId } }';
  assert.deepEqual(graphqlChanges(operations(two)), ['addComment', 'mergePullRequest']);
  assert.equal(await githubWrite(gql(two)), 'GitHub change (addComment, mergePullRequest)');
  assert.equal(await risky(gql(two), 'GitHub change (addComment, mergePullRequest)'), 'mergePullRequest');
  // Aliases, directives and default values with braces don't hide the field.
  assert.deepEqual(graphqlChanges(operations('mutation M($i: X = {a: 1}) @live { gone: deleteRef(input: $i) @include(if: true) { clientMutationId } }')), ['deleteRef']);
  // Two everyday changes may be for two repos: asked, since only one target is looked up.
  assert.equal(await risky(gql('x'), 'GitHub change (addComment, addReaction)'), '2 changes in one request');
  assert.equal(await risky(gql('x'), 'GitHub change (addComment)'), null);
  // A batch: the change in the second document counts as well as the first's.
  assert.equal(await githubWrite(req('POST', 'https://api.github.com/graphql', [{ query: 'mutation { addStar(input: {}) { x } }' }, { query: 'mutation { deleteRef(input: {}) { x } }' }])), 'GitHub change (addStar, deleteRef)');
});

test('a mutation that takes its fields from a fragment can\'t be told, so it asks', async () => {
  const spread = 'mutation { ...F }\nfragment F on Mutation { mergePullRequest(input: {pullRequestId: "PR_kwDOabc999"}) { clientMutationId } }';
  assert.deepEqual(graphqlChanges(operations(spread)), ['fragment']);
  assert.deepEqual(graphqlChanges(operations('mutation { ... on Mutation { deleteRef(input: {}) { x } } }')), ['fragment']);
  const asked = [];
  const r = await githubFilter(async (what) => { asked.push(what); return false; }, { scope: async () => null })(req('POST', 'https://api.github.com/graphql', { query: spread }));
  assert.equal(r.action, 'deny');
  assert.match(asked[0], /couldn't read/);
  // A fragment used further in (what a change gives back) is everyday.
  assert.deepEqual(graphqlChanges(operations('fragment pr on PullRequest { id }\nmutation { createPullRequest(input: {}) { pullRequest { ...pr } } }')), ['createPullRequest']);
});

test('a file committed through the API is a push to its branch', async () => {
  const put = (body) => req('PUT', 'https://api.github.com/repos/acme/api/contents/README.md', body);
  const look = { defaultBranch: async () => 'main', protected: async (repo, b) => b === 'release/1.x' };
  assert.equal(await risky(put({ message: 'm', content: 'eA==' }), 'PUT acme/api/contents/README.md', look), 'pushes to main');
  assert.equal(await risky(put({ message: 'm', content: 'eA==', branch: 'develop' }), 'PUT acme/api/contents/README.md', look), 'pushes to develop');
  assert.equal(await risky(put({ message: 'm', content: 'eA==', branch: 'release/1.x' }), 'PUT acme/api/contents/README.md', look), null, 'GitHub\'s protection decides');
  assert.equal(await risky(put({ message: 'm', content: 'eA==', branch: 'feature/abc-1' }), 'PUT acme/api/contents/README.md', look), null);
});

test('everyday work goes through; your approval, check results and calls nobody listed ask', async () => {
  const api = (method, path, body = {}) => { const r = req(method, `https://api.github.com/repos/acme/api/${path}`, body); return githubWrite(r.clone()).then((what) => risky(r, what)); };
  // Everyday: PRs, issues, comments, labels, review requests, reruns
  for (const [m, p, b] of [['POST', 'pulls'], ['PATCH', 'pulls/7'], ['POST', 'issues/7/comments'], ['POST', 'issues/7/labels'], ['POST', 'pulls/7/requested_reviewers'],
    ['POST', 'pulls/7/comments'], ['PUT', 'pulls/7/update-branch'], ['POST', 'labels'], ['POST', 'git/blobs'], ['POST', 'actions/runs/9/cancel'],
    ['POST', 'pulls/7/reviews', { event: 'COMMENT', body: 'I can\'t approve this yet' }], ['POST', 'pulls/7/reviews', { event: 'REQUEST_CHANGES', body: 'x' }]]) {
    assert.equal(await api(m, p, b), null, `${m} ${p}`);
  }
  // Your approval, by either way of sending a review
  assert.equal(await api('POST', 'pulls/7/reviews', { event: 'APPROVE' }), 'approves a pull request');
  assert.equal(await api('POST', 'pulls/7/reviews/3/events', { event: 'APPROVE', body: 'ok' }), 'approves a pull request');
  assert.equal(await api('PUT', 'pulls/7/reviews/3/dismissals', { message: 'x' }), 'dismisses a review');
  assert.match(await risky(new Request('https://api.github.com/repos/acme/api/pulls/7/reviews', { method: 'POST', body: 'not json' }), 'POST acme/api/pulls/7/reviews'), /couldn't read/);
  // A green check that CI didn't give, and an OK for a run that waits for one
  assert.equal(await api('POST', 'statuses/0123abc', { state: 'success' }), 'sets a check result on a commit');
  assert.equal(await api('POST', 'check-runs', { conclusion: 'success' }), 'sets a check result on a commit');
  assert.match(await api('POST', 'actions/runs/9/pending_deployments', {}), /^approves a CI run or deployment/);
  assert.match(await api('POST', 'actions/runs/9/approve', {}), /^approves a CI run or deployment/);
  assert.equal(await api('POST', 'actions/runners/registration-token'), 'changes how CI runs');
  assert.equal(await api('POST', 'dispatches', { event_type: 'x' }), 'starts workflows with its own input');
  assert.equal(await api('POST', 'forks'), 'makes a new repo from this one');
  assert.equal(await api('PATCH', 'secret-scanning/alerts/1', { state: 'resolved' }), 'changes security alerts');
  // A call nobody listed asks, instead of slipping through
  assert.match(await api('PUT', 'interaction-limits', {}), /not everyday work/);
  assert.match(await api('POST', 'some/new/endpoint', {}), /not everyday work/);
  assert.equal(await risky(req('POST', 'https://api.github.com/markdown', { text: '# x' }), 'POST markdown'), null);
});

test('GraphQL: an approval asks, a review that only comments doesn\'t, an unlisted change asks', async () => {
  const why = async (query, variables) => { const r = req('POST', 'https://api.github.com/graphql', { query, variables }); return risky(r, await githubWrite(r)); };
  const review = 'mutation($input: AddPullRequestReviewInput!) { addPullRequestReview(input: $input) { clientMutationId } }';
  assert.equal(await why(review, { input: { pullRequestId: 'PR_kwDOabc123', event: 'COMMENT', body: 'approved? not yet' } }), null);
  assert.equal(await why(review, { input: { pullRequestId: 'PR_kwDOabc123', event: 'APPROVE' } }), 'approves a pull request');
  // Whatever the variable is called, and written into the query too
  assert.equal(await why('mutation($e: PullRequestReviewEvent!) { submitPullRequestReview(input: {pullRequestReviewId: "PRR_kwDOabc123", event: $e}) { clientMutationId } }', { e: 'APPROVE' }), 'approves a pull request');
  assert.equal(await why('mutation { addPullRequestReview(input: {pullRequestId: "PR_kwDOabc123", event: APPROVE}) { clientMutationId } }'), 'approves a pull request');
  assert.equal(await why('mutation { dismissPullRequestReview(input: {}) { clientMutationId } }'), 'dismissPullRequestReview');
  assert.equal(await why('mutation { approveDeployments(input: {}) { clientMutationId } }'), 'approveDeployments');
  assert.equal(await why('mutation { enqueuePullRequest(input: {}) { clientMutationId } }'), 'enqueuePullRequest');
  assert.equal(await why('mutation { addComment(input: {}) { clientMutationId } }'), null);
  assert.match(await why('mutation { followUser(input: {}) { clientMutationId } }'), /^followUser: not everyday work/);
});
