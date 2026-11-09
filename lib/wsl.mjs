// Windows, through WSL2: Clearsky runs in a Linux distro (Ubuntu) and you use it from Windows,
// in a Windows browser at http://127.0.0.1:7777 (WSL2 forwards localhost). What differs there:
// links and logins open in the Windows browser (wslview, else rundll32.exe), the app window is
// Windows' Edge or Chrome, there's no GNOME (calendar from an iCal link, notifications in the
// page), and the VM needs nested virtualisation. All of it is found here, testable with fakes.
//
// CLEARSKY_WSL=1|2 makes any Linux look like WSL1/WSL2 (for tests and trying the hints out);
// CLEARSKY_WSL=0 makes WSL look like plain Linux.

import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { delimiter, join } from 'node:path';

const readText = (f) => { try { return readFileSync(f, 'utf8'); } catch { return ''; } };

// { version: 1|2, distro } under WSL, else null. WSL2's kernel says "microsoft-standard-WSL2"
// (or at least "microsoft" in lower case); WSL1 has no Linux kernel and says "Microsoft".
export function wslInfo({ platform = process.platform, env = process.env, release = readText('/proc/sys/kernel/osrelease'), version = readText('/proc/version') } = {}) {
  if (platform !== 'linux') return null;
  const distro = env.WSL_DISTRO_NAME || '';
  if (env.CLEARSKY_WSL === '0') return null;
  if (env.CLEARSKY_WSL === '1' || env.CLEARSKY_WSL === '2') return { version: Number(env.CLEARSKY_WSL), distro: distro || 'Ubuntu' };
  const text = `${release} ${version}`;
  if (!/microsoft|wsl/i.test(text) && !env.WSL_INTEROP && !distro) return null;
  const v = /WSL2|microsoft-standard/i.test(text) || env.WSL_INTEROP ? 2 : /Microsoft/.test(text) ? 1 : 2;
  return { version: v, distro: distro || 'your distro' };
}

const onPath = (bin, env) => (env.PATH || '').split(delimiter).some((d) => d && existsSync(join(d, bin)));

// The command that opens a URL in the Windows browser: wslview (from wslu, Ubuntu's own helper),
// else Windows' rundll32.exe through interop, which takes the URL as it is (no shell to read &).
export function wslOpenCommand({ env = process.env, has = (b) => onPath(b, env) } = {}) {
  if (has('wslview')) return ['wslview'];
  return ['rundll32.exe', 'url.dll,FileProtocolHandler'];
}

// The Windows browsers on the C: drive, seen from WSL: Edge first (every Windows has it).
export const WINDOWS_BROWSERS = [
  ['Microsoft Edge', 'Program Files (x86)/Microsoft/Edge/Application/msedge.exe'],
  ['Microsoft Edge', 'Program Files/Microsoft/Edge/Application/msedge.exe'],
  ['Google Chrome', 'Program Files/Google/Chrome/Application/chrome.exe'],
  ['Google Chrome', 'Program Files (x86)/Google/Chrome/Application/chrome.exe'],
  ['Brave', 'Program Files/BraveSoftware/Brave-Browser/Application/brave.exe'],
];
export function windowsBrowser({ drive = '/mnt/c', exists = existsSync } = {}) {
  for (const [, p] of WINDOWS_BROWSERS) if (exists(`${drive}/${p}`)) return `${drive}/${p}`;
  return null;
}
export const isWindowsExe = (p) => /\.exe$/i.test(String(p || ''));

// A Windows folder for the app window's browser profile: a Windows browser can't keep its
// profile in the Linux home. %LOCALAPPDATA%\Clearsky\app-window, else none (your own profile).
export function windowsProfileDir({ run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }) } = {}) {
  try {
    const local = run('cmd.exe', ['/d', '/c', 'echo %LOCALAPPDATA%']).trim();
    return /^[A-Za-z]:\\/.test(local) ? `${local}\\Clearsky\\app-window` : null;
  } catch { return null; }
}

// Folders on a Windows drive (/mnt/c/...): slow to read through WSL, and git sees every file as
// changed (modes, line ends). Repos belong in the Linux home, ~/dev say.
export const onWindowsDrive = (p) => /^\/mnt\/[a-z](\/|$)/i.test(String(p || ''));

// Why the VM can't run under WSL2, in words that say what to do about it.
export function wslVmWhy(wsl, why) {
  if (!wsl) return why;
  if (wsl.version === 1) return 'WSL1 has no KVM: convert the distro to WSL2 (wsl --set-version <distro> 2 in PowerShell)';
  if (/^no permission/.test(why)) return `${why}: sudo usermod -aG kvm $USER, then wsl --shutdown in PowerShell and open Ubuntu again`;
  if (/^no \/dev\/kvm/.test(why)) return 'no /dev/kvm in WSL2: on Windows 11, set nestedVirtualization=true under [wsl2] in %UserProfile%\\.wslconfig and run wsl --shutdown (Windows 10 can\'t)';
  return why;
}

// For gh and acli logins (`--web`): under WSL, open the login in the Windows browser. Both look
// at BROWSER; yours wins when it's set.
export function loginEnv(env = process.env, { wsl = wslInfo({ env }), has = (b) => onPath(b, env) } = {}) {
  if (!wsl || env.BROWSER || !has('wslview')) return env;
  return { ...env, BROWSER: 'wslview' };
}

// What the sandbox hides under WSL, on top of what it hides on any Linux: the Windows drives
// (/mnt/c holds your Windows profile, its browsers' data and everything else of yours; /mnt/wsl
// and /mnt/wslg are WSL's own) and /run/WSL, whose interop socket would let a sandboxed command
// start a Windows program (cmd.exe, powershell.exe) outside the sandbox. Folders you give Copilot
// on a Windows drive are allowed back by allowRead.
export const WSL_HIDDEN = ['/mnt', '/run/WSL'];
