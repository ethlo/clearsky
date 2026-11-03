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
  // times: when each step started and ended, by its tool call id (a chat reopened after a
  // restart gets its steps back from Copilot without times).
  const branches = new Set(), actions = [], started = new Map(), times = {};
  for (const line of text.split('\n')) {
    if (!line.includes('"session.') && !line.includes('"tool.execution_')) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const d = e.data || {};
    if (d.toolCallId && e.timestamp && e.type === 'tool.execution_start') times[d.toolCallId] = { start: Date.parse(e.timestamp) };
    if (d.toolCallId && e.timestamp && e.type === 'tool.execution_complete') (times[d.toolCallId] ||= {}).end = Date.parse(e.timestamp);
    if (e.type === 'session.start' || e.type === 'session.resume') { if (d.context?.branch) branches.add(d.context.branch); }
    else if (e.type === 'tool.execution_start' && d.toolName === 'bash' && d.arguments?.command) started.set(d.toolCallId, d.arguments.command);
    else if (e.type === 'tool.execution_complete' && started.has(d.toolCallId)) {
      const a = d.success !== false && (d.shellExecution?.exitCode ?? 0) === 0 && commandAction(started.get(d.toolCallId));
      if (a) actions.push({ ...a, at: e.timestamp });
      started.delete(d.toolCallId);
    }
  }
  return { branches: [...branches], actions, times };
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
    return { branches: [], actions: [], times: {} };
  }
}

// Tokens a session used, from its log: one session.usage_record per model call (inputTokens
// already includes the cached part), the latest checkpoint's premium requests, and how full the
// context was after the last tool step.
export function parseUsage(text) {
  const seen = new Set();
  const u = { input: 0, cached: 0, output: 0, calls: 0, premium: null, context: null, limit: null, models: [] };
  for (const line of text.split('\n')) {
    if (!line.includes('"session.usage_') && !line.includes('context_current_tokens')) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const d = e.data || {};
    if (e.type === 'session.usage_record' && d.usage) {
      const id = d.usage.accounting?.usageId;
      if (id) { if (seen.has(id)) continue; seen.add(id); }
      u.input += d.usage.inputTokens || 0;
      u.cached += (d.usage.cacheReadTokens || 0) + (d.usage.cacheWriteTokens || 0);
      u.output += d.usage.outputTokens || 0;
      u.calls++;
      const model = d.model || d.usage.model;
      if (typeof model === 'string' && !u.models.includes(model)) u.models.push(model);
    } else if (e.type === 'session.usage_checkpoint' && d.totalPremiumRequests != null) u.premium = d.totalPremiumRequests;
    const m = d.toolTelemetry?.metrics;
    if (m?.context_current_tokens != null) { u.context = m.context_current_tokens; u.limit = m.context_token_limit ?? u.limit; }
  }
  return u.calls ? u : null;
}

const usageCache = new Map();
export function sessionUsage(home, id) {
  const file = join(home, 'session-state', id, 'events.jsonl');
  try {
    const st = statSync(file);
    const hit = usageCache.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.result;
    const result = parseUsage(readFileSync(file, 'utf8'));
    usageCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, result });
    return result;
  } catch {
    return null;
  }
}
