import { test } from 'node:test';
import assert from 'node:assert/strict';
import { githubWrite, githubFilter, graphqlNodeIds } from '../lib/github-gate.mjs';

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

test('a write waits for your answer; one OK covers both halves of a push', async () => {
  const asked = [];
  let answer = true;
  const f = githubFilter(async (what) => { asked.push(what); return answer; });
  assert.equal((await f(req('GET', 'https://api.github.com/user'))).action, 'allow');
  assert.equal((await f(req('GET', 'https://github.com/acme/api.git/info/refs?service=git-receive-pack'))).action, 'allow');
  assert.equal((await f(req('POST', 'https://github.com/acme/api.git/git-receive-pack', {}))).action, 'allow');
  answer = false;
  const no = await f(req('POST', 'https://api.github.com/repos/acme/api/issues/1/comments', {}));
  assert.equal(no.action, 'deny'); assert.match(no.reason, /declined/);
  const body = req('POST', 'https://api.github.com/repos/acme/api/issues', { title: 'x' });
  await f(body);
  assert.ok(body.bodyUsed, 'a denied request\'s body is read (srt crashes otherwise)');
  assert.equal((await f(req('POST', 'https://api.githubcopilot.com/mcp/', {}))).action, 'deny');
  assert.deepEqual(asked, ['git push to acme/api', 'POST acme/api/issues/1/comments', 'POST acme/api/issues']);
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

test('"Allow on this repo for 15 min" covers that repo\'s changes and review work, not pushes', async () => {
  let t = 0;
  const asked = [];
  const f = githubFilter(async (what, { repo }) => { asked.push(what); return repo ? 'repo' : true; }, { now: () => t });
  const gql = (query) => req('POST', 'https://api.github.com/graphql', { query });
  assert.equal((await f(req('POST', 'https://api.github.com/repos/acme/api/pulls/7/comments/1/replies', {}))).action, 'allow');
  assert.equal((await f(req('POST', 'https://api.github.com/repos/acme/api/pulls/7/comments/2/replies', {}))).action, 'allow');
  assert.equal((await f(gql('mutation { resolveReviewThread(input: {threadId: "x"}) { thread { id } } }'))).action, 'allow');
  assert.equal(asked.length, 1, 'asked once');
  await f(req('POST', 'https://api.github.com/repos/acme/web/issues', {}));
  await f(gql('mutation { deleteRepository(input: {}) { x } }'));
  await f(req('GET', 'https://github.com/acme/api.git/info/refs?service=git-receive-pack'));
  assert.deepEqual(asked.slice(1), ['POST acme/web/issues', 'GitHub change (deleteRepository)', 'git push to acme/api']);
  t += 16 * 6e4;
  await f(req('POST', 'https://api.github.com/repos/acme/api/pulls/7/comments/3/replies', {}));
  assert.equal(asked.length, 5, 'asks again after 15 minutes');
});

test('a GraphQL change names its nodes, so Clearsky can find the repo (and the chat) it is for', async () => {
  assert.deepEqual(graphqlNodeIds({ query: 'mutation($t: ID!) { resolveReviewThread(input: {threadId: $t}) { thread { id } } }', variables: { t: 'PRRT_kwDOabc123' } }), ['PRRT_kwDOabc123']);
  assert.deepEqual(graphqlNodeIds({ query: 'mutation { createPullRequest(input: {repositoryId: "R_kgDOxyz789", title: "PR_ is not an id"}) { x } }' }), ['R_kgDOxyz789']);
  const seen = [];
  await githubFilter(async (what, opts) => { seen.push(opts.nodes); return true; })(
    req('POST', 'https://api.github.com/graphql', { query: 'mutation { addComment(input: {subjectId: "PR_kwDOabc999", body: "x"}) { x } }' }));
  assert.deepEqual(seen, [['PR_kwDOabc999']]);
});
