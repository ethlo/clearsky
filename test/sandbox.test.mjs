import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { srtSettings, githubLogin, parseDomains, checkDomains, DEFAULT_DOMAINS, repoGuards, gitFolder } from '../lib/sandbox.mjs';

test('the sandbox lets Copilot write only in its folders and hides secrets', () => {
  const s = srtSettings({ cwd: '/home/me/dev/acme/abc', folders: ['~/dev/acme', '/home/me/dev/acme'], home: '/home/me' });
  assert.deepEqual(s.filesystem.allowWrite, ['/home/me/dev/acme/abc', '/home/me/dev/acme', '/home/me/.copilot', '/home/me/.cache/copilot', ...(process.platform === 'linux' ? [] : ['/tmp'])]);
  assert.ok(s.filesystem.denyRead.includes('/home/me/.ssh'));
  assert.ok(s.filesystem.denyRead.includes('/home/me/.config/clearsky'));
  assert.deepEqual(s.network.allowedDomains, DEFAULT_DOMAINS);
});

test('hosts are checked', () => {
  assert.deepEqual(parseDomains('github.com, *.atlassian.net\nrepo.maven.apache.org:443'), ['github.com', '*.atlassian.net', 'repo.maven.apache.org:443']);
  assert.ok(checkDomains(['github.com', '*.atlassian.net']));
  assert.ok(!checkDomains(['*']));
  assert.ok(!checkDomains(['http://github.com']));
});

test('your GitHub login stays out of the sandbox: srt adds it on the way to GitHub', () => {
  const env = {};
  const gh = githubLogin('gho_secret123', env, 4);
  assert.equal(env.GH_TOKEN, 'gho_secret123');
  assert.equal(env.GIT_CONFIG_VALUE_4, `Authorization: Basic ${Buffer.from('x-access-token:gho_secret123').toString('base64')}`);
  assert.deepEqual(gh.credentials.map((c) => [c.name, c.mode, c.onExtractNoMatch]), [['GH_TOKEN', 'mask', 'deny'], ['COPILOT_GITHUB_TOKEN', 'mask', 'deny'], ['GIT_CONFIG_VALUE_4', 'mask', 'deny']]);
  assert.match(env.GIT_CONFIG_VALUE_4, new RegExp(gh.credentials[2].extract));
  const s = srtSettings({ cwd: '/h/dev/x', home: '/h', github: gh, ca: { cert: '/k/ca.pem', key: '/k/ca.key' } });
  assert.equal(s.credentials.envVars.length, 3);
  assert.ok(!s.network.tlsTerminate.excludeDomains.includes('*.github.com'), 'GitHub is read by the proxy');
  assert.ok(s.network.tlsTerminate.excludeDomains.includes('*.atlassian.net'), 'other hosts are not');
});

test('on Linux, srt runs without its socket filter and hides the session bus instead', () => {
  const s = srtSettings({ cwd: '/h/dev/x', home: '/h', platform: 'linux', uid: 1000 });
  assert.equal(s.network.allowAllUnixSockets, true);
  assert.ok(s.filesystem.denyRead.includes('/run/user/1000'));
  assert.equal(srtSettings({ cwd: '/h/x', home: '/h', platform: 'darwin', uid: 501 }).network.allowAllUnixSockets, undefined);
  // The machine's /tmp, where other programs keep sockets too, is hidden: the chat gets one of its
  // own, and Clearsky's run folder is put back for reading.
  const own = srtSettings({ cwd: '/h/dev/x', home: '/h', platform: 'linux', uid: 1000, run: '/tmp/clearsky-1000', exists: () => true }).filesystem;
  assert.ok(own.denyRead.includes('/tmp') && !own.allowWrite.includes('/tmp'));
  assert.ok(own.allowRead.includes('/tmp/clearsky-1000') && own.denyWrite.includes('/tmp/clearsky-1000'));
  // macOS keeps srt's own socket filter, and the machine's /tmp.
  const mac = srtSettings({ cwd: '/h/x', home: '/h', platform: 'darwin', uid: 501, run: '/tmp/clearsky-501', exists: () => true }).filesystem;
  assert.ok(!mac.denyRead.includes('/tmp') && mac.allowWrite.includes('/tmp'));
});


