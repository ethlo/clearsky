// Hand-offs: PRs and tickets you hand to Copilot to work on by itself, one at a time, in the
// sandbox (never outside it), now or from your next meeting. Each becomes an ordinary Copilot
// chat you can open, and ends with a draft PR waiting under "Not read by you", or a short note
// on what it needs from you. The sandbox and its doors decide what it may do; nothing here
// judges commands. Kept in ~/.config/clearsky/handoffs.json.

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

export const MAX_KEEP = 50;
const STATUSES = new Set(['queued', 'working', 'needs-you', 'done', 'blocked', 'failed', 'stopped', 'cancelled']);

export function readHandoffs(file) {
  try { const l = JSON.parse(readFileSync(file, 'utf8')); return Array.isArray(l) ? l.filter((h) => h && STATUSES.has(h.status)) : []; } catch { return []; }
}
export function saveHandoffs(file, list) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(list.slice(-MAX_KEEP), null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  return list;
}

const label = (r) => (r.kind === 'issue' ? r.key : `${r.repo}#${r.number}`);
const same = (a, b) => a.kind === b.kind && (a.kind === 'issue' ? a.key === b.key : a.repo === b.repo && Number(a.number) === Number(b.number));
const open = (h) => ['queued', 'working', 'needs-you'].includes(h.status);

// A PR, GitHub issue or Jira ticket, as the page sends it.
export function cleanRef(r) {
  if (r?.kind === 'issue' && /^[A-Z][A-Z0-9_]+-\d+$/.test(r.key || '')) return { kind: 'issue', key: r.key, title: String(r.title || '').slice(0, 200) };
  if ((r?.kind === 'pr' || r?.kind === 'gh') && /^[\w-][\w.-]*\/[\w-][\w.-]*$/.test(r.repo || '') && Number.isInteger(Number(r.number)) && Number(r.number) > 0) {
    return { kind: r.kind, repo: r.repo, number: Number(r.number), title: String(r.title || '').slice(0, 200) };
  }
  return null;
}

// Add one; the same item handed off twice while the first is still open is the first one.
export function addHandoff(list, ref, { after = null, now = Date.now() } = {}) {
  const r = cleanRef(ref);
  if (!r) throw new Error('hand off a PR, GitHub issue or Jira ticket');
  const dup = list.find((h) => open(h) && same(h.ref, r));
  if (dup) return { list, handoff: dup, already: true };
  const at = after && Date.parse(after) > now ? new Date(Date.parse(after)).toISOString() : null;
  const handoff = { id: randomBytes(6).toString('hex'), ref: r, label: label(r), status: 'queued', addedAt: new Date(now).toISOString(), after: at };
  return { list: [...list, handoff], handoff, already: false };
}

// The next one to start: nothing else running (one at a time), and its time has come.
export function nextHandoff(list, now = Date.now()) {
  if (list.some((h) => h.status === 'working' || h.status === 'needs-you')) return null;
  return list.find((h) => h.status === 'queued' && (!h.after || Date.parse(h.after) <= now)) || null;
}

// After a restart, a turn that was running is gone: say so, and the chat can be carried on.
export function settleAfterRestart(list) {
  return list.map((h) => (h.status === 'working' || h.status === 'needs-you' ? { ...h, status: 'stopped', note: 'Clearsky restarted while this ran: open the chat and say "carry on".' } : h));
}

// What Copilot is told. It's alone, so it says how it ended on a line of its own.
export function handoffPrompt(h, { skills = [] } = {}) {
  const what = h.ref.kind === 'issue' ? `Jira ticket ${h.ref.key}` : h.ref.kind === 'pr' ? `pull request ${h.label}` : `GitHub issue ${h.label}`;
  const review = h.ref.kind === 'issue' ? `review --ticket ${h.ref.key}` : `review --goal "<what ${h.label} asks for, in one line>"`;
  return [
    `I've handed ${what} to you to work on by yourself. I'm not watching this chat, so don't wait for me.`,
    skills.includes('continue-work') ? 'Use the continue-work skill: work out what is left on it and do that.' : 'Work out what is left on it and do that.',
    '',
    'How:',
    '- Work on a feature branch, never the default branch.',
    '- Build and run the tests for what you change.',
    `- Before you open or update a PR, run \`${review}\` and fix what it finds (at most 3 rounds).`,
    '- Open a new PR as a draft, and say in its description that it was done unattended.',
    '- Never merge, approve, close or delete anything.',
    '- If you are stuck, or it needs a decision only I can make, stop and say in a few sentences what you need from me.',
    '',
    'End your last message with one line, exactly one of:',
    'HANDOFF: done <the PR link>',
    'HANDOFF: blocked <what you need from me, in one sentence>',
  ].join('\n');
}

// How it ended, from Copilot's last words.
export function handoffResult(text) {
  const lines = String(text || '').trim().split('\n').reverse();
  for (const l of lines) {
    const m = l.trim().replace(/^[*_`]+|[*_`]+$/g, '').match(/^HANDOFF:\s*(done|blocked)\b\s*(.*)$/i);
    if (!m) continue;
    const rest = m[2].trim();
    const pr = rest.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/)?.[0] || null;
    return m[1].toLowerCase() === 'done' ? { status: 'done', pr, note: pr ? '' : rest.slice(0, 300) } : { status: 'blocked', pr, note: rest.slice(0, 300) };
  }
  return { status: 'done', pr: String(text).match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g)?.pop() || null, note: 'Finished without saying how: open the chat to see.' };
}

export function updateHandoff(list, id, patch) {
  return list.map((h) => (h.id === id ? { ...h, ...patch } : h));
}
