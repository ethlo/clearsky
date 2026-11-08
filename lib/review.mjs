// A proper review of a change before it goes up as a pull request, by a fresh Copilot that knows
// only the goal and the code: no chat history, no reasoning from the session that wrote it. A
// chat asks for it with `review` (scripts/sandbox-bin/review, lib/broker.mjs); Clearsky works
// out the diff itself, reads the ticket itself, and runs the reviewer read only in the repo.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

const execFileP = promisify(execFile);

export const USAGE = `review [--base <branch>] [--ticket <KEY>] [--goal "<what the change is for>"]

A fresh reviewer, which knows only the goal and the code, reviews this branch's changes
against <base> (default: the repo's default branch), including uncommitted ones.
--ticket   the Jira ticket the change is for; Clearsky reads its summary and description
--goal     the goal in a sentence or two, when there's no ticket (at most 600 characters)
Findings come back most severe first, ending with VERDICT: ready or VERDICT: fix first.`;

export function parseReviewArgs(argv = []) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = argv[i + 1];
    if (a === 'help' || a === '--help' || a === '-h') return { help: true };
    if (a === '--base' && v) { o.base = v; i++; continue; }
    if (a === '--ticket' && v) { o.ticket = v.toUpperCase(); i++; continue; }
    if (a === '--goal' && v != null) { o.goal = v; i++; continue; }
    return { error: `unknown argument ${a}` };
  }
  if (o.base && !/^[\w./-]+$/.test(o.base)) return { error: 'bad --base' };
  if (o.ticket && !/^[A-Z][A-Z0-9_]+-\d+$/.test(o.ticket)) return { error: 'bad --ticket (like ABC-123)' };
  if (o.goal != null) {
    o.goal = String(o.goal).trim();
    if (o.goal.length > 600) return { error: '--goal is at most 600 characters: the goal, not how it was done' };
  }
  if (!o.ticket && !o.goal) return { error: 'say what the change is for: --ticket KEY, or --goal "…"' };
  return o;
}

const git = (cwd, args, run) => run('git', ['-C', cwd, ...args], { maxBuffer: 64 * 1024 * 1024, timeout: 60_000 }).then((r) => String(r.stdout));

// The change: this branch against where it left <base>, uncommitted edits and new files too.
export async function changeOf(cwd, base, { run = execFileP, maxChars = 400_000 } = {}) {
  if (!base) {
    const head = await git(cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], run).catch(() => '');
    base = head.trim().replace(/^origin\//, '') || 'main';
  }
  let from = null;
  for (const ref of [`origin/${base}`, base]) {
    from = (await git(cwd, ['merge-base', ref, 'HEAD'], run).catch(() => '')).trim();
    if (from) break;
  }
  if (!from) throw new Error(`can't find ${base} in this repo (try --base)`);
  const branch = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], run).catch(() => '')).trim();
  const tracked = await git(cwd, ['diff', '--no-color', '--find-renames', from], run);
  const stat = (await git(cwd, ['diff', '--stat=200', from], run)).trim();
  const untracked = (await git(cwd, ['ls-files', '--others', '--exclude-standard'], run)).split('\n').filter(Boolean);
  let added = '';
  for (const f of untracked.slice(0, 50)) {
    added += await git(cwd, ['diff', '--no-color', '--no-index', '/dev/null', f], run).catch((e) => String(e.stdout || ''));
  }
  let diff = `${tracked}${added}`;
  if (!diff.trim()) throw new Error(`nothing changed against ${base}`);
  const cut = diff.length > maxChars;
  if (cut) diff = diff.slice(0, maxChars);
  return { base, from, branch, stat, untracked, diff, cut };
}

