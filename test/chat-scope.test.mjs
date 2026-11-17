import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clonesIn, headBranch, scopeSnapshot, scopeRepos, scopeOf, saveScope, addScopeRepo } from '../lib/chat-scope.mjs';

// A clone as far as these functions look: a .git folder with a HEAD. `remotes` stands in for git.
function clone(dir, branch = 'main') {
  mkdirSync(join(dir, '.git'), { recursive: true });
  writeFileSync(join(dir, '.git', 'HEAD'), `ref: refs/heads/${branch}\n`);
  return dir;
}

test('a clone\'s repos are the ones it had when the chat started: a remote added later isn\'t one', async () => {
  const dir = clone(mkdtempSync(join(tmpdir(), 'scope-')));
  const now = { [dir]: ['acme/api'] };
  const remotes = async (d) => now[d] || null;
  const scope = await scopeSnapshot(dir, remotes);
  assert.deepEqual(scope, { '.': ['acme/api'] });
  now[dir].push('other/secrets'); // the chat runs `git remote add`
  assert.deepEqual([...scopeRepos(scope)], ['acme/api']);
});

test('a folder of clones: the clones there at the start, by the branch named after the chat\'s ticket', async () => {
  const root = mkdtempSync(join(tmpdir(), 'scope-'));
  const api = clone(join(root, 'api'), 'feature/ABC-12-fix'), web = clone(join(root, 'web')), deep = clone(join(root, 'team', 'tools'), 'abc-12');
  mkdirSync(join(root, 'notes'));
  const repos = { [api]: ['acme/api'], [web]: ['acme/web'], [deep]: ['acme/tools'] };
  const scope = await scopeSnapshot(root, async (d) => repos[d] || null);
  assert.deepEqual(scope, { '.': [], api: ['acme/api'], web: ['acme/web'], [join('team', 'tools')]: ['acme/tools'] });
  assert.deepEqual(clonesIn(root).sort(), [api, deep, web].sort());
  const branch = (p) => headBranch(join(root, p));
  assert.deepEqual([...scopeRepos(scope, { tickets: new Set(['ABC-12']), branch })].sort(), ['acme/api', 'acme/tools']);
  assert.deepEqual([...scopeRepos(scope, { tickets: new Set(['ABC-1']), branch })], [], 'ABC-1 is not ABC-12');
  assert.deepEqual([...scopeRepos(scope, { branch })], [], 'no ticket, no clone picked');
  // The chat clones something else and names its branch after the ticket: not on the list.
  clone(join(root, 'planted'), 'ABC-12');
  assert.deepEqual([...scopeRepos(scope, { tickets: new Set(['ABC-12']), branch })].sort(), ['acme/api', 'acme/tools']);
});

test('a worktree\'s branch is read from its own HEAD', () => {
  const root = mkdtempSync(join(tmpdir(), 'scope-'));
  const main = clone(join(root, 'api'));
  mkdirSync(join(main, '.git', 'worktrees', 'wt'), { recursive: true });
  writeFileSync(join(main, '.git', 'worktrees', 'wt', 'HEAD'), 'ref: refs/heads/abc-7-thing\n');
  mkdirSync(join(root, 'wt'));
  writeFileSync(join(root, 'wt', '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'wt')}\n`);
  assert.equal(headBranch(join(root, 'wt')), 'ABC-7-THING');
  assert.equal(headBranch(main), 'MAIN');
  assert.equal(headBranch(join(root, 'nothing')), '');
});

test('the list is kept per chat; a repo you allow joins it, and only the last 200 chats stay', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'scope-')), 'chat-scopes.json');
  assert.equal(scopeOf(file, 'a'), null);
  saveScope(file, 'a', { '.': ['acme/api'] });
  addScopeRepo(file, 'a', 'Acme/Docs');
  addScopeRepo(file, 'a', 'acme/docs');
  addScopeRepo(file, 'unknown', 'acme/docs');
  assert.deepEqual(scopeOf(file, 'a'), { '.': ['acme/api'], '+': ['acme/docs'] });
  assert.deepEqual([...scopeRepos(scopeOf(file, 'a'))], ['acme/api', 'acme/docs']);
  assert.equal(scopeOf(file, 'unknown'), null);
  for (let i = 0; i < 200; i++) saveScope(file, `s${i}`, { '.': [] });
  assert.equal(scopeOf(file, 'a'), null);
  assert.deepEqual(scopeOf(file, 's199'), { '.': [] });
});
