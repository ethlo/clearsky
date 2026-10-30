// Running Copilot inside Anthropic's sandbox runtime (srt, npm @anthropic-ai/sandbox-runtime):
// bubblewrap on Linux, sandbox-exec on macOS. Copilot can then write only in your folders and
// reach only the hosts you list, and can't read secrets like ~/.ssh, whatever it's allowed to run.
// The network filter goes by host name only: an allowed host can be written to as well as read.

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

// Copilot's own service and GitHub, plus Jira Cloud sites (and Atlassian's login, for acli).
export const DEFAULT_DOMAINS = ['github.com', '*.github.com', '*.githubusercontent.com', '*.githubcopilot.com',
  '*.atlassian.net', 'api.atlassian.com', 'auth.atlassian.com'];

// Read nowhere near these, even in Full mode.
export const SECRETS = ['~/.ssh', '~/.gnupg', '~/.aws', '~/.azure', '~/.kube', '~/.docker/config.json', '~/.netrc', '~/.password-store',
  '~/.local/share/keyrings', '~/.config/clearsky', '~/.mozilla', '~/.config/google-chrome', '~/.config/chromium', '~/.config/BraveSoftware',
  // Tokens people paste into commands, and CLI logins kept in files.
  '~/.bash_history', '~/.zsh_history', '~/.local/share/fish/fish_history', '~/.python_history', '~/.node_repl_history',
  '~/.git-credentials', '~/.npmrc', '~/.pypirc', '~/.config/gh', '~/.config/acli', '~/.config/gcloud',
  // Repository passwords: builds in the sandbox use what's cached (and the hosts you allow).
  '~/.m2/settings.xml', '~/.m2/settings-security.xml', '~/.gradle/gradle.properties'];

// What Copilot may read in your home besides your folders (Settings → Copilot adds to it):
// its own state, Node (nvm), JDKs and build caches, and your git settings.
export const READ_DEFAULT = ['~/.copilot', '~/.cache/copilot', '~/.nvm', '~/.m2', '~/.gradle', '~/.sdkman', '~/.jdks',
  '~/.gitconfig', '~/.config/git', '~/.npm', '~/.local/bin'];

const expand = (p, home) => resolve(p.replace(/^~(?=\/|$)/, home));
const validDomain = (d) => /^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+(:\d{1,5})?$/i.test(d);

export function parseDomains(v) {
  return String(v || '').split(/[\s,]+/).map((d) => d.trim()).filter(Boolean);
}
export const checkDomains = (list) => list.every(validDomain);

// The srt settings for one chat: read and write in the chat's folder and your folders; in the
// rest of your home read only `read` (READ_DEFAULT plus Settings), never the secrets; write
// also Copilot's own state and /tmp; reach only the listed hosts. Outside your home (system
// files, JDKs in /usr/lib/jvm) reading is allowed.
//
// On Linux, srt's own Unix-socket filter needs a helper that Ubuntu's AppArmor rules for
// bubblewrap don't let run (no capabilities, and no way to grant them under "no new
// privileges"). So sockets aren't filtered there; instead your session's runtime folder
// (/run/user/<uid>: the D-Bus session bus, and with it the keyring) is hidden. Abstract sockets
// stay out of reach anyway, as the sandbox has its own network namespace.
export function srtSettings({ cwd, folders = [], home, read = [], domains = DEFAULT_DOMAINS, platform = process.platform, uid = process.getuid?.(), exists = existsSync }) {
  const all = (list) => [...new Set(list.filter(Boolean).map((p) => expand(p, home)))];
  const write = all([cwd, ...folders, '~/.copilot', '~/.cache/copilot', '/tmp']);
  const linux = platform === 'linux';
  return {
    network: { allowedDomains: domains.filter(validDomain), deniedDomains: [], ...(linux && { allowAllUnixSockets: true }) },
    filesystem: {
      denyRead: [expand('~', home), ...all(SECRETS), ...(linux && uid != null ? [`/run/user/${uid}`] : [])],
      allowRead: all([cwd, ...folders, ...READ_DEFAULT, ...read]).filter((p) => exists(p)),
      allowWrite: write, denyWrite: [],
    },
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

// Whether srtSettings lets the sandbox read `p` (an absolute path): outside your home yes, inside
// only what's opened and not a secret. Assisted uses it to let reading commands run unasked.
export function sandboxReadable(settings, p) {
  const under = (x, r) => x === r || x.startsWith(r.endsWith('/') ? r : `${r}/`);
  const { denyRead, allowRead } = settings.filesystem;
  const [home, ...secrets] = denyRead;
  if (secrets.some((r) => under(p, r))) return false;
  return !under(p, home) || allowRead.some((r) => under(p, r));
}
