// What Clearsky needs on this machine, what's there, and how to get the rest: `clearsky doctor`
// and the first-run welcome page (/welcome). Everything is found from the tools and their own
// logins (gh, acli), never a token, and the fix for each missing piece is given for this OS.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import { wslInfo, onWindowsDrive } from './wsl.mjs';

const execFileP = promisify(execFile);

// Run a command; never throws. missing: the command isn't installed.
export async function run(cmd, args, { timeout = 15_000, env = process.env } = {}) {
  try {
    const { stdout, stderr } = await execFileP(cmd, args, { timeout, env, windowsHide: true });
    return { ok: true, out: `${stdout}\n${stderr}`.trim() };
  } catch (e) {
    return { ok: false, missing: e.code === 'ENOENT', out: `${e.stdout || ''}\n${e.stderr || e.message}`.trim() };
  }
}

// Whether a command is on the PATH (with Windows' extensions).
export function onPath(name, { env = process.env, platform = process.platform } = {}) {
  const exts = platform === 'win32' ? (env.PATHEXT || '.EXE;.CMD;.BAT').split(';').map((x) => x.toLowerCase()) : [''];
  return (env.PATH || env.Path || '').split(delimiter).some((d) => d && exts.some((x) => existsSync(join(d, name + x))));
}

// How to install a tool here. The package manager is the OS's usual one; a link when there isn't one.
const INSTALL = {
  git: { linux: 'sudo apt install git', darwin: 'xcode-select --install', win32: 'winget install Git.Git', url: 'https://git-scm.com/downloads' },
  gh: { linux: 'sudo apt install gh', darwin: 'brew install gh', win32: 'winget install GitHub.cli', url: 'https://cli.github.com' },
  acli: { darwin: 'brew tap atlassian/homebrew-acli && brew install acli', url: 'https://developer.atlassian.com/cloud/acli/guides/install-acli/' },
  copilot: { all: 'npm install -g @github/copilot', url: 'https://github.com/github/copilot-cli' },
  srt: { all: 'npm install -g @anthropic-ai/sandbox-runtime', url: 'https://github.com/anthropic-experimental/sandbox-runtime' },
  'sandbox tools': { linux: 'sudo apt install bubblewrap socat ripgrep', darwin: 'brew install ripgrep' },
  wslu: { linux: 'sudo apt install wslu', url: 'https://wslu.wedotstud.io/wslu/' },
  wsl2: { all: 'wsl --set-version <distro> 2   (in PowerShell)', url: 'https://learn.microsoft.com/windows/wsl/install' },
  browser: { linux: 'sudo apt install chromium', darwin: 'brew install --cask google-chrome', win32: 'winget install Google.Chrome' },
  node: { all: 'nvm install 22', url: 'https://nodejs.org' },
};
// On Linux the hints say apt; with dnf or pacman instead, they say that.
export function installHint(tool, platform = process.platform, pm = 'apt') {
  const i = INSTALL[tool] || {};
  let command = i[platform] || i.all || '';
  if (platform === 'linux' && pm !== 'apt') command = command.replace('sudo apt install', pm === 'dnf' ? 'sudo dnf install' : pm === 'pacman' ? 'sudo pacman -S' : 'install');
  return { command, url: i.url || '' };
}

