import { test } from 'node:test';
import assert from 'node:assert/strict';
import { githubWrite, githubFilter } from '../lib/github-gate.mjs';

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
  assert.equal((await f(req('POST', 'https://api.githubcopilot.com/mcp/', {}))).action, 'deny');
  assert.deepEqual(asked, ['git push to acme/api', 'POST acme/api/issues/1/comments']);
});
