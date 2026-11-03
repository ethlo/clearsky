// "Implemented with Copilot (Claude Opus 5.5). 939 credits used.": an optional last line for a
// PR or ticket description, saying what did the work and what it cost. Off unless switched on in
// Settings → Copilot; a chat gets the line from Clearsky (`usage` in the sandbox), from its own
// session log, so the numbers aren't the chat's guess.

// A model id as people write it: claude-opus-5.5 → Claude Opus 5.5, gpt-5.1-codex → GPT-5.1 Codex.
export function modelName(id) {
  if (!id || /^auto$/i.test(id)) return null;
  const out = [];
  for (const w of String(id).split(/[-_\s]+/).filter(Boolean)) {
    if (/^gpt$/i.test(w)) { out.push('GPT'); continue; }
    if (out.at(-1) === 'GPT' && /^[\d.]+$/.test(w)) { out[out.length - 1] = `GPT-${w}`; continue; }
    out.push(/^[a-z]/.test(w) ? w[0].toUpperCase() + w.slice(1) : w);
  }
  return out.join(' ');
}

const amount = (n) => (n >= 10 ? Math.round(n) : Math.round(n * 10) / 10);

// `usage`: { models: [ids], premium } from the session log; `model`: what the chat was started
// with, used when the log names none.
export function disclosureLine(usage, model) {
  const names = [...new Set([...(usage?.models || []), model].map(modelName).filter(Boolean))];
  const who = names.length ? `Copilot (${names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0]})` : 'Copilot';
  const p = usage?.premium;
  return `Implemented with ${who}.${p != null ? ` ${amount(p)} credit${amount(p) === 1 ? '' : 's'} used.` : ''}`;
}

export const DISCLOSE_HINT = 'When the work is done and the PR description is final (after review rounds and CI), run `usage`: it prints one line '
  + 'saying which model did the work and how many credits it used. Put that line last in the PR description, and last in the ticket '
  + 'description if you wrote that, replacing an earlier such line. Don\'t write the line yourself or change its numbers.';