// The base side of the change: the files it modifies, deletes or renames, as they were at the
// merge-base, written under `dir`. A reviewer often wants the old version of a file, and the
// obvious place for it (your main checkout, when the branch is in a worktree) is outside what
// it may read. Returns the paths written.
export async function writeBaseFiles(cwd, change, dir, { run = execFileP, max = 200 } = {}) {
  if (!change.from) return [];
  const names = (await git(cwd, ['diff', '--name-only', '--no-renames', '--diff-filter=MDT', change.from], run)).split('\n').filter(Boolean).slice(0, max);
  const done = [];
  for (const f of names) {
    const out = resolve(dir, f);
    if (!out.startsWith(`${resolve(dir)}${sep}`)) continue;
    try {
      const text = await git(cwd, ['show', `${change.from}:${f}`], run);
      await mkdir(dirname(out), { recursive: true });
      await writeFile(out, text);
      done.push(f);
    } catch { /* binary or gone: skip */ }
  }
  return done;
}

// Paths a permission request is about: Copilot puts them in rawInput or in locations.
const askedPaths = (tc = {}) => {
  const r = tc.rawInput || {};
  return [r.path, r.file, r.filePath, r.directory, ...(Array.isArray(r.paths) ? r.paths : []), ...(tc.locations || []).map((l) => l?.path)].filter((x) => typeof x === 'string' && x);
};
// Whether the reviewer may do what it asks: read, search or think, inside the repo or the
// base copies. Returns { ok, what } where `what` says in words what was asked, for the chat.
export function reviewDecision(p, roots) {
  const tc = p?.toolCall || {};
  const kind = tc.kind || 'other';
  const paths = askedPaths(tc);
  const inside = (x) => roots.some((r) => { const a = resolve(roots[0], x); return a === r || a.startsWith(`${r}${sep}`); });
  const ok = ['read', 'search', 'think'].includes(kind) && paths.every(inside);
  const outside = paths.filter((x) => !inside(x));
  const what = kind === 'read' || kind === 'search'
    ? `${kind === 'read' ? 'read' : 'search'} ${outside[0] || paths[0] || 'something'}${outside.length ? ' (outside the repo)' : ''}`
    : `${tc.title || kind}`;
  return { ok, what };
}

export function reviewPrompt({ goal, ticket, change, baseDir = null, baseFiles = [] }) {
  const target = ticket
    ? `Ticket ${ticket.key}${ticket.type ? ` (${ticket.type})` : ''}: ${ticket.summary}\n\n${ticket.description || '(no description)'}`
    : goal;
  return `You are reviewing a change before it is opened as a pull request. You get only the goal and the code. You know nothing about how it was written, and that is on purpose: judge the code, not intentions.

Review it properly, as a careful senior reviewer would:
- Does it do what the goal asks? Anything asked for that is missing or only half done?
- Correctness: bugs, wrong conditions, edge cases (empty, null, large, concurrent, retries, time zones), error handling that hides failures.
- Security: injection, secrets in code or logs, access checks, unsafe input handling.
- Compatibility: API, config, database or message format changes that break callers or need a migration.
- Tests: new behavior without tests, tests that don't really check what they claim.
Read the surrounding code in this repository when you need to. You can read and search files in this repository${baseFiles.length ? ` and in ${baseDir}` : ''}, nothing else: no commands, no git, no other folders. Anything else is refused, so don't ask for it.${baseFiles.length ? ` ${baseDir} holds the changed files as they were before this change, at the same paths, so compare against those instead of another checkout.` : ''} Don't comment on style or naming unless it hides a bug. Don't invent problems to have something to say.

Answer with a numbered list, most severe first. For each: severity (blocker, major or minor), file:line, what is wrong, a concrete case where it goes wrong, and the fix. If nothing is worth fixing, write "No findings." End with exactly one line: "VERDICT: ready" or "VERDICT: fix first".

## The goal
${target}

## The change (${change.branch || 'this branch'} against ${change.base})
${change.stat}${change.untracked.length ? `\nNew files not yet added to git (not in the PR until they are): ${change.untracked.join(', ')}` : ''}${change.cut ? '\n\n(The diff is cut short here; read the remaining changed files from the repository.)' : ''}

\`\`\`diff
${change.diff}
\`\`\`
`;
}