// Each check: { id, label, need: 'required'|'recommended'|'optional', ok, detail, fix? }.
// Injected helpers keep it testable: run (a command), has (on the PATH), srt (sandbox runtime
// importable), calendars (GNOME's), browser (a Chromium-based one), wsl (Windows' Linux, or
// null), vm (lib/vm.mjs vmSupport, or null to leave it out), folders (where Copilot works).
export async function checks({ platform = process.platform, env = process.env, nodeVersion = process.versions.node,
  run: r = run, has = (n) => onPath(n, { env, platform }), srt = srtInstalled, calendars = () => [], browser = () => null, acliBin = env.ACLI_BIN || 'acli', copilotBin = null,
  wsl = wslInfo({ platform, env }), vm = null, folders = [] } = {}) {
  const pm = platform !== 'linux' || has('apt-get') ? 'apt' : has('dnf') ? 'dnf' : has('pacman') ? 'pacman' : 'other';
  const fix = (tool) => ({ fix: installHint(tool, platform, pm) });
  const out = [];
  // Windows, through WSL: WSL2 only (WSL1 has no Linux kernel: no sandbox, no VM), and the Windows
  // browser for logins and links.
  if (wsl) {
    out.push({ id: 'wsl', label: 'WSL2 (Clearsky on Windows)', need: 'required', ok: wsl.version === 2,
      detail: wsl.version === 2 ? `${wsl.distro}; open http://127.0.0.1:7777 in your Windows browser` : `${wsl.distro} runs on WSL1, which Clearsky can't use`,
      ...(wsl.version === 2 ? {} : { fix: { ...installHint('wsl2', platform), command: `wsl --set-version ${wsl.distro} 2   (in PowerShell)` } }) });
    const wv = has('wslview');
    out.push({ id: 'wslview', label: 'Opens links in your Windows browser (wslview)', need: 'recommended', ok: wv,
      detail: wv ? 'logins and links open in Windows' : 'not found: links and logins still open through Windows (rundll32.exe); wslview is the steadier way', ...(wv ? {} : fix('wslu')) });
    const slow = [...new Set(folders.filter(onWindowsDrive))];
    if (slow.length) out.push({ id: 'wsl-folders', label: 'Your repos in the Linux home', need: 'recommended', ok: false,
      detail: `${slow.join(', ')} ${slow.length > 1 ? 'are' : 'is'} on a Windows drive: slow through WSL, and git sees files as changed. Clone them into ~/dev instead` });
  }
  const major = Number(String(nodeVersion).split('.')[0]);
  out.push({ id: 'node', label: 'Node 22 or newer', need: 'required', ok: major >= 22, detail: `Node ${nodeVersion}`, ...(major >= 22 ? {} : fix('node')) });
  const git = has('git');
  out.push({ id: 'git', label: 'git', need: 'required', ok: git, detail: git ? 'installed' : 'not found', ...(git ? {} : fix('git')) });

  // GitHub: the gh login is enough; a token only if you'd rather.
  const [gh, acli] = await Promise.all([r('gh', ['auth', 'status']), r(acliBin, ['jira', 'auth', 'status'])]);
  const ghUser = gh.out.match(/Logged in to \S+ (?:account|as) (\S+)/)?.[1] || null;
  const ghOk = gh.ok && !!ghUser;
  out.push({ id: 'gh', label: 'GitHub CLI, logged in', need: env.GITHUB_TOKEN ? 'optional' : 'required', ok: ghOk || !!env.GITHUB_TOKEN,
    detail: ghOk ? `logged in as ${ghUser}` : env.GITHUB_TOKEN ? 'using the token in your settings' : gh.missing ? 'gh not installed' : 'gh is not logged in', login: !gh.missing && !ghOk ? 'github' : null,
    ...(gh.missing ? fix('gh') : {}) });
  const site = acli.out.match(/[\w-]+\.atlassian\.net/)?.[0] || null;
  const acliOk = acli.ok && !/not (logged|authenticated)|no .*account/i.test(acli.out);
  out.push({ id: 'acli', label: 'Atlassian CLI, logged in (for Jira)', need: 'recommended', ok: acliOk,
    detail: acliOk ? `logged in${site ? ` to ${site}` : ''}` : acli.missing ? 'acli not installed' : 'acli is not logged in', login: !acli.missing && !acliOk ? 'jira' : null,
    ...(acli.missing ? fix('acli') : {}) });

  const cp = copilotBin || (has('copilot') ? 'copilot' : null);
  out.push({ id: 'copilot', label: 'GitHub Copilot CLI (for chats)', need: 'recommended', ok: !!cp, detail: cp ? 'installed' : 'not found', ...(cp ? {} : fix('copilot')) });

  // The sandbox: srt itself, plus what it uses on this OS.
  const srtOk = await srt();
  out.push({ id: 'srt', label: 'Sandbox runtime (srt)', need: 'recommended', ok: srtOk, detail: srtOk ? 'installed' : 'not installed: chats can only run in Ask mode', ...(srtOk ? {} : fix('srt')) });
  const tools = platform === 'linux' ? ['bwrap', 'socat', 'rg'] : platform === 'darwin' ? ['rg'] : [];
  const lacking = tools.filter((t) => !has(t));
  if (tools.length) {
    out.push({ id: 'sandbox-tools', label: 'What the sandbox uses', need: 'recommended', ok: !lacking.length,
      detail: lacking.length ? `missing: ${lacking.join(', ')}` : tools.join(', '), ...(lacking.length ? fix('sandbox tools') : {}) });
  } else if (platform === 'win32') {
    out.push({ id: 'sandbox-tools', label: 'What the sandbox uses', need: 'recommended', ok: srtOk, detail: 'Windows needs a one-time setup from an admin terminal: srt windows-install' });
  }

  // The calendar: GNOME Online Accounts on Linux, an iCal link anywhere.
  let cals = [];
  try { cals = calendars() || []; } catch { cals = []; }
  const ics = !!env.GOOGLE_CALENDAR_ICS;
  out.push({ id: 'calendar', label: 'Calendar', need: 'optional', ok: ics || cals.length > 0,
    detail: ics ? 'iCal link set' : cals.length ? `${cals.length} calendar(s) from GNOME Online Accounts` : wsl ? 'WSL has no GNOME Online Accounts: paste your calendar\'s iCal link in Settings → Google Calendar' : platform === 'linux' ? 'add your work account in GNOME Online Accounts, or paste an iCal link in Settings' : 'paste your calendar\'s iCal link in Settings → Google Calendar' });

  const b = browser();
  out.push({ id: 'browser', label: 'A Chromium-based browser (for its own window)', need: 'optional', ok: !!b,
    detail: b ? `${b.split(/[\\/]/).pop()}${wsl && /\.exe$/i.test(b) ? ' (Windows)' : ''}` : 'not found: Clearsky still works in any browser tab',
    ...(b ? {} : wsl ? { fix: { command: '', url: 'https://www.microsoft.com/edge' } } : fix('browser')) });

  // The VM, for chats' tests that need Docker (Testcontainers): KVM; under WSL2, nested virtualisation.
  if (vm) {
    let v;
    try { v = vm(); } catch (e) { v = { ok: false, why: e.message }; }
    out.push({ id: 'vm', label: 'A VM for builds that need Docker', need: 'optional', ok: !!v.ok,
      detail: v.ok ? 'KVM and QEMU are there' : `${v.why}. Without it, Copilot runs those builds with \`outside\`, after asking you` });
  }
  return out;
}

