// Running Copilot inside Anthropic's sandbox runtime (srt, npm @anthropic-ai/sandbox-runtime):
// bubblewrap on Linux, sandbox-exec on macOS. Copilot can then write only in your folders and
// reach only the hosts you list, and can't read secrets like ~/.ssh, whatever it's allowed to run.
// The network filter goes by host name only: an allowed host can be written to as well as read.

import { writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

// Copilot's own service and GitHub, plus your Jira site (and Atlassian's login, for acli).
export const DEFAULT_DOMAINS = ['github.com', '*.github.com', '*.githubusercontent.com', '*.githubcopilot.com',
  'kezzler.atlassian.net', 'api.atlassian.com', 'auth.atlassian.com'];

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
export function srtSettings({ cwd, folders = [], home, domains = DEFAULT_DOMAINS }) {
  const write = [...new Set([cwd, ...folders, '~/.copilot', '/tmp'].filter(Boolean).map((p) => expand(p, home)))];
  return {
    network: { allowedDomains: domains.filter(validDomain), deniedDomains: [] },
    filesystem: { denyRead: SECRETS.map((p) => expand(p, home)), allowWrite: write, denyWrite: [] },
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
