import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { srtSettings, githubLogin, parseDomains, checkDomains, DEFAULT_DOMAINS } from '../lib/sandbox.mjs';

test('the sandbox lets Copilot write only in its folders and hides secrets', () => {
  const s = srtSettings({ cwd: '/home/me/dev/acme/abc', folders: ['~/dev/acme', '/home/me/dev/acme'], home: '/home/me' });
  assert.deepEqual(s.filesystem.allowWrite, ['/home/me/dev/acme/abc', '/home/me/dev/acme', '/home/me/.copilot', '/home/me/.cache/copilot', '/tmp']);
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
    const { execFileSync } = await import('node:child_process');
    const t = await sandboxedCommand('/bin/sh', ['-c', 'echo "$GH_TOKEN"'], { cwd: dir, home: dir, github: gh });
    const inside = execFileSync(t.bin, t.args, { encoding: 'utf8', env: { PATH: env.PATH } }).trim();
    assert.match(inside, /^gho_fake_value_/);
  } finally {
    for (const k of ['GH_TOKEN', 'COPILOT_GITHUB_TOKEN', 'GIT_CONFIG_VALUE_0']) delete env[k];
    await stopSandbox();
  }
});
