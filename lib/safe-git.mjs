// git in a folder a chat can write. A repo's own settings name programs git runs by itself: a
// file-system monitor (core.fsmonitor), clean/smudge filters, diff drivers and text converters.
// A sandboxed chat can write those settings (in a repo it makes, or a folder laid out like one),
// so when Clearsky runs `git diff` there as you, outside the sandbox, the chat's program would
// run outside the sandbox too.
//
// Two answers, used in lib/app/chat-outputs.mjs:
// - while the chat's sandbox is up, git runs inside it (the same fence the chat has);
// - otherwise git runs here with the settings below, and not at all in a repo whose own settings
//   name a program (`localPrograms`).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

// No file-system monitor, no hooks, and a plain folder that looks like a bare repo isn't one.
export const SAFE_GIT = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'safe.bareRepository=explicit', '-c', 'diff.external='];
// For `git diff` and `git show`: no diff programs or text converters either.
export const SAFE_DIFF = ['--no-ext-diff', '--no-textconv'];

// Settings in the repo's own config (and what it includes) that make git run a program on a
// diff or status. Yours in ~/.gitconfig (git-lfs, say) don't count: they are yours.
const RUNS = /^(core\.(fsmonitor|sshcommand|pager|editor|alternaterefscommand)|diff\.external|diff\..+\.(textconv|command)|filter\..+\.(clean|smudge|process)|merge\..+\.driver|include\.path|includeif\..+\.path)$/i;
const OFF = /^(|false|no|off|0)$/i;
export async function localPrograms(dir, { run = execFileP } = {}) {
  let out = '';
  try { out = String((await run('git', ['-C', dir, ...SAFE_GIT, 'config', '--local', '--includes', '--null', '--list'], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 })).stdout); } catch { return []; }
  const found = [];
  for (const entry of out.split('\0')) {
    const nl = entry.indexOf('\n');
    const key = (nl < 0 ? entry : entry.slice(0, nl)).trim(), value = nl < 0 ? '' : entry.slice(nl + 1).trim();
    if (!RUNS.test(key)) continue;
    if (/^core\.fsmonitor$/i.test(key) && (OFF.test(value) || /^(true|yes|on|1)$/i.test(value))) continue; // git's own monitor, or none
    found.push(key);
  }
  return [...new Set(found)];
}
