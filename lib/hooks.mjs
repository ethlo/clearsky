// Your own hooks, like Claude Code's: commands Clearsky runs in a chat's sandbox when a turn
// ends, on the files the turn changed (Settings → Agent → Hooks).
// - After edits (AGENT_HOOK_AFTER_EDIT): a formatter or fixer, with the changed files as "$@"
//   (`npx prettier --write "$@"`, `./mvnw -q spotless:apply`). Its result is a note in the chat.
// - Before done (AGENT_HOOK_BEFORE_DONE): a check (`npm test`, `./mvnw -q verify -o`). When it
//   fails, the chat gets its output and is asked to fix it, at most AGENT_HOOK_RETRIES times
//   (default 2) per message of yours.
// They run in the chat's own sandbox (the same fence as the agent: its folders, no secrets,
// the network list), in its folder, with sh. A chat outside the sandbox runs none.

export const DEFAULT_RETRIES = 2;
export const TIMEOUT_MS = 10 * 60_000;

export function hooksConfig(env = process.env) {
  const afterEdit = String(env.AGENT_HOOK_AFTER_EDIT || '').trim();
  const beforeDone = String(env.AGENT_HOOK_BEFORE_DONE || '').trim();
  const n = Number(env.AGENT_HOOK_RETRIES);
  if (!afterEdit && !beforeDone) return null;
  return { afterEdit: afterEdit || null, beforeDone: beforeDone || null, retries: Number.isInteger(n) && n >= 0 && n <= 5 ? n : DEFAULT_RETRIES };
}

// The changed files a hook gets: those in the chat's folder, as paths relative to it, existing
// ones only (a deleted file can't be formatted), at most 200.
export function hookFiles(paths, cwd, exists) {
  const base = cwd.endsWith('/') ? cwd : `${cwd}/`;
  return [...new Set(paths)].filter((p) => p.startsWith(base) && exists(p)).map((p) => p.slice(base.length)).slice(0, 200);
}

// The end of a hook's output, for the chat and its note.
export function tail(text, lines = 40, bytes = 6000) {
  const t = String(text || '').trimEnd();
  const cut = t.length > bytes ? t.slice(-bytes) : t;
  return cut.split('\n').slice(-lines).join('\n');
}

// Run one hook: `run` is the sandbox's execFile (lib/app/chat-builds.mjs sandboxRun). Returns
// { code, out } (code 0: fine).
export async function runHook(run, command, files, { timeout = TIMEOUT_MS } = {}) {
  try {
    const r = await run('sh', ['-c', command, 'clearsky-hook', ...files], { timeout, maxBuffer: 8 * 1024 * 1024 });
    return { code: 0, out: `${r.stdout || ''}${r.stderr || ''}` };
  } catch (e) {
    return { code: e.killed ? 124 : typeof e.code === 'number' ? e.code : 1, out: `${e.stdout || ''}${e.stderr || ''}${e.killed ? '\n(stopped: it ran over 10 minutes)' : ''}` || e.message };
  }
}

// What the chat is told when its check fails.
export function failText(command, r, { tries, retries }) {
  return `[Clearsky] Your "before done" check \`${command}\` failed (exit ${r.code}) after this turn's changes. The end of its output:\n\`\`\`\n${tail(r.out)}\n\`\`\`\n`
    + `Fix what it found, then finish as before.${tries >= retries ? ' (This is the last time I run it for you this time.)' : ''}`;
}
