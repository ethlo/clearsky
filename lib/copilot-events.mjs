// What a Copilot session did, from its own log (~/.copilot/session-state/<id>/events.jsonl):
// the branches it worked on, and the steps that move work along (a push, a review request,
// a ticket moved), so an item can show "Copilot: pushed, 5 min ago" and isn't done twice.

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const KEY = /\b([A-Z][A-Z0-9_]+-\d+)\b/;

// One shell command (often "cd … && git push …") as a step worth showing, or null.
export function commandAction(cmd = '') {
  for (const part of cmd.split(/&&|;|\|\|/).map((x) => x.trim())) {
    let m;
    if (/^git push\b/.test(part)) return { text: 'pushed' };
    if (/^gh pr create\b/.test(part)) return { text: 'opened the PR' };
    if (/^gh pr merge\b/.test(part)) return { text: 'merged the PR' };
    if ((m = part.match(/^gh pr edit\b.*--add-reviewer[= ]+["']?([\w,@-]+)/))) return { text: `asked ${m[1].replace(/,/g, ', ')} to review` };
    if (/^gh api\b.*requested_reviewers/.test(part) && !/-X\s*DELETE/i.test(part)) return { text: 'asked for a review' };
    if (/^gh pr review\b.*--approve/.test(part)) return { text: 'approved the PR' };
    if (/^gh pr (comment|review)\b/.test(part)) return { text: 'commented on the PR' };
    if (/^acli jira workitem transition\b/.test(part) && (m = part.match(KEY))) {
      const to = part.match(/--status[= ]+(?:"([^"]+)"|'([^']+)'|(\S+))/);
      return { text: `moved ${m[1]}${to ? ` to ${to[1] || to[2] || to[3]}` : ''}`, key: `issue:${m[1]}` };
    }
    if (/^acli jira workitem comment\b/.test(part) && (m = part.match(KEY))) return { text: `commented on ${m[1]}`, key: `issue:${m[1]}` };
  }
  return null;
}

// Branches and steps from one session's log text.
export function parseEvents(text) {
  const branches = new Set(), actions = [], started = new Map();
  for (const line of text.split('\n')) {
    if (!line.includes('"session.') && !line.includes('"tool.execution_')) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const d = e.data || {};
    if (e.type === 'session.start' || e.type === 'session.resume') { if (d.context?.branch) branches.add(d.context.branch); }
    else if (e.type === 'tool.execution_start' && d.toolName === 'bash' && d.arguments?.command) started.set(d.toolCallId, d.arguments.command);
    else if (e.type === 'tool.execution_complete' && started.has(d.toolCallId)) {
      const a = d.success !== false && (d.shellExecution?.exitCode ?? 0) === 0 && commandAction(started.get(d.toolCallId));
      if (a) actions.push({ ...a, at: e.timestamp });
      started.delete(d.toolCallId);
    }
  }
  return { branches: [...branches], actions };
}

const cache = new Map();
export function sessionEvents(home, id) {
  const file = join(home, 'session-state', id, 'events.jsonl');
  try {
    const st = statSync(file);
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.result;
    const result = parseEvents(readFileSync(file, 'utf8'));
    cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, result });
    return result;
  } catch {
    return { branches: [], actions: [] };
  }
}
