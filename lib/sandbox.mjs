// Running Copilot inside Anthropic's sandbox runtime (srt, npm @anthropic-ai/sandbox-runtime):
// bubblewrap on Linux, sandbox-exec on macOS. Copilot can then write only in your folders and
// reach only the hosts you list, and can't read secrets like ~/.ssh, whatever it's allowed to run.
// The network filter goes by host name only: an allowed host can be written to as well as read.
// A host not on the list is held at the proxy while Clearsky asks you (lib/host-door.mjs).

import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { userInfo } from 'node:os';
import { clonesIn } from './chat-scope.mjs';
import { SAFE_GIT } from './safe-git.mjs';
import { wslInfo, WSL_HIDDEN } from './wsl.mjs';
import { untilde } from './util.mjs';

// Copilot's own service and GitHub, plus Jira Cloud sites (and Atlassian's login, for acli).
// Claude Code's hosts are added when it is the agent (lib/agents.mjs, `hosts`).
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

// Sockets other programs keep in /tmp. The sandbox may write /tmp, and on Linux srt's socket
// filter is off (see srtSettings), so a chat could talk to them, and several do what they're told
// by whoever connects: the X server (keys and clicks into your other windows), a terminal
// multiplexer or an editor's server (commands), an ssh agent (your keys). Hidden from the chat:
// the folders such programs use, so one that starts later is hidden too, and every socket that is
// in /tmp, or in a folder there, when the chat starts. `keep`: Clearsky's and srt's own.
// Still reachable: a socket another program makes straight in /tmp while the chat runs.
const SOCKET_FOLDERS = (uid, user) => ['.X11-unix', '.ICE-unix', '.XIM-unix', '.font-unix', `tmux-${uid}`, `emacs${uid}`, `nvim.${user}`, 'screens', 'uscreens'];
const OURS = /^(claude-|srt-)/;
const names = (d, max) => { try { return readdirSync(d).slice(0, max); } catch { return []; } };
const kindOf = (p) => { try { const s = lstatSync(p); return s.isSocket() ? 'socket' : s.isDirectory() ? 'folder' : ''; } catch { return ''; } };
export function tmpSockets({ tmp = '/tmp', uid = process.getuid?.(), user = (() => { try { return userInfo().username; } catch { return ''; } })(),
  keep = [], max = 100, ls = names, kind = kindOf } = {}) {
  const kept = (p) => keep.some((k) => k && (p === k || p.startsWith(`${k}/`) || k.startsWith(`${p}/`)));
  const out = new Set(SOCKET_FOLDERS(uid, user).map((n) => join(tmp, n)).filter((p) => kind(p) === 'folder'));
  for (const n of ls(tmp, 5000)) {
    const p = join(tmp, n), k = OURS.test(n) ? '' : kind(p);
    if (k === 'socket' || (k === 'folder' && !out.has(p) && ls(p, 200).some((m) => kind(join(p, m)) === 'socket'))) out.add(p);
  }
  return [...out].filter((p) => !kept(p)).slice(0, max);
}

// What Copilot may read in your home besides your folders (Settings → Agent adds to it):
// Node (nvm), JDKs and build caches, and your git settings. The agent's own state (`state`,
// ~/.copilot for Copilot, ~/.claude for Claude Code) is readable and writable as well.
export const COPILOT_STATE = ['~/.copilot', '~/.cache/copilot'];
export const READ_DEFAULT = ['~/.nvm', '~/.m2', '~/.gradle', '~/.sdkman', '~/.jdks',
  '~/.gitconfig', '~/.config/git', '~/.npm', '~/.local/bin'];

const expand = (p, home) => resolve(untilde(p, home));

