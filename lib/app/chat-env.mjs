// What a chat runs with: the agent's program and home, the folders and repos a chat may use, the
// environment it starts with, and the chats that are running now.
import { readFileSync, mkdirSync, statSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { delimiter } from 'node:path';
import * as localState from '../state.mjs';
import * as copilot from '../copilot.mjs';
import { fileRoots } from '../file-refs.mjs';
import * as memory from '../memory.mjs';
import * as chatScope from '../chat-scope.mjs';
import { untilde } from '../util.mjs';
import { canSandbox } from '../doctor.mjs';
import { agentFor, AGENTS, AGENT_NAMES } from '../agents.mjs';
import { appDir, stateFile, list, config, tracker, backend, installedAgents, whenSettingsChange, plugins } from './config.mjs';
import { execFileP } from './services.mjs';
import { sourceCache } from './work.mjs';

// ---------------------------------------------------------------- which agent, and where it works

// The agent a chat runs in: the one it started in, else the one its rule picks.
export const sessionAgent = (id) => localState.sessionAgents(stateFile)[id] || sessionsCache?.data.find((x) => x.id === id)?.agent || null;
export const chatAgent = (id, { cwd, repos = [] } = {}) => sessionAgent(id) || agentFor({ cwd, repos: [...repos, ...(cwd ? gitRepos(cwd) || [] : [])] }, process.env);

// Where a session works: Copilot's own session folder says; for Claude Code, the session's folder.
export function workspaceInfo(id, cwd) {
  const out = {};
  if (sessionAgent(id) && sessionAgent(id) !== 'copilot') {
    if (!cwd) return out;
    const repo = gitRepos(cwd)?.[0];
    let branch = null;
    try { branch = execFileSync('git', ['-C', cwd, 'branch', '--show-current'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; } catch { /* not a repo */ }
    return { ...(repo && { repository: repo }), ...(branch && { branch }) };
  }
  try {
    for (const line of readFileSync(join(copilotHome(), 'session-state', id, 'workspace.yaml'), 'utf8').split('\n')) {
      const m = line.match(/^(repository|branch|client_name):\s*["']?([^"'\s]+)["']?\s*$/);
      if (m) out[m[1]] = m[2];
    }
  } catch { /* no workspace file */ }
  return out;
}

export const copilotCwd = () => {
  const d = untilde(process.env.AGENT_CWD || '');
  try { if (d && statSync(d).isDirectory()) return d; } catch { /* gone: use Clearsky's folder */ }
  return appDir;
};
let copilotInfoCache = null;
whenSettingsChange(({ otherAgent }) => { copilotInfoCache = null; if (otherAgent) forgetSessions(); });

export async function copilotInfo(force) {
  if (!force && copilotInfoCache && Date.now() - copilotInfoCache.at < 10 * 6e4) return copilotInfoCache.data;
  const b = backend();
  const bin = b.find();
  let skills = [];
  if (bin && b.name === 'copilot') {
    try {
      const { stdout } = await execFileP(bin, ['skill', 'list'], { cwd: copilotCwd(), timeout: 20_000, env: copilotEnv() });
      skills = copilot.parseSkillList(stdout);
    } catch { /* fall back to the files below */ }
  }
  // Copilot lists its own; the other agents' come from their folders, as a chat may run in any.
  const listed = skills.length ? ['copilot'] : [];
  for (const x of copilot.listSkills(installedAgents().filter((n) => !listed.includes(n)).flatMap((n) => AGENTS[n].skillsDirs(copilotCwd())))) if (!skills.some((y) => y.name === x.name)) skills.push(x);
  const about = (a) => ({ name: a.name, label: a.label, product: a.product, install: a.install, usage: a.usage, available: !!a.find(), models: a.models(), efforts: a.efforts });
  const data = {
    // Any agent will do: a chat goes to the one installed when its rule names that one.
    available: AGENT_NAMES.some((n) => AGENTS[n].find()), bin, cwd: copilotCwd(), skills,
    agent: about(b),
    // Every agent, for the chat's agent picker; `rules`: whether Settings sends some chats to another.
    agents: AGENT_NAMES.map((n) => about(AGENTS[n])),
    rules: AGENT_NAMES.some((n) => process.env[`AGENT_${n.toUpperCase()}_FOR`]),
    models: b.models(),
    efforts: b.efforts,
    permissions: Object.fromEntries(Object.entries(copilot.PERMISSIONS).map(([k, v]) => [k, v.label])),
    permissionHints: Object.fromEntries(Object.entries(copilot.PERMISSIONS).map(([k, v]) => [k, v.hint || ''])),
    // What a new chat starts with (Settings → Agent); the chat's pickers override them.
    // `fallbackPermission`: the access mode when neither Settings nor your last pick names one.
    defaults: { model: process.env.AGENT_MODEL || '', effort: process.env.AGENT_EFFORT || '', permission: process.env.AGENT_PERMISSION || '', fallbackPermission: fallbackPermission() },
  };
  copilotInfoCache = { at: Date.now(), data };
  return data;
}

// ---------------------------------------------------------------- what a chat starts with

// A chat's access mode when nothing names one: Sandboxed where the sandbox can run, else Ask.
let sandboxHere = null;
export const fallbackPermission = () => ((sandboxHere ??= canSandbox()) ? 'sandboxed' : 'ask');
export const defaultPermission = () => process.env.AGENT_PERMISSION || fallbackPermission();

// Copilot's own scratch folder, instead of /tmp: inside its sandbox and its trusted folders, so
// a temporary file doesn't ask. Files older than a week go at startup.
let scratch = null;
export function copilotTmp() {
  if (scratch) return scratch;
  scratch = process.env.AGENT_TMP || join(homedir(), '.cache', 'clearsky', 'tmp');
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  for (const f of readdirSync(scratch)) {
    try { if (Date.now() - statSync(join(scratch, f)).mtimeMs > 7 * 864e5) rmSync(join(scratch, f), { recursive: true, force: true }); } catch { /* in use or gone */ }
  }
  return scratch;
}

// Copilot signs in on its own; don't hand it Clearsky's tokens.
// copilot and srt start with `#!/usr/bin/env node`, and the app menu's PATH has no nvm Node:
// put this Node and copilot's own folder (often another nvm version) first.
export function copilotEnv(b = backend()) {
  const env = { ...process.env };
  env.TMPDIR = env.TMP = env.TEMP = copilotTmp();
  // Java ignores TMPDIR (Maven, Gradle, tests)
  env.JAVA_TOOL_OPTIONS = `${env.JAVA_TOOL_OPTIONS ? `${env.JAVA_TOOL_OPTIONS} ` : ''}-Djava.io.tmpdir=${copilotTmp()}`;
  for (const k of ['GITHUB_TOKEN', 'GH_TOKEN', 'SLACK_TOKEN', 'GOOGLE_CALENDAR_ICS', 'CALENDAR_ICS_URL']) delete env[k];
  for (const p of plugins.sources.values()) for (const [k, f] of Object.entries(p.settings || {})) if (f.secret) delete env[k];
  const bin = b.find();
  const dirs = [bin?.includes('/') && dirname(bin), dirname(process.execPath)].filter(Boolean);
  // acli that sends Jira text as ADF, so a description in wiki markup or Markdown shows formatted
  // (scripts/acli-bin; in the sandbox, the broker does it).
  const acliBin = join(appDir, 'scripts', 'acli-bin');
  env.CLEARSKY_ACLI = config.jira.acli;
  // Where the wrapper asks whether a ticket's PR has a reviewer before it goes to review (lib/review-gate.mjs).
  env.CLEARSKY_URL = `http://127.0.0.1:${config.port}`;
  // `ticket …` for any tracker (scripts/ticket-bin, lib/tracker.mjs).
  env.CLEARSKY_TRACKER = tracker();
  env.PATH = [...new Set([acliBin, join(appDir, 'scripts', 'ticket-bin'), ...dirs, ...(env.PATH || '').split(delimiter).filter(Boolean)])].join(delimiter);
  return env;
}

export const copilotHome = () => process.env.CLEARSKY_COPILOT_HOME || join(homedir(), '.copilot');

// ---------------------------------------------------------------- running chats, their folders and repos

// Ask-mode chats keep a Copilot process running between turns, keyed by Copilot's session id.
export const acpChats = new Map();

// Inside the sandbox ssh can't get out, so git talks to GitHub over https, sending the login
// header srt fills in (lib/sandbox.mjs, githubLogin) instead of asking a credential helper.
// A clone's git settings can't be written in the sandbox (lib/sandbox.mjs, repoGuards), so a
// branch's upstream isn't saved: a plain `git push` pushes the branch you're on, by its name, and
// a new branch doesn't try to save one (which would only print an error).
export const SANDBOX_GIT = [['url.https://github.com/.insteadOf', 'git@github.com:'], ['url.https://github.com/.insteadOf', 'ssh://git@github.com/'],
  ['credential.https://github.com.helper', ''], ['push.default', 'current'], ['branch.autoSetupMerge', 'false']];
// Folders added to one chat in its side panel (lib/chat-folders.mjs), as absolute paths.
export const folderNotes = new Map(); // chat → what to tell its Copilot about a folder you added
export const chatFolders = (id) => (id ? (localState.sessionFolders(stateFile)[id] || []).filter(isDir) : []);
// What a chat can read, for the files you point it at with @ (lib/file-refs.mjs): its folder,
// Settings → Agent's folders (read-write and read only) and the folders added to it.
export const chatReadRoots = (id, cwd) => fileRoots([cwd || acpChats.get(id)?.cwd || copilotCwd(), ...copilotFolders(), ...list(process.env.AGENT_READ), ...chatFolders(id)], homedir());
// What the sandbox may read besides your folders: Settings → Agent → Also readable, and
// Clearsky's own folder (its acli for the sandbox).
// Copilot's memory (lib/memory.mjs) is readable in the sandbox, not writable: notes go in through your Save.
export const sandboxOpts = (cwd, extra = []) => ({ cwd, folders: [...copilotFolders(), ...extra, copilotTmp()], home: homedir(), read: [...list(process.env.AGENT_READ), appDir, memory.memoryDir()] });
export function ghToken() {
  try { return execFileSync('gh', ['auth', 'token'], { timeout: 10_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; } catch { return null; }
}

export const chatRef = (c) => ({ id: c.id });

// The GitHub repos a chat works on: those of its folder's git remotes (or, when it started in a
// folder of clones, those whose branch is named after one of its tickets), the PRs it was started
// about, and the ones you allowed in it. The remotes are the ones the folder had when the chat
// started (lib/chat-scope.mjs): the chat can write there, so a remote or clone it adds later
// asks first. Which branch a clone is on is looked up again after a minute.
export const remoteRepo = (url) => (/github/i.test(url) && (url.match(/[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/) || [])[1]?.toLowerCase()) || null;
export function gitRepos(dir) {
  try {
    const out = execFileSync('git', ['-C', dir, 'remote', '-v'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\n').map((l) => remoteRepo(l.split(/\s+/)[1] || '')).filter(Boolean);
  } catch { return null; }
}
export const gitReposLater = (dir) => execFileP('git', ['-C', dir, 'remote', '-v'], { timeout: 5000 })
  .then((r) => String(r.stdout).split('\n').map((l) => remoteRepo(l.split(/\s+/)[1] || '')).filter(Boolean), () => null);
// Clones of a repo where a push's commits may be: working chats' folders, and the clones (and
// worktrees) in your code folders (Settings → Agent), since a chat may cd into one to push.
export function cloneDirs(repo) {
  const r = repo?.toLowerCase(), out = [];
  const roots = [...[...acpChats.values()].filter((c) => c.busy).flatMap((c) => [c.cwd, ...chatFolders(c.id)]), ...copilotFolders().map((d) => untilde(d))];
  for (const root of new Set(roots)) for (const d of chatScope.clonesIn(root)) if ((gitRepos(d) || []).includes(r)) out.push(d);
  return [...new Set(out)];
}
export function chatRepos(c) {
  if (!c.known || Date.now() - c.known.at > 60_000) {
    const refs = localState.sessionRefs(stateFile)[c.id] || [];
    const tickets = new Set([...c.tickets, ...refs.filter((k) => k.startsWith('issue:')).map((k) => k.slice(6))]);
    const set = chatScope.scopeRepos(c.scope, { tickets, branch: (path) => chatScope.headBranch(join(c.cwd, path)) });
    for (const k of refs) { const m = k.match(/^(?:pr|gh):([\w.-]+\/[\w.-]+)#/); if (m) set.add(m[1].toLowerCase()); }
    c.known = { at: Date.now(), repos: set };
  }
  return new Set([...c.known.repos, ...c.repos]);
}

export const tildeHome = (p) => (p && p.startsWith(homedir()) ? `~${p.slice(homedir().length)}` : p);

// The chat a sandbox door request comes from, by the key its Copilot was given.
export const chatByKey = (key) => typeof key === 'string' && key ? [...acpChats.values()].find((c) => c.agent.brokerKey === key) : null;

// ---------------------------------------------------------------- the list of chats, as last read

// The list of chats as the agents last gave it (copilotSessions), kept half a minute.
export let sessionsCache = null;
export const keepSessions = (data) => { sessionsCache = { at: Date.now(), data }; };
export const forgetSessions = () => { sessionsCache = null; };

// ---------------------------------------------------------------- your code folders

// The local clone of a GitHub repository, so Copilot can work in it: a folder under
// CLEARSKY_CODE_DIRS (default ~/dev), up to three levels down, whose origin is that repo.
export const codeDirs = () => (process.env.CLEARSKY_CODE_DIRS || join(homedir(), 'dev')).split(':').filter(Boolean);
export function findCheckout(repo, roots = codeDirs()) {
  const name = repo.split('/')[1]?.toLowerCase();
  const matches = (dir) => {
    try { return new RegExp(`[:/]${repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\.git)?\\s*$`, 'im').test(readFileSync(join(dir, '.git', 'config'), 'utf8')); } catch { return false; }
  };
  const walk = (dir, depth) => {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules'); } catch { return null; }
    for (const e of entries) if (e.name.toLowerCase() === name && matches(join(dir, e.name))) return join(dir, e.name);
    if (depth > 0) for (const e of entries) { const hit = walk(join(dir, e.name), depth - 1); if (hit) return hit; }
    return null;
  };
  for (const root of roots) { const hit = walk(root, 2); if (hit) return hit; }
  return null;
}

// The worktree of a clone that has this branch checked out, if there is one
// (read from .git/worktrees/*/HEAD and gitdir, so no git process is needed).
export function worktreeFor(clone, branch) {
  if (!branch) return null;
  const base = join(clone, '.git', 'worktrees');
  let names = [];
  try { names = readdirSync(base); } catch { return null; }
  for (const n of names) {
    try {
      if (readFileSync(join(base, n, 'HEAD'), 'utf8').trim() !== `ref: refs/heads/${branch}`) continue;
      const dir = dirname(resolve(base, n, readFileSync(join(base, n, 'gitdir'), 'utf8').trim()));
      if (statSync(dir).isDirectory()) return dir;
    } catch { /* a stale worktree entry */ }
  }
  return null;
}

// The head branch of a PR, from what the GitHub source last fetched.
export function prBranch(ref) {
  if (ref.branch) return ref.branch;
  const gh = sourceCache.get('github')?.data || {};
  return [...(gh.myPrs || []), ...(gh.reviewRequested || [])].find((p) => p.repo === ref.repo && p.number === ref.number)?.branch || null;
}

export const isDir = (d) => { try { return typeof d === 'string' && d.startsWith('/') && statSync(d).isDirectory(); } catch { return false; } };

// Commands the sandbox's doors run without asking, like a Jira transition (Settings → Agent).
export const assistedAllow = () => list(process.env.AGENT_ASSISTED_ALLOW);
// Folders Copilot chats may use without asking: Settings, else your code folders (~/dev).
export const copilotFolders = () => (process.env.AGENT_FOLDERS ? list(process.env.AGENT_FOLDERS) : codeDirs());
