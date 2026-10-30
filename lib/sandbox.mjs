// Running Copilot inside Anthropic's sandbox runtime (srt, npm @anthropic-ai/sandbox-runtime):
// bubblewrap on Linux, sandbox-exec on macOS. Copilot can then write only in your folders and
// reach only the hosts you list, and can't read secrets like ~/.ssh, whatever it's allowed to run.
// The network filter goes by host name only: an allowed host can be written to as well as read.

import { existsSync } from 'node:fs';
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

// Docker's socket would let anything in the sandbox start a container with your home mounted:
// out of reach (rootless Docker and Podman live under /run/user, hidden already).
const DOCKER_SOCKETS = ['/var/run/docker.sock', '/run/docker.sock', '/run/podman/podman.sock'];

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
// `maven` (lib/maven.mjs) and `github` (below): logins srt adds on the way out; their hosts are
// allowed, and HTTPS to them only is read by srt's proxy (with `ca`) so it can add the login.
export function srtSettings({ cwd, folders = [], home, read = [], domains = DEFAULT_DOMAINS, maven = null, github = null, ca = maven?.ca || github?.ca,
  platform = process.platform, uid = process.getuid?.(), exists = existsSync }) {
  const all = (list) => [...new Set(list.filter(Boolean).map((p) => expand(p, home)))];
  const write = all([cwd, ...folders, '~/.copilot', '~/.cache/copilot', '/tmp']);
  const linux = platform === 'linux';
  const logins = [maven && { read: maven.hosts, credentials: maven.credentials }, github].filter(Boolean);
  const allowed = [...new Set([...domains.filter(validDomain), ...logins.flatMap((l) => l.read)])];
  const readHosts = new Set(logins.flatMap((l) => l.read));
  return {
    network: { allowedDomains: allowed, deniedDomains: [], ...(linux && { allowAllUnixSockets: true }),
      ...(logins.length && ca && { tlsTerminate: { caCertPath: ca.cert, caKeyPath: ca.key, excludeDomains: allowed.filter((d) => !readHosts.has(d)) } }) },
    ...(logins.length && { credentials: { envVars: logins.flatMap((l) => l.credentials) } }),
    filesystem: {
      denyRead: [expand('~', home), ...all(SECRETS), ...(linux && uid != null ? [`/run/user/${uid}`] : []), ...DOCKER_SOCKETS.filter((p) => exists(p))],
      allowRead: all([cwd, ...folders, ...READ_DEFAULT, ...read]).filter((p) => exists(p)),
      allowWrite: write, denyWrite: [],
    },
  };
}

// Your GitHub login in the sandbox, without the sandbox holding it: inside, GH_TOKEN and
// COPILOT_GITHUB_TOKEN (and git's Authorization header) are stand-ins, and srt's proxy puts the
// real ones back on the way to GitHub. The values go into `env` (Clearsky's own environment,
// where srt reads them); `git` is the git setting that sends the header.
export const GITHUB_READ = ['github.com', '*.github.com', '*.githubcopilot.com'];
export function githubLogin(token, env, gitIndex) {
  const header = `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
  Object.assign(env, { GH_TOKEN: token, COPILOT_GITHUB_TOKEN: token, [`GIT_CONFIG_VALUE_${gitIndex}`]: header });
  const hosts = ['github.com', 'api.github.com', '*.githubcopilot.com'];
  const prefixed = { extract: '^(?:gh[a-z]_|github_pat_)?(.+)$', onExtractNoMatch: 'deny' };
  return {
    read: GITHUB_READ,
    git: ['http.https://github.com/.extraHeader', header],
    credentials: [
      { name: 'GH_TOKEN', mode: 'mask', injectHosts: hosts, ...prefixed },
      { name: 'COPILOT_GITHUB_TOKEN', mode: 'mask', injectHosts: hosts, ...prefixed },
      { name: `GIT_CONFIG_VALUE_${gitIndex}`, mode: 'mask', injectHosts: ['github.com'], extract: '^Authorization: Basic (\\S+)$', onExtractNoMatch: 'deny' },
    ],
  };
}

// srt as a library in Clearsky's own process, so its proxy can ask Clearsky about a request
// (`filterRequest`, lib/github-gate.mjs). One proxy for every chat; each chat's folders are
// applied when its command is wrapped. Returns the command to spawn instead of `bin args…`.
let srt = null, srtKey = null, srtReady = null;
const sh = (a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);
export async function sandboxedCommand(bin, args, opts, { filterRequest } = {}) {
  const { filesystem, ...session } = srtSettings(opts);
  srt ||= (await import('@anthropic-ai/sandbox-runtime')).SandboxManager;
  const key = JSON.stringify(session);
  const config = { ...session, filesystem, network: { ...session.network, ...(filterRequest && { filterRequest }) } };
  if (!srtReady) { srtKey = key; srtReady = srt.initialize(config); }
  await srtReady;
  if (key !== srtKey) { srtKey = key; srt.updateConfig(config); }
  const { argv } = await srt.wrapWithSandboxArgv([bin, ...args].map(sh).join(' '), undefined, { filesystem }, undefined, opts.cwd);
  return { bin: argv[0], args: argv.slice(1) };
}

// One sandboxed command has ended. On Linux srt protects some files (.bashrc, .gitconfig, .idea…)
// in Clearsky's own folder by mounting over them, creating empty ones where there were none;
// it removes them once no sandbox is running, counting one call per command.
export function sandboxEnded() {
  try { srt?.cleanupAfterCommand(); } catch { /* nothing to clean */ }
}

// Stop srt's proxy (Clearsky restarting, or a test done).
export async function stopSandbox() {
  if (srt && srtReady) { srtReady = null; srtKey = null; await srt.reset(); }
}
