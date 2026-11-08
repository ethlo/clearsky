// `clearsky doctor` and the welcome page: what's there, what's missing and the fix for this OS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checks, suggestions, ready, doctorText, installHint } from '../lib/doctor.mjs';

const fakeRun = (answers) => async (cmd, args) => answers[`${cmd} ${args.join(' ')}`] || { ok: false, missing: true, out: '' };

test('a machine with everything is ready, and says who is logged in', async () => {
  const list = await checks({ platform: 'linux', env: {}, nodeVersion: '22.4.0', has: () => true, srt: async () => true, calendars: () => [{}], browser: () => '/usr/bin/chromium',
    copilotBin: '/usr/bin/copilot',
    run: fakeRun({ 'gh auth status': { ok: true, out: 'github.com\n  ✓ Logged in to github.com account alex (keyring)' }, 'acli jira auth status': { ok: true, out: '✓ Authenticated\n  Site: acme.atlassian.net' } }) });
  assert.ok(ready(list));
  assert.match(list.find((c) => c.id === 'gh').detail, /alex/);
  assert.match(list.find((c) => c.id === 'acli').detail, /acme\.atlassian\.net/);
  assert.ok(list.every((c) => c.ok));
});

test('missing tools come with the install command for that OS, and no token is asked for', async () => {
  const bare = { env: {}, nodeVersion: '20.1.0', has: () => false, srt: async () => false, run: fakeRun({}) };
  const mac = await checks({ ...bare, platform: 'darwin' });
  const win = await checks({ ...bare, platform: 'win32' });
  assert.ok(!ready(mac));
  assert.equal(mac.find((c) => c.id === 'gh').fix.command, 'brew install gh');
  assert.equal(win.find((c) => c.id === 'gh').fix.command, 'winget install GitHub.cli');
  assert.match(win.find((c) => c.id === 'sandbox-tools').detail, /windows-install/);
  assert.match(mac.find((c) => c.id === 'calendar').detail, /iCal/);
  assert.equal(installHint('gh', 'linux', 'dnf').command, 'sudo dnf install gh');
  const text = doctorText(mac);
  assert.match(text, /✗ Node 22/);
  assert.doesNotMatch(text, /token/i);
});

test('a logged-out gh offers the login instead of an install', async () => {
  const list = await checks({ platform: 'linux', env: {}, has: () => true, srt: async () => true, run: fakeRun({ 'gh auth status': { ok: false, out: 'You are not logged into any GitHub hosts.' } }) });
  const gh = list.find((c) => c.id === 'gh');
  assert.equal(gh.ok, false);
  assert.equal(gh.login, 'github');
  assert.equal(gh.fix, undefined);
});

test('organizations and the Jira site come from the gh and acli logins', async () => {
  const s = await suggestions({ run: fakeRun({ 'gh api user/orgs --jq .[].login': { ok: true, out: 'acme\nacme-labs\n' }, 'acli jira auth status': { ok: true, out: 'Site: acme.atlassian.net' } }) });
  assert.deepEqual(s, { orgs: ['acme', 'acme-labs'], jiraSite: 'acme.atlassian.net' });
});
