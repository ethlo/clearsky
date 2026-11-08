// The one item model the page draws: everything that can need you, from any source, as the same
// kind of row, with the next step on it. Each module turns its own data into these (its
// workItems()), so the page needs no code that knows GitHub, Jira or a plugin.
//
//   { k, kind, group, src, url, stamp, ref, title, step, quote, glyph, label: [text, tone],
//     at, pr, issue, links, next, data }
//
// kind:  review | pr | mention | issue | ticket | extra
// group: needs (needs you) | waiting (on others) | tickets (what you have left)
// links: keys of other items this one is about, like 'issue:ABC-12' or 'gh:acme/api#3'
// next:  what to do next: { label, run: 'review' | 'url' | 'copilot' | 'start', url, prompt, skill }
//        or { label, wait: true }. 'copilot' with skill 'continue' continues the item's chat;
//        'start' starts or continues it with the work skill. The page fills in which skill.

export const shortRepo = (repo) => (repo || '').split('/').pop();
export const TONE = { bad: 'red', warn: 'amber', good: 'green' };
export const GLYPH = { bad: 'chg', warn: 'rev', good: 'rdy', wait: 'wait', neutral: 'todo' };

// Ticket keys in a title (upper case only, so "utf-8" isn't one) and a branch name (any case).
const KEY = /\b([A-Za-z][A-Za-z0-9_]+-\d+)\b/g;
export function ticketKeys(title = '', branch = '') {
  const keys = new Set();
  for (const [text, anyCase] of [[title, false], [branch, true]]) {
    for (const m of text.matchAll(KEY)) if (anyCase || m[1] === m[1].toUpperCase()) keys.add(m[1].toUpperCase());
  }
  return [...keys];
}

const fix = (label, prompt) => ({ label, run: 'copilot', skill: 'continue', prompt });

// The next step on one of your PRs, from who has the ball and why.
export function prNext(p) {
  switch (p.status?.label?.replace(/^\d+ unresolved threads?$/, 'threads')) {
    case 'Draft': return { label: 'Mark it ready for review', run: 'url', url: p.url };
    // One click: the conflict is plain work with a clear end, so it starts (or goes to the chat
    // on this PR) right away. Pushing the merge still goes through the sandbox's rules.
    case 'Merge conflict': {
      const base = p.base ? `origin/${p.base}` : 'the default branch', branch = p.branch ? ` (${p.branch})` : '';
      return { ...fix('Resolve the conflict with Copilot', `Merge ${base} into this PR's branch${branch} (no rebase, no force push) and resolve the conflicts, keeping both sides' intent. If a conflict needs a judgment call, stop and show me both versions. Build and run the affected tests, commit the merge and push it.`), auto: true };
    }
    case 'CI failing': return fix('Fix the failing checks', 'Find out why the checks fail on this PR and fix it.');
    case 'Changes requested': case 'threads': case 'Has feedback':
      return fix('Address the review comments', 'Go through the open review comments on this PR: fix what is right, and draft replies for the rest. Don\'t post or resolve anything without asking.');
    case 'Ready to merge': return { label: 'Merge it', run: 'merge', repo: p.repo, number: p.number, url: p.url };
    case 'Approved, CI running': return { label: 'Wait for the checks', wait: true };
    case 'In review rounds': return p.status.owner === 'me'
      ? fix('Address Copilot\'s comments', 'Go through Copilot\'s open review comments on this PR: fix what is right, and draft replies for the rest. Don\'t post or resolve anything without asking.')
      : { label: 'Wait for Copilot\'s review', wait: true };
    case 'CI build running': return { label: 'Wait for the CI build', wait: true };
    case 'No reviewer yet': case 'Ready for a reviewer': return { label: 'Request review', run: 'review' };
    default: return { label: p.pendingReviewers?.length ? `Waiting on ${p.pendingReviewers.join(', ')}` : 'Waiting for review', wait: true };
  }
}
export const reviewNext = (p) => ({ label: p.rerequested ? 'Review the new changes' : 'Review it', run: 'copilot',
  prompt: 'Review this PR: summarise the change, check it against the ticket, and draft review comments. Don\'t post anything.' });
export const replyNext = (url) => ({ label: 'Reply', run: 'url', url });
export const startNext = () => ({ label: 'Start it', run: 'start' });

// Rows for a plugin source whose panel needs you (its items() hook), as work items. An item may
// say it's a `mention` (kind), that its next step is to `reply` (next), and name its link (`open`,
// such as "Open in Slack"), its quote's heading (`quoteLabel`) and why it's here (`why`).
export function pluginItems(p, data) {
  if (!data || data.error || data.disabled || p.area === 'personal' || p.panel?.zone !== 'needs') return [];
  return (data.items || []).map((i) => ({ group: 'needs', kind: i.kind === 'mention' ? 'mention' : 'extra', k: i.key ? `${p.name}:${i.key}` : i.url || '', url: i.url || '', stamp: i.stamp,
    ref: i.ref || p.panel.title, title: i.title, step: i.meta || i.quote, quote: i.quote, glyph: 'ment', label: [i.badge || p.panel.title, i.badge ? TONE[i.tone] || i.tone : null],
    at: i.at, src: p.panel.title, read: i.detail && i.key ? { src: p.name, key: i.key } : null,
    next: i.url ? (i.next === 'reply' ? replyNext(i.url) : { label: 'Open it', run: 'url', url: i.url }) : null, data: i }));
}
