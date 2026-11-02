// "Read by you": PRs under your name carry code you didn't write yourself (a Copilot chat in
// Clearsky, Copilot's coding agent, Claude, a colleague). This works out, per PR, whether you've
// read what's in it: a mark keeps the commit you read up to, and anything after it that isn't
// your own is unread. The risky ones are those reviewers are already looking at, or have approved.
// Pure functions, so they can be tested; the server passes in your marks and Clearsky's log of
// what its chats pushed.

// Agents by their GitHub login or the name in a Co-authored-by line.
const AGENTS = [
  [/copilot-swe-agent|^copilot$/i, 'Copilot agent'],
  [/\bcopilot\b/i, 'Copilot'],
  [/\bclaude\b/i, 'Claude'],
  [/\bcursor\b/i, 'Cursor'],
  [/\bcodex\b/i, 'Codex'],
  [/\bdevin\b/i, 'Devin'],
  [/\[bot\]$/i, 'a bot'],
];
// The coding agent commits as the Copilot account; Copilot in a terminal or Clearsky adds a
// "Co-authored-by: Copilot" line to your commit.
const agentName = (s, trailer = false) => (s ? AGENTS.slice(trailer ? 1 : 0).find(([re]) => re.test(s))?.[1] || null : null);

// Who wrote one commit: { by: 'me'|'agent'|'other', agent }.
// `me`: your login, or { login, name }: a commit whose author GitHub couldn't tie to an account
// (a local git email it doesn't know) is yours when it carries your name.
export function commitWriter(c, me) {
  const myName = typeof me === 'object' ? me?.name : null;
  me = typeof me === 'object' ? me?.login : me;
  const login = c.login || '';
  const bot = agentName(login) || (c.bot ? 'a bot' : null);
  if (bot) return { by: 'agent', agent: bot };
  for (const m of String(c.message || '').matchAll(/^co-authored-by:\s*([^<\n]+)/gim)) {
    const a = agentName(m[1].trim(), true);
    if (a) return { by: 'agent', agent: a };
  }
  if (login && me && login.toLowerCase() === me.toLowerCase()) return { by: 'me' };
  if (!login && c.email && /noreply/.test(c.email) && agentName(c.name)) return { by: 'agent', agent: agentName(c.name) };
  if (!login && myName && c.name && c.name.trim().toLowerCase() === myName.trim().toLowerCase()) return { by: 'me' };
  // Someone else, or an author GitHub can't place: not yours until you've read it.
  return { by: 'other', who: login || c.name || 'someone' };
}

// Clearsky's own log of pushes by its chats: "repo|branch" → times, from agent-writes entries
// like { where: 'github', what: 'git push to owner/repo (a, b)', target: 'owner/repo' }.
export function chatPushes(writes) {
  const out = new Map();
  for (const e of writes || []) {
    const m = e.where === 'github' && e.decided !== 'declined' && String(e.what || '').match(/^git push to (\S+?)(?: \((.+)\))?$/);
    if (!m || !m[2]) continue;
    for (const b of m[2].split(/,\s*/)) {
      const k = `${m[1]}|${b}`;
      if (!out.has(k)) out.set(k, []);
      out.get(k).push(Date.parse(e.at));
    }
  }
  return out;
}

// A commit that shows as yours but was pushed by a Clearsky chat within 12 hours after it was
// made is the chat's work.
const CHAT_WINDOW = 12 * 3600e3;
const pushedByChat = (pushes, repo, branch, at) => (pushes.get(`${repo}|${branch}`) || []).some((t) => t >= Date.parse(at) - 60e3 && t - Date.parse(at) <= CHAT_WINDOW);

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// The read state of one of your PRs. `pr`: { url, repo, branch, headOid, commits: [{ oid, at,
// login, name, email, message, additions, deletions }] oldest first, approvals, pendingReviewers,
// askedAt, draft, viewed: { files, viewed } }. `readOid`: the commit you marked read, if any.
// Ticking every file Viewed in GitHub's Files changed counts as read too: GitHub unticks a file
// when a later commit changes it.
export function ownRead(pr, me, readOid, pushes = new Map()) {
  if (!pr.commits?.length) return null; // nothing known about its commits
  const commits = (pr.commits || []).map((c) => {
    let w = commitWriter(c, me);
    if (w.by === 'me' && pr.branch && pushedByChat(pushes, pr.repo, pr.branch, c.at)) w = { by: 'agent', agent: 'Copilot chat' };
    return { oid: c.oid, at: c.at, lines: (c.additions || 0) + (c.deletions || 0), ...w };
  });
  const writers = [...new Set(commits.map((c) => (c.by === 'me' ? 'you' : c.agent || c.who)))];
  const idx = readOid ? commits.findIndex((c) => c.oid === readOid) : -1;
  const rewritten = !!readOid && idx < 0 && readOid !== pr.headOid;
  const after = idx >= 0 ? commits.slice(idx + 1) : readOid === pr.headOid ? [] : commits;
  const unread = after.filter((c) => c.by !== 'me');
  const lines = unread.reduce((n, c) => n + c.lines, 0);
  const base = { writers, headOid: pr.headOid || null, readOid: readOid || null, agentWritten: commits.some((c) => c.by !== 'me') };
  const v = pr.viewed, allViewed = !!v?.files && v.viewed === v.files;
  if (!unread.length || allViewed) {
    return { ...base, state: 'read', unread: 0, lines: 0, risk: null, viaViewed: allViewed && !!unread.length,
      label: readOid || allViewed ? ['read by you', 'green'] : ['all yours', null], diffUrl: null };
  }
  const risk = pr.approvals?.length ? 'approved' : !pr.draft && (pr.pendingReviewers?.length || pr.askedAt || pr.lastReviewAt) ? 'asked' : null;
  const state = readOid ? 'new' : 'unread';
  const what = state === 'new' ? `${plural(unread.length, 'new commit')} since you read it${rewritten ? ' (rewritten)' : ''}` : 'not read by you';
  // Short, for a column; the tone says how much it matters: approved red, in review amber.
  const label = [state === 'new' ? `${unread.length} new` : 'not read', { approved: 'red', asked: 'amber' }[risk] || 'blue'];
  const why = risk === 'approved' ? 'approved by a reviewer, ' : risk === 'asked' ? 'in review, ' : '';
  const by = [...new Set(unread.map((c) => c.agent || c.who))].join(', ');
  return { ...base, state, unread: unread.length, lines, risk, label, by,
    step: `${why}${what} · ${by}${lines ? ` · ${plural(lines, 'line')}` : ''}${v?.viewed ? ` · ${v.viewed} of ${plural(v.files, 'file')} viewed` : ''}`,
    // Just what changed since your mark, when that commit is still in the branch.
    diffUrl: pr.url ? (idx >= 0 && pr.headOid ? `${pr.url}/files/${readOid}..${pr.headOid}` : `${pr.url}/files`) : null };
}
