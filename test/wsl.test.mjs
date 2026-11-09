// Windows through WSL2: finding WSL, the Windows browser, links and logins, the VM's reasons, and
// the doctor's hints there. WSL is faked: the kernel strings, env and files are passed in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wslInfo, wslOpenCommand, windowsBrowser, windowsProfileDir, onWindowsDrive, wslVmWhy, loginEnv } from '../lib/wsl.mjs';
import { findBrowser, openCommand } from '../lib/browser.mjs';
import { vmSupport } from '../lib/vm.mjs';
import { checks, ready, doctorText } from '../lib/doctor.mjs';

const WSL2 = { platform: 'linux', env: { WSL_DISTRO_NAME: 'Ubuntu', WSL_INTEROP: '/run/WSL/1_interop' }, release: '6.6.87.2-microsoft-standard-WSL2', version: '' };

test('WSL2, WSL1 and plain Linux are told apart', () => {
  assert.deepEqual(wslInfo(WSL2), { version: 2, distro: 'Ubuntu' });
  assert.deepEqual(wslInfo({ platform: 'linux', env: { WSL_DISTRO_NAME: 'Ubuntu' }, release: '4.4.0-19041-Microsoft', version: 'Linux version 4.4.0-19041-Microsoft' }), { version: 1, distro: 'Ubuntu' });
  assert.equal(wslInfo({ platform: 'linux', env: {}, release: '6.8.0-45-generic', version: 'Linux version 6.8.0-45-generic' }), null);
  assert.equal(wslInfo({ ...WSL2, platform: 'darwin' }), null);
  // CLEARSKY_WSL fakes it either way.
  assert.equal(wslInfo({ platform: 'linux', env: { CLEARSKY_WSL: '2' }, release: '6.8.0-generic', version: '' }).version, 2);
  assert.equal(wslInfo({ ...WSL2, env: { ...WSL2.env, CLEARSKY_WSL: '0' } }), null);
});

test('links open in the Windows browser: wslview, else rundll32.exe', () => {
  assert.deepEqual(wslOpenCommand({ has: (b) => b === 'wslview' }), ['wslview']);
  assert.deepEqual(wslOpenCommand({ has: () => false }), ['rundll32.exe', 'url.dll,FileProtocolHandler']);
  assert.deepEqual(openCommand({ platform: 'linux', wsl: null }), ['xdg-open']);
  assert.deepEqual(openCommand({ platform: 'linux', env: { PATH: '' }, wsl: { version: 2 } }), ['rundll32.exe', 'url.dll,FileProtocolHandler']);
  assert.deepEqual(openCommand({ platform: 'darwin' }), ['open']);
});

test('the app window uses Edge on C:, with its profile on Windows; the school login keeps a Linux browser', () => {
  const edge = '/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  assert.equal(windowsBrowser({ exists: (p) => p === edge }), edge);
  assert.equal(windowsBrowser({ exists: () => false }), null);
  const env = { PATH: '' };
  assert.equal(findBrowser(env, { platform: 'linux', desktop: '', windows: true, wsl: { version: 2 }, winBrowser: () => edge }), edge);
  assert.notEqual(findBrowser(env, { platform: 'linux', desktop: '', windows: false, wsl: { version: 2 }, winBrowser: () => edge }), edge);
  assert.equal(findBrowser({ ...env, CLEARSKY_BROWSER: '/usr/bin/chromium' }, { platform: 'linux', desktop: '', windows: true, wsl: { version: 2 }, winBrowser: () => edge }), '/usr/bin/chromium');
  assert.equal(windowsProfileDir({ run: () => 'C:\\Users\\alex\\AppData\\Local\r\n' }), 'C:\\Users\\alex\\AppData\\Local\\Clearsky\\app-window');
  assert.equal(windowsProfileDir({ run: () => '%LOCALAPPDATA%' }), null);
  assert.equal(windowsProfileDir({ run: () => { throw new Error('no interop'); } }), null);
});

