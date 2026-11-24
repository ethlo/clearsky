// A worktree per chat: a new chat about a PR, ticket or new task gets a git worktree of its
// own next to your clone (`<clone>-<branch>`), as Claude Code's parallel sessions do, so two
// chats in one repo don't switch each other's branch or mix their changes, and your clone stays
// on whatever you have checked out. Settings → Agent → Worktrees (AGENT_WORKTREES=off turns it off).
//
// git runs here, as you, in a folder chats can write: with SAFE_GIT (no hooks, no fsmonitor),
// and not at all in a repo whose own config names a program (lib/safe-git.mjs).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { SAFE_GIT, localPrograms } from './safe-git.mjs';

const execFileP = promisify(execFile);
export const worktreesOn = () => process.env.AGENT_WORKTREES !== 'off';

// A folder name from a branch or task name: "feature/PAY-12 refunds" → "feature-PAY-12-refunds".
export const slug = (s) => String(s || '').replace(/[^\w.-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60) || 'chat';

// The first free "<clone>-<name>", "<clone>-<name>-2", … next to the clone.
export function freePath(clone, name, exists = existsSync) {
  const base = join(dirname(clone), `${basename(clone)}-${slug(name)}`);
  for (let i = 1; i < 100; i++) { const p = i === 1 ? base : `${base}-${i}`; if (!exists(p)) return p; }
  return null;
}

// The worktree for a new chat, or { dir: clone } when the clone itself is the place (its branch
// is the one asked for), or { dir: null, why } when Clearsky can't make one (the chat then runs
// in the clone, as before). `branch`: the PR's branch; none: a detached worktree at the default
// branch, for a new task (`name` names its folder) that makes its own branch there.
export async function chatWorktree({ clone, branch = null, name = null, run = execFileP, exists = existsSync }) {
  const git = (args, timeout = 30_000) => run('git', ['-C', clone, ...SAFE_GIT, ...args], { timeout, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).then((r) => String(r.stdout).trim());
  if ((await localPrograms(clone, { run })).length) return { dir: null, why: 'its git config runs programs of its own' };
  const current = await git(['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => '');
  if (branch && branch === current) return { dir: clone, why: 'your clone is on that branch' };
  const path = freePath(clone, branch || name, exists);
  if (!path) return { dir: null, why: 'no free folder name' };
  try {
    if (branch) {
      const local = await git(['rev-parse', '--verify', '-q', `refs/heads/${branch}`]).then(() => true, () => false);
      if (local) await git(['worktree', 'add', '-q', path, branch], 120_000);
      else {
        await git(['fetch', '-q', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], 120_000);
        await git(['worktree', 'add', '-q', '--track', '-b', branch, path, `origin/${branch}`], 120_000);
      }
    } else {
      const base = await git(['rev-parse', '--verify', '-q', 'refs/remotes/origin/HEAD']).then(() => 'origin/HEAD', () => 'HEAD');
      await git(['worktree', 'add', '-q', '--detach', path, base], 120_000);
    }
    return { dir: path, made: true };
  } catch (e) {
    return { dir: null, why: String(e.stderr || e.message).trim().split('\n').pop().slice(0, 200) };
  }
}