export async function srtInstalled() {
  try { await import('@anthropic-ai/sandbox-runtime'); return true; } catch { return false; }
}

// What can be filled in from your logins: your GitHub organizations (gh api, with gh's login)
// and your Jira site (acli). Nothing here needs a token.
export async function suggestions({ run: r = run, acliBin = process.env.ACLI_BIN || 'acli' } = {}) {
  const [orgs, acli] = await Promise.all([r('gh', ['api', 'user/orgs', '--jq', '.[].login']), r(acliBin, ['jira', 'auth', 'status'])]);
  return {
    orgs: orgs.ok ? orgs.out.split(/\s+/).filter((x) => /^[\w.-]+$/.test(x)) : [],
    jiraSite: acli.out.match(/[\w-]+\.atlassian\.net/)?.[0] || null,
  };
}

// Ready to use: everything required is there.
export const ready = (list) => list.filter((c) => c.need === 'required').every((c) => c.ok);

// For the terminal: one line per check, and the fix under what's missing.
export function doctorText(list) {
  const mark = (c) => (c.ok ? '✓' : c.need === 'required' ? '✗' : '·');
  const lines = [];
  for (const c of list) {
    lines.push(`${mark(c)} ${c.label}: ${c.detail}${!c.ok && c.need !== 'required' ? ` (${c.need})` : ''}`);
    if (!c.ok && c.fix?.command) lines.push(`    ${c.fix.command}`);
    else if (!c.ok && c.fix?.url) lines.push(`    ${c.fix.url}`);
    if (!c.ok && c.login) lines.push(`    log in from http://127.0.0.1:7777/welcome, or: ${c.login === 'github' ? 'gh auth login --web' : 'acli jira auth login --web'}`);
  }
  lines.push('', ready(list) ? 'Ready. Run clearsky serve and open http://127.0.0.1:7777' : 'Something required is missing (✗). Fix that first.');
  return lines.join('\n');
}
