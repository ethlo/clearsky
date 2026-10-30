import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { srtSettings, sandboxed, parseDomains, checkDomains, DEFAULT_DOMAINS } from '../lib/sandbox.mjs';

test('the sandbox lets Copilot write only in its folders and hides secrets', () => {
  const s = srtSettings({ cwd: '/home/me/dev/kezzler/ssp', folders: ['~/dev/kezzler', '/home/me/dev/kezzler'], home: '/home/me' });
  assert.deepEqual(s.filesystem.allowWrite, ['/home/me/dev/kezzler/ssp', '/home/me/dev/kezzler', '/home/me/.copilot', '/tmp']);
  assert.ok(s.filesystem.denyRead.includes('/home/me/.ssh'));
  assert.ok(s.filesystem.denyRead.includes('/home/me/.config/clearsky'));
  assert.deepEqual(s.network.allowedDomains, DEFAULT_DOMAINS);
});

test('hosts are checked, and the settings file is private', () => {
  assert.deepEqual(parseDomains('github.com, *.atlassian.net\nrepo.maven.apache.org:443'), ['github.com', '*.atlassian.net', 'repo.maven.apache.org:443']);
  assert.ok(checkDomains(['github.com', '*.atlassian.net']));
  assert.ok(!checkDomains(['*']));
  assert.ok(!checkDomains(['http://github.com']));
  const dir = mkdtempSync(join(tmpdir(), 'clearsky-srt-'));
  const r = sandboxed('/usr/bin/copilot', ['--model', 'x'], { srt: 'srt', dir, cwd: '/tmp/w', home: '/home/me' });
  assert.deepEqual(r.args.slice(2), ['--', '/usr/bin/copilot', '--model', 'x']);
  assert.equal(statSync(r.file).mode & 0o777, 0o600);
  assert.ok(JSON.parse(readFileSync(r.file, 'utf8')).filesystem.allowWrite.includes('/tmp/w'));
});

test('Copilot starts through srt', async () => {
  const { writeFileSync, chmodSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { AcpAgent } = await import('../lib/acp.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'clearsky-srt-'));
  // A stand-in for srt: checks its settings file, then runs what follows --.
  const srt = join(dir, 'srt');
  writeFileSync(srt, '#!/bin/sh\n[ "$1" = --settings ] && [ -f "$2" ] && [ "$3" = -- ] || exit 9\nshift 3\nexec "$@"\n');
  chmodSync(srt, 0o755);
  const r = sandboxed(process.execPath, [fileURLToPath(new URL('./fake-copilot.mjs', import.meta.url))], { srt, dir, cwd: dir, home: dir });
  const agent = new AcpAgent(r.bin, r.args, { env: process.env });
  try { assert.ok(await agent.start(dir)); } finally { agent.close(); }
});