// The real srt, in Clearsky's process: only where its tools are installed (bubblewrap on Linux).
const srtReady = process.platform === 'darwin' || ['bwrap', 'socat', 'rg'].every((b) => (process.env.PATH || '').split(':').some((d) => d && existsSync(join(d, b))));
test('Copilot starts inside srt, and gets stand-ins for your logins', { skip: !srtReady && 'srt\'s tools are not installed' }, async () => {
  const { fileURLToPath } = await import('node:url');
  const { AcpAgent } = await import('../lib/acp.mjs');
  const { sandboxedCommand, stopSandbox } = await import('../lib/sandbox.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'clearsky-srt-'));
  const env = process.env;
  const gh = githubLogin('gho_secret123', env, 0);
  try {
    const fake = fileURLToPath(new URL('./fake-copilot.mjs', import.meta.url));
    const s = await sandboxedCommand(process.execPath, [fake, '--acp'], { cwd: dir, home: dir, read: [fileURLToPath(new URL('..', import.meta.url))], github: gh });
    const agent = new AcpAgent(s.bin, s.args, { env: { PATH: env.PATH }, acp: false });
    try { assert.ok(await agent.start(dir)); } finally { agent.close(); }
    const t = await sandboxedCommand('/bin/sh', ['-c', 'echo "$GH_TOKEN"'], { cwd: dir, home: dir, github: gh });
    const inside = execFileSync(t.bin, t.args, { encoding: 'utf8', env: { PATH: env.PATH } }).trim();
    assert.match(inside, /^gho_fake_value_/);
  } finally {
    for (const k of ['GH_TOKEN', 'COPILOT_GITHUB_TOKEN', 'GIT_CONFIG_VALUE_0']) delete env[k];
    await stopSandbox();
  }
});

test('under WSL the sandbox also hides the Windows drives and the interop socket', () => {
  const s = srtSettings({ cwd: '/h/dev/x', home: '/h', platform: 'linux', uid: 1000, wsl: { version: 2 }, exists: () => true, folders: ['/mnt/c/Users/me/repo'] });
  assert.ok(s.filesystem.denyRead.includes('/mnt') && s.filesystem.denyRead.includes('/run/WSL'));
  assert.ok(s.filesystem.allowRead.includes('/mnt/c/Users/me/repo'), 'a folder you give Copilot there is allowed back');
  assert.ok(!srtSettings({ cwd: '/h/dev/x', home: '/h', platform: 'linux', uid: 1000, wsl: null, exists: () => true }).filesystem.denyRead.includes('/mnt'));
});

// A clone as far as the guards look: a .git folder with hooks and a config.
function fakeClone(dir) {
  mkdirSync(join(dir, '.git', 'hooks'), { recursive: true });
  writeFileSync(join(dir, '.git', 'config'), '[core]\n');
  writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  return dir;
}

test('git hooks and settings of every clone in the chat\'s folders are kept from being written', () => {
  const root = mkdtempSync(join(tmpdir(), 'clearsky-guard-'));
  const api = fakeClone(join(root, 'acme', 'api')), web = fakeClone(join(root, 'acme', 'web'));
  // A worktree of api: its hooks and settings are the main clone's.
  mkdirSync(join(api, '.git', 'worktrees', 'wt'), { recursive: true });
  writeFileSync(join(api, '.git', 'worktrees', 'wt', 'commondir'), '../..\n');
  mkdirSync(join(root, 'acme', 'api-wt'));
  writeFileSync(join(root, 'acme', 'api-wt', '.git'), `gitdir: ${join(api, '.git', 'worktrees', 'wt')}\n`);
  assert.equal(gitFolder(join(root, 'acme', 'api-wt')), join(api, '.git'));
  // A submodule's git folder has hooks and settings of its own.
  mkdirSync(join(web, '.git', 'modules', 'lib', 'hooks'), { recursive: true });
  writeFileSync(join(web, '.git', 'modules', 'lib', 'config'), '');
  const g = repoGuards([root], { tracked: () => new Set() });
  assert.deepEqual(g.sort(), [join(api, '.git', 'config'), join(api, '.git', 'hooks'), join(web, '.git', 'config'), join(web, '.git', 'hooks'),
    join(web, '.git', 'modules', 'lib', 'config'), join(web, '.git', 'modules', 'lib', 'hooks')].sort());
  assert.deepEqual(repoGuards([join(root, 'acme', 'api-wt')], { tracked: () => new Set() }).sort(), [join(api, '.git', 'config'), join(api, '.git', 'hooks')].sort());
  // A clone without a hooks folder gets an empty one: only what exists can be kept closed.
  const bare = join(root, 'acme', 'bare'); mkdirSync(join(bare, '.git'), { recursive: true }); writeFileSync(join(bare, '.git', 'config'), '');
  assert.ok(repoGuards([bare]).includes(join(bare, '.git', 'hooks')) && existsSync(join(bare, '.git', 'hooks')));
});

test('editor and agent settings in the chat\'s clone are guarded when git doesn\'t track them, and only if they exist', () => {
  const api = fakeClone(join(mkdtempSync(join(tmpdir(), 'clearsky-guard-')), 'api'));
  mkdirSync(join(api, '.idea')); mkdirSync(join(api, '.vscode')); writeFileSync(join(api, '.mcp.json'), '{}');
  const asked = [];
  const g = repoGuards([api], { cwd: api, tracked: (dir, paths) => { asked.push(...paths); return new Set(['.vscode']); } });
  assert.deepEqual(asked.sort(), ['.idea', '.mcp.json', '.vscode'], 'only what exists is looked up');
  assert.ok(g.includes(join(api, '.idea')) && g.includes(join(api, '.mcp.json')));
  assert.ok(!g.includes(join(api, '.vscode')), 'tracked: git must be able to change it on checkout, and a change shows in the diff');
  assert.ok(!g.some((p) => p.endsWith('.claude/commands')), 'not there: not named (a denied path that isn\'t there breaks `git add -A`)');
  // When git can't say what's tracked, only git's own files are guarded.
  assert.deepEqual(repoGuards([api], { cwd: api, tracked: () => null }).sort(), [join(api, '.git', 'config'), join(api, '.git', 'hooks')]);
  // Another clone in the chat's folders: git's own files only.
  assert.ok(!repoGuards([api], { cwd: join(api, 'src'), tracked: () => new Set() }).includes(join(api, '.idea')));
});

test('the agent\'s own settings and Clearsky\'s run folder are read only in folders that are written', () => {
  const exists = (p) => !p.endsWith('lsp-config.json');
  const s = srtSettings({ cwd: '/h/dev/x', home: '/h', exists, guards: (roots) => roots.map((r) => `${r}/.git/hooks`),
    protect: ['~/.copilot/mcp-config.json', '~/.copilot/lsp-config.json', '~/.copilot/skills'], run: '/tmp/clearsky-1000' });
  assert.deepEqual(s.filesystem.denyWrite, ['/h/dev/x/.git/hooks', '/h/.copilot/mcp-config.json', '/h/.copilot/skills', '/tmp/clearsky-1000']);
  assert.ok(s.filesystem.allowWrite.includes('/h/.copilot'), 'its session state is still written');
});

// bwrap is there and may make its own namespaces (some CI machines and containers don't let it).
const bwrapRuns = () => { try { execFileSync('bwrap', ['--ro-bind', '/', '/', 'true'], { stdio: 'ignore' }); return true; } catch { return false; } };
test('in the real sandbox: work is written; hooks, git settings and the agent\'s settings are not; /tmp is the chat\'s own', { skip: !(srtReady && process.platform === 'linux' && bwrapRuns()) && 'needs srt\'s tools and a working bwrap on Linux' }, async () => {
  const { sandboxedCommand, stopSandbox } = await import('../lib/sandbox.mjs');
  const home = mkdtempSync(join(tmpdir(), 'clearsky-srt-'));
  const api = join(home, 'dev', 'api');
  mkdirSync(api, { recursive: true });
  const env = { PATH: process.env.PATH, HOME: home };
  execFileSync('git', ['init', '-q', api], { env });
  mkdirSync(join(home, '.copilot', 'skills'), { recursive: true });
  writeFileSync(join(home, '.copilot', 'mcp-config.json'), '{}');
  // Clearsky's run folder is outside your home folder (which the sandbox can't read), in /tmp.
  const run = mkdtempSync(join(tmpdir(), 'clearsky-run-')); writeFileSync(join(run, 'settings.xml'), '<settings/>');
  // Another program's socket and file in the machine's /tmp, and Clearsky's own socket in its run folder. (Connecting needs no accept.)
  const net = await import('node:net');
  const other = mkdtempSync(join(tmpdir(), 'other-program-'));
  const servers = [join(other, 's.sock'), join(run, 'broker.sock')].map((p) => net.createServer().listen(p));
  await Promise.all(servers.map((sv) => new Promise((ok) => { sv.once('listening', ok); })));
  const connect = (p) => `${process.execPath} -e "require('net').connect('${p}').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))"`;
  writeFileSync(join(other, 'notes.txt'), 'theirs');
  const tries = { otherSocket: connect(join(other, 's.sock')), otherFile: `cat ${join(other, 'notes.txt')}`, door: connect(join(run, 'broker.sock')),
    tmp: 'echo x > /tmp/clearsky-own && cat /tmp/clearsky-own', work: 'echo x > file.txt', commit: 'git add -A && git -c user.name=x -c user.email=x@x commit -q -m x', hook: 'echo x > .git/hooks/pre-commit',
    config: 'git config core.fsmonitor /tmp/x', mcp: `echo x >> ${join(home, '.copilot', 'mcp-config.json')}`, skill: `mkdir ${join(home, '.copilot', 'skills', 'new')}`, newHook: `echo x > ${join(home, '.copilot', 'hooks', 'x.json')}`,
    state: `echo x > ${join(home, '.copilot', 'session.json')}`, run: `echo x > ${join(run, 'planted')}`, readRun: `cat ${join(run, 'settings.xml')}` };
  const script = Object.entries(tries).map(([k, c]) => `if (${c}) >/dev/null 2>&1; then echo ${k}=yes; else echo ${k}=no; fi`).join('\n');
  try {
    const s = await sandboxedCommand('/bin/sh', ['-c', script], { cwd: api, folders: [join(home, 'dev')], home, protect: ['~/.copilot/mcp-config.json', '~/.copilot/skills/', '~/.copilot/hooks/'], run, nice: 0 });
    const out = Object.fromEntries(execFileSync(s.bin, s.args, { cwd: api, encoding: 'utf8', env }).trim().split('\n').map((l) => l.split('=')));
    assert.ok(!existsSync('/tmp/clearsky-own'), 'what the chat writes in /tmp stays in its own /tmp');
    assert.deepEqual(out, { otherSocket: 'no', otherFile: 'no', door: 'yes', tmp: 'yes', work: 'yes', commit: 'yes', hook: 'no', config: 'no', mcp: 'no', skill: 'no', newHook: 'no', state: 'yes', run: 'no', readRun: 'yes' });
  } finally { for (const sv of servers) sv.close(); await stopSandbox(); }
});