test('gh and acli logins get BROWSER=wslview under WSL, unless BROWSER is set', () => {
  assert.equal(loginEnv({ PATH: '' }, { wsl: { version: 2 }, has: () => true }).BROWSER, 'wslview');
  assert.equal(loginEnv({ BROWSER: 'firefox' }, { wsl: { version: 2 }, has: () => true }).BROWSER, 'firefox');
  assert.equal(loginEnv({}, { wsl: null, has: () => true }).BROWSER, undefined);
  assert.equal(loginEnv({}, { wsl: { version: 2 }, has: () => false }).BROWSER, undefined);
});

test('the VM under WSL says how to get KVM, or that WSL1 never will', () => {
  const wsl = { version: 2, distro: 'Ubuntu' };
  assert.match(vmSupport({ platform: 'linux', wsl, exists: () => false }).why, /nestedVirtualization=true.*\.wslconfig.*wsl --shutdown/);
  assert.match(vmSupport({ platform: 'linux', wsl, exists: () => true, usable: () => false }).why, /usermod -aG kvm/);
  assert.match(vmSupport({ platform: 'linux', wsl: { version: 1 }, exists: () => true }).why, /WSL1.*--set-version/);
  assert.deepEqual(vmSupport({ platform: 'linux', wsl, exists: () => true, usable: () => true, has: () => true }), { ok: true });
  assert.match(vmSupport({ platform: 'win32' }).why, /WSL2/);
  assert.equal(wslVmWhy(null, 'no /dev/kvm'), 'no /dev/kvm');
  assert.ok(onWindowsDrive('/mnt/c/Users/alex/dev') && onWindowsDrive('/mnt/d') && !onWindowsDrive('/home/alex/dev') && !onWindowsDrive('/mnt/wsl/x'));
});

const fakeRun = (answers) => async (cmd, args) => answers[`${cmd} ${args.join(' ')}`] || { ok: false, missing: true, out: '' };
const loggedIn = fakeRun({ 'gh auth status': { ok: true, out: 'Logged in to github.com account alex (keyring)' }, 'acli jira auth status': { ok: true, out: 'Site: acme.atlassian.net' } });

test('doctor under WSL2: Windows browser, iCal calendar, wslview, repos off C:, and the VM', async () => {
  const list = await checks({ platform: 'linux', env: {}, nodeVersion: '22.4.0', has: (b) => b !== 'wslview', srt: async () => true, run: loggedIn, copilotBin: 'copilot',
    wsl: { version: 2, distro: 'Ubuntu' }, browser: () => '/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    vm: () => vmSupport({ platform: 'linux', wsl: { version: 2 }, exists: () => false }), folders: ['/home/alex/dev', '/mnt/c/Users/alex/dev'] });
  const by = (id) => list.find((c) => c.id === id);
  assert.ok(ready(list));
  assert.ok(by('wsl').ok);
  assert.match(by('wsl').detail, /127\.0\.0\.1:7777.*Windows browser/);
  assert.equal(by('wslview').fix.command, 'sudo apt install wslu');
  assert.match(by('calendar').detail, /no GNOME Online Accounts.*iCal/);
  assert.equal(by('browser').detail, 'msedge.exe (Windows)');
  assert.match(by('wsl-folders').detail, /\/mnt\/c\/Users\/alex\/dev.*~\/dev/);
  assert.ok(!by('vm').ok);
  assert.match(by('vm').detail, /nestedVirtualization.*outside/);
  assert.match(doctorText(list), /sudo apt install wslu/);
});

test('doctor under WSL1 is not ready, and says how to convert', async () => {
  const list = await checks({ platform: 'linux', env: {}, nodeVersion: '22.4.0', has: () => true, srt: async () => true, run: loggedIn, wsl: { version: 1, distro: 'Ubuntu' } });
  assert.ok(!ready(list));
  assert.equal(list.find((c) => c.id === 'wsl').fix.command, 'wsl --set-version Ubuntu 2   (in PowerShell)');
});

test('plain Linux shows no WSL checks', async () => {
  const list = await checks({ platform: 'linux', env: {}, nodeVersion: '22.4.0', has: () => true, srt: async () => true, run: loggedIn, wsl: null, folders: ['/mnt/c/x'] });
  assert.ok(!list.some((c) => /^wsl/.test(c.id)));
  assert.match(list.find((c) => c.id === 'calendar').detail, /GNOME Online Accounts/);
});
