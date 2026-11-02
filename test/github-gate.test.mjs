import { test } from 'node:test';
import assert from 'node:assert/strict';
import { githubWrite, githubFilter, graphqlNodeIds, pushedRefs, GITHUB_LOG_HOSTS } from '../lib/github-gate.mjs';

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
    'runs CI on a branch that changes its workflows']);
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