// What a chat can't change in the folders it works in, because it would run a program later,
// outside the sandbox, when you or your editor use the repo, without showing in any diff:
//  - every clone's git hooks and git settings (a hook, or core.fsmonitor, runs on your next
//    `git status`), and those of its submodules;
//  - in the chat's own clone, editor and agent settings that git doesn't track (REPO_GUARDED):
//    editor tasks, MCP servers, an agent's local settings.
// srt keeps such files from being written in the folder it is started from, but Clearsky runs
// srt as a library from its own folder, so each chat's folders are named here. Two limits, both
// from trying it: only what exists is named (a denied path that isn't there shows up in the
// sandbox as an odd empty file, and `git add -A` fails on it), and files git tracks are left
// alone (git couldn't switch branch or pull when they differ; and a change to one shows in the diff).
// A clone with no hooks folder gets an empty one, so that there is something to keep closed.
export const REPO_GUARDED = ['.mcp.json', '.vscode', '.idea', '.claude/settings.json', '.claude/settings.local.json',
  '.claude/commands', '.claude/agents', '.github/hooks'];
const GIT_GUARDED = ['hooks', 'config'];
// A clone's git folder; for a worktree (whose .git is a file) the main clone's, where the hooks
// and settings it uses are. null when it can't be read.
export function gitFolder(dir) {
  try {
    const dot = join(dir, '.git');
    if (statSync(dot).isDirectory()) return dot;
    const own = resolve(dir, readFileSync(dot, 'utf8').match(/^gitdir: (.+)$/m)[1].trim());
    try { return resolve(own, readFileSync(join(own, 'commondir'), 'utf8').trim()); } catch { return own; }
  } catch { return null; }
}
// Which of `paths` (in the clone at `dir`) hold files git tracks; null when git can't say.
export function trackedPaths(dir, paths) {
  try {
    const out = execFileSync('git', ['-C', dir, ...SAFE_GIT, 'ls-files', '-z', '--', ...paths], { encoding: 'utf8', timeout: 3000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    const files = out.split('\0').filter(Boolean);
    return new Set(paths.filter((p) => files.some((f) => f === p || f.startsWith(`${p}/`))));
  } catch { return null; }
}
const subfolders = (d, max = 50) => { try { return readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).slice(0, max).map((e) => join(d, e.name)); } catch { return []; } };
const makeFolder = (d) => { try { mkdirSync(d, { recursive: true }); } catch { /* not ours to make */ } };
export function repoGuards(roots, { cwd = null, exists = existsSync, clones = clonesIn, git = gitFolder, tracked = trackedPaths, make = makeFolder,
  modules = (g) => subfolders(join(g, 'modules')).flatMap((m) => [m, ...subfolders(m, 10)]) } = {}) {
  const out = new Set();
  for (const root of roots) {
    for (const dir of clones(root)) {
      const g = git(dir);
      // A submodule's git folder (under .git/modules) has hooks and settings of its own.
      for (const folder of g ? [g, ...modules(g).filter((m) => exists(join(m, 'config')))] : []) {
        if (!exists(join(folder, 'hooks'))) make(join(folder, 'hooks'));
        for (const f of GIT_GUARDED) out.add(join(folder, f));
      }
    }
  }
  if (cwd && clones(cwd)[0] === cwd) {
    const there = REPO_GUARDED.filter((f) => exists(join(cwd, f)));
    const kept = there.length ? tracked(cwd, there) : new Set();
    for (const f of kept ? there : []) if (!kept.has(f)) out.add(join(cwd, f));
  }
  return [...out].filter((p) => exists(p));
}

const validDomain = (d) => /^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+(:\d{1,5})?$/i.test(d);

export function parseDomains(v) {
  return String(v || '').split(/[\s,]+/).map((d) => d.trim()).filter(Boolean);
}
export const checkDomains = (list) => list.every(validDomain);

// The srt settings for one chat: read and write in the chat's folder and your folders; in the
// rest of your home read only `read` (READ_DEFAULT plus Settings), never the secrets; write
// also the agent's own state (`state`) and /tmp; reach only the listed hosts. Outside your home (system
// files, JDKs in /usr/lib/jvm) reading is allowed.
//
// Not written, though they lie in folders that are: what repoGuards() finds in the chat's
// folders, the agent's own settings (`protect`: its MCP servers, skills and the like, which would
// run or steer it the next time it starts outside the sandbox), and Clearsky's run folder (`run`:
// the door's socket and the Maven settings; the socket still connects). Of `protect`, only what
// exists: a settings file that isn't there yet can still be made by the chat (srt would put an
// empty file there for as long as a chat runs, which your other sessions of the agent would read).
//
// On Linux, srt's own Unix-socket filter needs a helper that Ubuntu's AppArmor rules for
// bubblewrap don't let run (no capabilities, and no way to grant them under "no new
// privileges"). So sockets aren't filtered there; instead your session's runtime folder
// (/run/user/<uid>: the D-Bus session bus, and with it the keyring) is hidden, and so are other
// programs' sockets in /tmp (tmpSockets). Abstract sockets stay out of reach anyway, as the
// sandbox has its own network namespace.
// `maven` (lib/maven.mjs) and `github` (below): logins srt adds on the way out; their hosts are
// allowed, and HTTPS to them only is read by srt's proxy (with `ca`) so it can add the login.
// `inspect`: more hosts whose HTTPS the proxy reads, so the gate can see what goes there (Docker Hub).
export function srtSettings({ cwd, folders = [], home, read = [], state = COPILOT_STATE, domains = DEFAULT_DOMAINS, maven = null, github = null, ca = maven?.ca || github?.ca, inspect = [],
  protect = [], run = null, guards = repoGuards, sockets = tmpSockets,
  platform = process.platform, uid = process.getuid?.(), exists = existsSync, wsl = wslInfo({ platform }) }) {
  const all = (list) => [...new Set(list.filter(Boolean).map((p) => expand(p, home)))];
  const write = all([cwd, ...folders, ...state, '/tmp']);
  const stateDirs = new Set(all(state));
  const guarded = [...guards(all([cwd, ...folders]).filter((p) => !stateDirs.has(p)), { cwd: expand(cwd, home), exists }), ...all([...protect, run]).filter((p) => exists(p))];
  const linux = platform === 'linux';
  const logins = [maven?.credentials?.length && { read: maven.hosts, credentials: maven.credentials }, github].filter(Boolean);
  const allowed = [...new Set([...domains.filter(validDomain), ...logins.flatMap((l) => l.read), ...inspect])];
  const readHosts = new Set([...logins.flatMap((l) => l.read), ...inspect]);
  return {
    network: { allowedDomains: allowed, deniedDomains: [], ...(linux && { allowAllUnixSockets: true }),
      ...((logins.length || inspect.length) && ca && { tlsTerminate: { caCertPath: ca.cert, caKeyPath: ca.key, excludeDomains: allowed.filter((d) => !readHosts.has(d)) } }) },
    ...(logins.length && { credentials: { envVars: logins.flatMap((l) => l.credentials) } }),
    filesystem: {
      denyRead: [expand('~', home), ...all(SECRETS), ...(linux && uid != null ? [`/run/user/${uid}`] : []), ...DOCKER_SOCKETS.filter((p) => exists(p)), ...(wsl ? WSL_HIDDEN.filter((p) => exists(p)) : []),
        ...(linux ? sockets({ uid, keep: all([run, cwd, ...folders, ...state]) }) : [])],
      allowRead: all([cwd, ...folders, ...state, ...READ_DEFAULT, ...read]).filter((p) => exists(p)),
      allowWrite: write, denyWrite: [...new Set(guarded)],
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
// `askHost({ host, port })`: a host not on the list, held at the proxy until it answers true or
// false (lib/host-door.mjs). Without it such hosts are simply blocked.
let srt = null, srtKey = null, srtReady = null, askHost = null, current = null;
// What the running proxy lets through, and whether it reads HTTPS (then requests can be judged).
export const sandboxNetwork = () => ({ allowed: current?.allowedDomains || [], readsHttps: !!current?.tlsTerminate });
const sh = (a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);
export async function sandboxedCommand(bin, args, opts, { filterRequest, ask } = {}) {
  // A folder of the agent's settings that isn't there yet (named with a / at the end) is made
  // empty first: only what exists can be kept closed, and an empty one changes nothing.
  for (const p of opts.protect || []) if (p.endsWith('/')) makeFolder(expand(p, opts.home));
  const { filesystem, ...session } = srtSettings(opts);
  srt ||= (await import('@anthropic-ai/sandbox-runtime')).SandboxManager;
  const key = JSON.stringify(session);
  const config = { ...session, filesystem, network: { ...session.network, ...(filterRequest && { filterRequest }) } };
  if (ask) askHost = ask;
  if (!srtReady) { srtKey = key; srtReady = srt.initialize(config, (p) => (askHost ? askHost(p) : Promise.resolve(false))); }
  await srtReady;
  if (key !== srtKey) { srtKey = key; srt.updateConfig(config); }
  current = session.network;
  const { argv } = await srt.wrapWithSandboxArgv([bin, ...args].map(sh).join(' '), undefined, { filesystem }, undefined, opts.cwd);
  return lowPriority(argv, opts);
}

// The sandbox fences files and network, not CPU: what runs in it (a full Maven build, say) runs
// on this machine, as you. At low priority (`nice`), your own work comes first. `nice: 0` keeps
// normal priority.
export const SANDBOX_NICE = 10;
const NICE_BIN = ['/usr/bin/nice', '/bin/nice'];
export function lowPriority(argv, { nice = SANDBOX_NICE, platform = process.platform, exists = existsSync } = {}) {
  const bin = nice > 0 && platform !== 'win32' && NICE_BIN.find((b) => exists(b));
  return bin ? { bin, args: ['-n', String(nice), ...argv] } : { bin: argv[0], args: argv.slice(1) };
}

// Where a program in the sandbox finds srt's proxy, and its login, for programs that don't read
// HTTPS_PROXY (Maven, lib/maven.mjs). On Linux the sandbox has its own network, and srt listens
// for it on a fixed port inside; elsewhere it's the proxy's own port. null before srt has started.
export const SANDBOX_PROXY_PORT_LINUX = 3128;
export async function sandboxProxyLogin(platform = process.platform) {
  if (!srtReady) return null;
  await srtReady;
  const port = platform === 'linux' ? SANDBOX_PROXY_PORT_LINUX : srt.getProxyPort();
  return port ? { host: 'localhost', port, token: srt.getProxyAuthToken() || null } : null;
}

// srt's proxy, for Clearsky's VM (lib/vm.mjs): the same allowed hosts, logins added on the way
// out and GitHub gate as the sandbox. null until a sandbox has started.
export async function sandboxProxy() {
  if (!srtReady) return null;
  await srtReady;
  const port = srt.getProxyPort(), token = srt.getProxyAuthToken();
  return port ? { port, url: `http://${token ? `srt:${token}@` : ''}` } : null;
}

// srt's stand-ins for masked logins (`fake_value_…`), as the sandbox sees them: for programs that
// run where srt can't set them, Clearsky's VM (lib/vm.mjs), whose traffic goes through the same
// proxy, which swaps them for the real values on the way to the login's hosts. Asking srt's
// registry again returns the stand-in it already gave out. {} before srt has started.
export function maskedEnv(credentials = [], env = process.env) {
  const registry = srtReady && srt?.getSentinelRegistry?.();
  if (!registry) return {};
  return Object.fromEntries(credentials.filter((c) => c.mode === 'mask' && !c.extract && env[c.name])
    .map((c) => [c.name, registry.register(c.name, env[c.name], c.injectHosts || [])]));
}

// One sandboxed command has ended. On Linux srt protects some files (.bashrc, .gitconfig, .idea…)
// in Clearsky's own folder by mounting over them, creating empty ones where there were none;
// it removes them once no sandbox is running, counting one call per command.
export function sandboxEnded() {
  try { srt?.cleanupAfterCommand(); } catch { /* nothing to clean */ }
}

// Stop srt's proxy (Clearsky restarting, or a test done).
export async function stopSandbox() {
  if (srt && srtReady) { srtReady = null; srtKey = null; askHost = null; current = null; await srt.reset(); }
}
