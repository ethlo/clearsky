// Running Copilot inside Anthropic's sandbox runtime (srt, npm @anthropic-ai/sandbox-runtime):
// bubblewrap on Linux, sandbox-exec on macOS. Copilot can then write only in your folders and
// reach only the hosts you list, and can't read secrets like ~/.ssh, whatever it's allowed to run.
// The network filter goes by host name only: an allowed host can be written to as well as read.

import { writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

// Copilot's own service and GitHub, plus Jira Cloud sites (and Atlassian's login, for acli).
export const DEFAULT_DOMAINS = ['github.com', '*.github.com', '*.githubusercontent.com', '*.githubcopilot.com',
  '*.atlassian.net', 'api.atlassian.com', 'auth.atlassian.com'];

// Read nowhere near these, even in Full mode.
export const SECRETS = ['~/.ssh', '~/.gnupg', '~/.aws', '~/.azure', '~/.kube', '~/.docker/config.json', '~/.netrc', '~/.password-store',
  '~/.local/share/keyrings', '~/.config/clearsky', '~/.mozilla', '~/.config/google-chrome', '~/.config/chromium', '~/.config/BraveSoftware'];

const expand = (p, home) => resolve(p.replace(/^~(?=\/|$)/, home));
const validDomain = (d) => /^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+(:\d{1,5})?$/i.test(d);

export function parseDomains(v) {
  return String(v || '').split(/[\s,]+/).map((d) => d.trim()).filter(Boolean);
}
export const checkDomains = (list) => list.every(validDomain);

// The srt settings for one chat: write in the chat's folder, your folders, Copilot's own
// state and /tmp; read anything but the secrets; reach only the listed hosts.
//
// On Linux, srt's own Unix-socket filter needs a helper that Ubuntu's AppArmor rules for
// bubblewrap don't let run (no capabilities, and no way to grant them under "no new
// privileges"). So sockets aren't filtered there; instead your session's runtime folder
// (/run/user/<uid>: the D-Bus session bus, and with it the keyring) is hidden. Abstract sockets
// stay out of reach anyway, as the sandbox has its own network namespace.
export function srtSettings({ cwd, folders = [], home, domains = DEFAULT_DOMAINS, platform = process.platform, uid = process.getuid?.() }) {
  const write = [...new Set([cwd, ...folders, '~/.copilot', '/tmp'].filter(Boolean).map((p) => expand(p, home)))];
  const linux = platform === 'linux';
  return {
    network: { allowedDomains: domains.filter(validDomain), deniedDomains: [], ...(linux && { allowAllUnixSockets: true }) },
    filesystem: { denyRead: [...SECRETS.map((p) => expand(p, home)), ...(linux && uid != null ? [`/run/user/${uid}`] : [])], allowWrite: write, denyWrite: [] },
  };
}

// The command that runs `bin args…` inside the sandbox; the settings go to a private file per folder.
export function sandboxed(bin, args, { srt = 'srt', dir, ...opts }) {
  const settings = srtSettings(opts);
  const file = join(dir, `srt-${createHash('sha256').update(JSON.stringify(settings)).digest('hex').slice(0, 12)}.json`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  return { bin: srt, args: ['--settings', file, '--', bin, ...args], file };
}
