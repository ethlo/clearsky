// Talk to the GitHub Copilot CLI installed on this machine, one prompt at a time.
// It runs with your own Copilot login; Clearsky only passes the prompt and options.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';

export const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

// What Copilot may do while answering. Denials win over --allow-all-tools, which the CLI
// needs to run without asking.
export const PERMISSIONS = {
  read: { label: 'Read only', args: ['--allow-all-tools', '--deny-tool', 'shell', '--deny-tool', 'write'] },
  plan: { label: 'Plan only', args: ['--allow-all-tools', '--mode', 'plan', '--deny-tool', 'shell', '--deny-tool', 'write'] },
  // Copilot reviews each tool call itself and only runs the ones it judges safe.
  assisted: { label: 'Assisted (Copilot approves each step)', args: ['--assisted-approval'] },
  edit: { label: 'Can edit files', args: ['--allow-all-tools', '--deny-tool', 'shell'] },
  full: { label: 'Full (edit + run commands)', args: ['--allow-all-tools'] },
};

// `copilot` on PATH, else the newest one installed under nvm (it's often under another Node version).
export function findCopilot(bin, home = homedir()) {
  if (bin) return existsSync(bin) || !bin.includes('/') ? bin : null;
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (dir && existsSync(join(dir, 'copilot'))) return join(dir, 'copilot');
  }
  const nvm = join(home, '.nvm', 'versions', 'node');
  if (!existsSync(nvm)) return null;
  const found = readdirSync(nvm).map((v) => join(nvm, v, 'bin', 'copilot')).filter((p) => existsSync(p))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return found[0] || null;
}

// Models you've used recently in Copilot (from its JSON-with-comments config).
export function recentModels(home = homedir()) {
  try {
    const text = readFileSync(join(home, '.copilot', 'config.json'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const ids = JSON.parse(text).recentModelIds;
    return Array.isArray(ids) ? ids.filter((m) => typeof m === 'string') : [];
  } catch { return []; }
}

// Skills Copilot can use from `cwd`, as `copilot skill list` reports them ("  name - description"
// under "Personal skills:", "Builtin skills:" and so on).
export function parseSkillList(text) {
  const out = [];
  let group = '';
  for (const line of text.split('\n')) {
    const h = line.match(/^(\S.*?)\s*skills?:\s*$/i);
    if (h) { group = h[1].trim(); continue; }
    const m = line.match(/^\s+([\w.:-]+)\s+-\s+(.*)$/);
    if (m && !out.some((s) => s.name === m[1])) out.push({ name: m[1], description: m[2].trim(), group });
  }
  return out;
}

// Fallback when the CLI can't list them: read SKILL.md files directly.
export function listSkills(dirs) {
  const out = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const file = join(dir, name, 'SKILL.md');
      if (!existsSync(file)) continue;
      const front = readFileSync(file, 'utf8').match(/^---\n([\s\S]*?)\n---/)?.[1] || '';
      const field = (k) => front.match(new RegExp(`^${k}:\\s*(.+)$`, 'm'))?.[1]?.trim();
      if (!out.some((s) => s.name === (field('name') || name))) out.push({ name: field('name') || name, description: field('description') || '' });
    }
  }
  return out;
}

export const validModel = (m) => !m || /^[\w.:-]{1,80}$/.test(m);

// Tool patterns like shell(git:*), write(src/**), url(github.com) or MyMcp(tool).
export const validPattern = (p) => typeof p === 'string' && /^[\w.-]+(\([^()\n]{0,200}\))?$/.test(p);

// Build the argument list for one turn of a conversation.
export function copilotArgs({ prompt, session, resume, model, effort, permission = 'read', allow = [], deny = [], cwd }) {
  const args = ['-p', prompt, '-s', '--no-ask-user', '--output-format', 'text', '--stream', 'on', '--no-color'];
  args.push(...(PERMISSIONS[permission] || PERMISSIONS.read).args);
  for (const t of allow.filter(validPattern)) args.push('--allow-tool', t);
  for (const t of deny.filter(validPattern)) args.push('--deny-tool', t);
  if (session) args.push(...(resume ? ['--resume', session] : ['--session-id', session]));
  if (model) args.push('--model', model);
  if (effort && EFFORTS.includes(effort)) args.push('--reasoning-effort', effort);
  if (cwd) args.push('-C', cwd);
  return args;
}

// Run one turn, calling onData with each chunk of the answer. Returns a function that stops it.
export function runCopilot(bin, args, { env, onData, onEnd, timeoutMs = 5 * 60_000 }) {
  const child = spawn(bin, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
  child.stdout.on('data', (d) => onData(d.toString()));
  child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
  child.on('error', (e) => { clearTimeout(timer); onEnd({ code: -1, stderr: e.message }); });
  child.on('close', (code, signal) => { clearTimeout(timer); onEnd({ code: code ?? (signal ? -1 : 0), stderr }); });
  return () => child.kill('SIGTERM');
}
