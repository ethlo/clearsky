// "Implemented with Copilot (Claude Opus 5.5). 939 credits used.": an optional last line for a
// PR or ticket description, saying what did the work and what it cost. Off unless switched on in
// Settings → Copilot; a chat gets the line from Clearsky (`usage` in the sandbox), from its own
// session log, so the numbers aren't the chat's guess.

// A model id as people write it: claude-opus-5.5 → Claude Opus 5.5, gpt-5.1-codex → GPT-5.1 Codex.
export function modelName(id) {
  if (!id || /^auto$/i.test(id)) return null;
  if (/\s/.test(id) || /^[A-Z]/.test(id)) return String(id); // already a display name
  const out = [];
  for (const w of String(id).split(/[-_\s]+/).filter(Boolean)) {
    if (/^gpt$/i.test(w)) { out.push('GPT'); continue; }
    if (out.at(-1) === 'GPT' && /^[\d.]+$/.test(w)) { out[out.length - 1] = `GPT-${w}`; continue; }
    out.push(/^[a-z]/.test(w) ? w[0].toUpperCase() + w.slice(1) : w);
  }
  return out.join(' ');
}

const amount = (n) => (n >= 10 ? Math.round(n) : Math.round(n * 10) / 10);
const credits = (n) => `${amount(n)} credit${amount(n) === 1 ? '' : 's'}`;
const listed = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}` : xs[0]);

// One chat's work as the parts a ticket records (implementation, code review, qa), each from a
// session log: [{ kind, usage: { models, credits, premium }, model }] → { parts, total, models }.
// Parts with no log are left out; `total` is null when nothing is known.
export function creditSplit(parts) {
  const out = [];
  for (const p of parts) {
    if (!p.usage) continue;
    const c = p.usage.credits ?? p.usage.premium ?? null;
    const models = [...new Set([...(p.usage.models || []), p.model].map(modelName).filter(Boolean))];
    const have = out.find((x) => x.kind === p.kind);
    if (have) { have.credits = c == null ? have.credits : (have.credits || 0) + c; have.models = [...new Set([...have.models, ...models])]; }
    else out.push({ kind: p.kind, credits: c, models });
  }
  const known = out.filter((p) => p.credits != null);
  return { parts: out, total: known.length ? known.reduce((n, p) => n + p.credits, 0) : null, models: [...new Set(out.flatMap((p) => p.models))] };
}

// The last line of a PR or ticket description. Takes a split from creditSplit, or one session's
// usage ({ models, credits, premium }) and the model the chat was started with.
export function disclosureLine(split, model) {
  if (!split?.parts) split = creditSplit([{ kind: 'implementation', usage: split || { models: [] }, model }]);
  const who = split.models.length ? `Copilot (${listed(split.models)})` : 'Copilot';
  if (split.total == null) return `Implemented with ${who}.`;
  const parts = split.parts.filter((p) => p.credits != null);
  const detail = parts.length > 1 ? `: ${parts.map((p) => `${p.kind} ${amount(p.credits)}`).join(', ')}` : '';
  return `Implemented with ${who}. ${credits(split.total)} used${detail}.`;
}

// The same as values for Jira fields ("AI models", "AI credits"), when the ticket has them.
export function disclosureFields(split) {
  const parts = split.parts.filter((p) => p.credits != null);
  return [`AI models: ${split.models.join(', ') || 'Copilot'}`,
    `AI credits: ${split.total == null ? 'unknown' : amount(split.total)}${parts.length > 1 ? ` (${parts.map((p) => `${p.kind} ${amount(p.credits)}`).join(', ')})` : ''}`].join('\n');
}

export const DISCLOSE_HINT = 'When the work is done and the PR description is final (after review rounds and CI), run `usage`: it prints one line '
  + 'saying which models did the work and how many AI credits it used, split into implementation and code review. Put that line last in the PR '
  + 'description, replacing an earlier such line. On the ticket: if it has fields for AI models and AI credits, fill them from `usage --fields`; '
  + 'if not, put the `usage` line last in the ticket description. Don\'t write these yourself or change their numbers.';
