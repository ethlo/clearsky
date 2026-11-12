// A ticket goes to a review status ("Code review", "In Review") only once a person is asked to
// review its PR. Opening the PR isn't enough, and Copilot's PR reviewer doesn't count: until a
// person has it, the ticket stays where it is (In Progress). Chats move tickets with acli (or
// `ticket move`, which becomes acli): in the sandbox the broker checks this before the Jira door
// (lib/broker.mjs), outside it the acli wrapper does (scripts/acli-bin).

// A status that means "someone is reviewing it": Code review, In Review, Review, Ready for review.
export const isReviewStatus = (s) => /(^|[^a-z])review($|[^a-z])/i.test(String(s || ''));

// What `acli jira workitem transition …` moves, and to which status: { keys, status }, or null for
// any other command.
export function transitionOf(argv = []) {
  const at = argv.findIndex((a, i) => a === 'transition' && argv[i - 1] === 'workitem' && argv[i - 2] === 'jira');
  if (at < 0) return null;
  const flag = (name) => {
    for (let i = at + 1; i < argv.length; i++) {
      if (argv[i] === name) return argv[i + 1] ?? '';
      if (argv[i].startsWith(`${name}=`)) return argv[i].slice(name.length + 1);
    }
    return null;
  };
  const keys = (flag('--key') || '').split(',').map((k) => k.trim().toUpperCase()).filter(Boolean);
  return { keys, status: flag('--status'), bulk: flag('--jql') != null || flag('--filter') != null || flag('--from-json') != null };
}

// The people on a PR from `ticketPrs` (lib/modules/github.mjs): asked to review, or have reviewed.
// Bots and teams aren't people here.
export const prReviewers = (pr) => [...new Set([...(pr.pendingReviewers || []).filter((r) => !r.startsWith('team:')),
  ...(pr.reviewers || []), ...(pr.approvals || []), ...(pr.changesRequested || [])])].filter((r) => r && r !== pr.author);

// Whether `key` may go to a review status, from its PRs: { ok: true, who } or { ok: false, why }.
export function reviewReady(key, prs = []) {
  const live = prs.filter((p) => p.state !== 'closed');
  for (const p of live) {
    const who = prReviewers(p);
    if (who.length) return { ok: true, who, pr: `${p.repo}#${p.number}` };
  }
  if (!live.length) return { ok: false, why: `no PR with ${key} in its title was found` };
  const p = live[0];
  return { ok: false, why: `nobody is asked to review ${p.repo}#${p.number} yet${p.draft ? ' (it is a draft)' : ''}`, pr: `${p.repo}#${p.number}` };
}

// What a chat is told when the move waits.
export const notYet = (key, status, why) => `Clearsky: ${key} stays where it is: it goes to "${status}" only once a person is asked to review its PR, `
  + `and ${why}. Copilot's review doesn't count. Leave the ticket as it is (In Progress) and say so; once a reviewer is requested `
  + `(by me, or with \`gh pr edit <n> --add-reviewer <login>\` if I asked you to), move it then.\n`;

// The check for one acli command: null when it may go ahead, else the message to answer with.
// `prsFor(key)` gives the key's PRs as `ticketPrs` does ({ prs }); when GitHub can't be asked, the
// move isn't held up here (`null`): Jira changes ask you anyway.
export async function reviewGate(argv, prsFor) {
  const t = transitionOf(argv);
  if (!t || !isReviewStatus(t.status)) return null;
  if (t.bulk || !t.keys.length) return `Clearsky: move tickets to "${t.status}" one by one with --key, so Clearsky can check each has a reviewer.\n`;
  for (const key of t.keys) {
    let prs;
    try { const d = await prsFor(key); if (d?.noGitHub) return null; prs = d?.prs; } catch { return null; }
    if (!Array.isArray(prs)) return null;
    const r = reviewReady(key, prs);
    if (!r.ok) return notYet(key, t.status, r.why);
  }
  return null;
}
