// New tasks get their own chat. When a chat decides on new work (a follow-up ticket it created,
// a separate bug it found), Copilot doesn't start on it there: it ends its answer with a
// ```new-task block, and Clearsky shows a card that asks "Start in a new chat" (the default) or
// "Continue here" (web/js/50-chat.js). A new chat gets the ticket and the block's short hand-off,
// so the first chat stays about its own work and each task has a chat of its own.

// What every chat is told, next to the ```choices hint.
export const NEW_TASK_HINT = 'New work gets its own chat. When we decide on a new task (a follow-up ticket you created or I asked for, '
  + 'a separate bug we found, work that belongs to another ticket), don\'t start on it in this chat. Finish or pause what this chat is about, '
  + 'then end your answer with this block, which I see as a card:\n'
  + '```new-task\nticket: ABC-123\ntitle: What the new task is, in one line\nrepo: owner/name\n'
  + 'The hand-off for the new chat, in a few lines: what we decided and why, where to look, what is already done, what to avoid.\n```\n'
  + 'Leave out the ticket line when there is no ticket (or use owner/name#12 for a GitHub issue or PR), and the repo line when you don\'t know it. '
  + 'Write the hand-off for a chat that has seen nothing of this one: facts only, no plans of your own beyond what we decided. '
  + 'The card asks me to start it in a new chat (the default) or to continue here; then stop and wait. '
  + 'If I continue here, carry on with it in this chat. Create a ticket only when I asked for one.';

const KEY = /^[A-Z][A-Z0-9_]+-\d+$/;
const REPO = /^[\w-][\w.-]*\/[\w-][\w.-]*$/;
const SKILL = /^[\w][\w.-]{0,63}$/;
const line = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

// A ticket key, owner/name#12, or a PR/issue/Jira link, as a ref the chat can attach.
export function taskRef(text) {
  const t = String(text || '').trim();
  let m = t.match(/github\.com\/([\w.-]+\/[\w.-]+)\/(pull|issues)\/(\d+)/);
  if (m) return { kind: m[2] === 'pull' ? 'pr' : 'gh', repo: m[1], number: Number(m[3]) };
  m = t.match(/^([\w-][\w.-]*\/[\w-][\w.-]*)#(\d+)$/);
  if (m) return { kind: 'gh', repo: m[1], number: Number(m[2]) };
  m = t.match(/\/browse\/([A-Z][A-Z0-9_]+-\d+)/i) || t.match(/^([A-Z][A-Z0-9_]+-\d+)$/i);
  return m ? { kind: 'issue', key: m[1].toUpperCase() } : null;
}
export const refLabel = (r) => (!r ? '' : r.kind === 'issue' ? r.key : `${r.repo}#${r.number}`);

// "ticket: …", "title: …", "repo: …" lines (any order, at the top), then the hand-off.
export function parseNewTask(body) {
  const out = { ref: null, title: '', repo: null, handoff: '' };
  const rest = [];
  let head = true;
  for (const raw of String(body || '').replace(/\r\n/g, '\n').split('\n')) {
    const m = head && raw.match(/^\s*(ticket|title|repo)\s*:\s*(.*?)\s*$/i);
    if (m) {
      const k = m[1].toLowerCase();
      if (k === 'ticket') out.ref = taskRef(m[2]);
      else if (k === 'title') out.title = line(m[2], 200);
      else if (REPO.test(m[2])) out.repo = m[2];
      continue;
    }
    if (raw.trim()) head = false;
    if (!head) rest.push(raw.trimEnd());
  }
  out.handoff = rest.join('\n').trim().slice(0, 4000);
  if (!out.repo && out.ref?.repo) out.repo = out.ref.repo;
  if (!out.title) out.title = refLabel(out.ref) || line(out.handoff.split('\n')[0], 120);
  return out;
}

// What the page sends when you start one: checked again here, as everything from the page is.
export function cleanNewTask(t) {
  if (!t || typeof t !== 'object') return null;
  const ref = t.ref?.kind === 'issue' ? (KEY.test(t.ref.key || '') ? { kind: 'issue', key: t.ref.key } : null)
    : (t.ref?.kind === 'pr' || t.ref?.kind === 'gh') && REPO.test(t.ref.repo || '') && Number.isInteger(Number(t.ref.number)) && Number(t.ref.number) > 0
      ? { kind: t.ref.kind, repo: t.ref.repo, number: Number(t.ref.number) } : null;
  const title = line(t.title, 200);
  if (!ref && !title) return null;
  const out = { ref, title, repo: REPO.test(t.repo || '') ? t.repo : ref?.repo || null, from: line(t.from, 120) };
  // From the start box: the skill you picked ('' for none) and anything you added.
  if (typeof t.skill === 'string') out.skill = SKILL.test(t.skill) ? t.skill : '';
  const note = String(t.note ?? '').trim().slice(0, 4000);
  if (note) out.note = note;
  return out;
}

// The new chat's first message: the task, the hand-off, and how to start.
export function newTaskPrompt(t, handoff, { skills = [] } = {}) {
  const label = refLabel(t.ref);
  // The skill you picked in the start box (when it is one you have), or the usual one.
  const skill = typeof t.skill === 'string' ? (skills.includes(t.skill) ? t.skill : null)
    : skills.includes('feature-delivery') ? 'feature-delivery' : skills.includes('continue-work') ? 'continue-work' : null;
  return [
    `This is a new task that came up in another chat${t.from ? ` ("${t.from}")` : ''}. It gets a chat of its own, so that one stays about its own work.`,
    '',
    `Task: ${[label, t.title && t.title !== label ? t.title : ''].filter(Boolean).join(' ')}`,
    t.repo && `Repository: ${t.repo}`,
    '',
    'Hand-off from that chat:',
    String(handoff || '').trim() || '(none)',
    '',
    t.note && `My extra instructions: ${t.note}`,
    t.note && '',
    skill ? `Use the ${skill} skill to start on it.` : 'Start on it: find where the work goes, make a branch, and carry on as usual.',
    'Another chat may be working in this repository: if this folder has changes of its own or is on another task\'s branch, don\'t switch it or touch those changes. '
      + 'Make a git worktree next to it for this task\'s branch (`git worktree add ../<repo>-<key> -b <branch> <base>`) and work there.',
  ].filter((l) => l !== null && l !== undefined && l !== false).join('\n');
}
