// The coding agent behind Clearsky's chats: GitHub Copilot CLI or Claude Code (CLEARSKY_AGENT,
// Settings → Copilot → Agent, or a team pack). Both speak the Agent Client Protocol (lib/acp.mjs),
// so a chat, its Allow/Deny cards, history and the sandbox work the same with either; what
// differs is here: how to find and start the agent, how Clearsky's modes map onto it, where it
// keeps its state and skills, and which hosts it needs.
//
//   copilot  `copilot --acp`, with Copilot's own flags for modes, model and effort.
//   claude   Claude Code through its ACP adapter, `claude-agent-acp`
//            (npm i -g @agentclientprotocol/claude-agent-acp), with Claude Code's own login.
//            Modes are ACP session modes; the model goes in ANTHROPIC_MODEL.
//
// Left empty, it is Copilot when the Copilot CLI is installed, else Claude Code when its adapter is.
// Usage and credits (lib/credit-usage.mjs) and Copilot's session log (lib/copilot-events.mjs)
// stay Copilot-only for now: with Claude Code those pages say so instead of guessing.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { homedir } from 'node:os';
import * as copilot from './copilot.mjs';

const onPath = (name, path = process.env.PATH || '') => {
  for (const dir of path.split(delimiter)) if (dir && existsSync(join(dir, name))) return join(dir, name);
  return null;
};
// `name` on PATH, else the newest one installed under nvm (npm -g puts it beside that Node).
export function findBin(name, set, home = homedir()) {
  if (set) return existsSync(set) || !set.includes('/') ? set : null;
  const hit = onPath(name);
  if (hit) return hit;
  const nvm = join(home, '.nvm', 'versions', 'node');
  if (!existsSync(nvm)) return null;
  return readdirSync(nvm).map((v) => join(nvm, v, 'bin', name)).filter((p) => existsSync(p))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] || null;
}

// Clearsky's modes as Claude Code's permission modes. Sandboxed runs everything inside srt, as
// with Copilot; Full access runs everything; Read only and Plan only plan without changing.
export const CLAUDE_MODES = { ask: 'default', sandboxed: 'bypassPermissions', full: 'bypassPermissions', read: 'plan', plan: 'plan' };
export const CLAUDE_MODELS = ['default', 'opus', 'sonnet', 'haiku'];
export const claudeModel = (m) => !!m && m !== 'default' && copilot.validModel(m) && (CLAUDE_MODELS.includes(m) || /^claude-/.test(m));

export const AGENTS = {
  copilot: {
    name: 'copilot', label: 'Copilot', product: 'GitHub Copilot CLI',
    find: (env = process.env) => copilot.findCopilot(env.COPILOT_BIN),
    install: { command: 'npm install -g @github/copilot', url: 'https://docs.github.com/copilot/how-tos/set-up/install-copilot-cli' },
    // Flags for a mode, model and effort, and the folders it may use without asking.
    args: ({ permission, model, effort, allow, deny, folders = [] }) => [...copilot.optionArgs({ permission, model, effort, allow, deny }), ...copilot.folderArgs(folders)],
    // Its ACP server is `copilot … --acp`; in the sandbox its built-in GitHub tools are off.
    acp: (args) => [...args, '--acp'],
    sandboxArgs: ['--disable-builtin-mcps'],
    env: () => ({}),
    sandboxEnv: () => ({}),
    sessionMode: () => null,
    state: ['~/.copilot', '~/.cache/copilot'],
    hosts: ['*.githubcopilot.com'],
    skillsDirs: (cwd, home = homedir()) => [join(cwd, '.github', 'skills'), join(home, '.copilot', 'skills')],
    personalSkills: (home = homedir()) => join(home, '.copilot', 'skills'),
    models: () => ['auto', ...copilot.recentModels().filter((m) => m !== 'auto')],
    efforts: copilot.EFFORTS,
    usage: true,
  },
  claude: {
    name: 'claude', label: 'Claude Code', product: 'Claude Code (through claude-agent-acp)',
    find: (env = process.env) => findBin('claude-agent-acp', env.CLAUDE_ACP_BIN),
    install: { command: 'npm install -g @agentclientprotocol/claude-agent-acp', url: 'https://github.com/agentclientprotocol/claude-agent-acp' },
    // No flags: the mode is an ACP session mode, the model an environment variable, and the
    // extra folders go with the session (additionalDirectories).
    args: () => [],
    acp: (args) => args,
    sandboxArgs: [],
    // Only Claude's own names: a Copilot model left in Settings ("gpt-5") isn't passed on.
    env: ({ model } = {}) => (claudeModel(model) ? { ANTHROPIC_MODEL: model } : {}),
    // In the sandbox only its own folder is writable, not files beside it in your home: its
    // settings file (~/.claude.json) moves into that folder, next to its login.
    sandboxEnv: (home = homedir()) => ({ CLAUDE_CONFIG_DIR: join(home, '.claude') }),
    sessionMode: (permission) => CLAUDE_MODES[permission] || 'default',
    state: ['~/.claude', '~/.cache/claude'],
    hosts: ['api.anthropic.com', 'claude.ai', '*.claude.ai', 'statsig.anthropic.com'],
    skillsDirs: (cwd, home = homedir()) => [join(cwd, '.claude', 'skills'), join(cwd, '.github', 'skills'), join(home, '.claude', 'skills')],
    personalSkills: (home = homedir()) => join(home, '.claude', 'skills'),
    models: () => CLAUDE_MODELS,
    efforts: [],
    usage: false,
  },
};
export const AGENT_NAMES = Object.keys(AGENTS);

// The agent in use: as set, else whichever is installed (Copilot first, as before).
export function agentName(env = process.env, { has = (n) => !!AGENTS[n].find(env) } = {}) {
  const v = String(env.CLEARSKY_AGENT || '').trim().toLowerCase();
  if (AGENTS[v]) return v;
  if (has('copilot')) return 'copilot';
  return has('claude') ? 'claude' : 'copilot';
}
export const agentOf = (env, opts) => AGENTS[agentName(env, opts)];
