// The stand-up as a short list: each ticket (or PR without a ticket) shows up once, in the one
// section that fits it best, with its PRs and status on the same line. Everything else that
// happened (each PR, commits, Copilot chats) goes in a details list that the page folds away.
//
// Input is the raw stand-up from bin/clearsky.mjs: { tracker, yesterday: { github, tickets, copilot },
// today, blockers, extra, jiraProjects }. Output: { yesterday, today, blockers, details } as lists of lines.
//
// What a "ticket" is depends on the tracker (lib/tracker.mjs): a Jira key in a PR's title or
// branch, the GitHub issue a PR closes ("Fixes #12"), or nothing, when each PR stands alone.

// Things that look like Jira keys but are standards and the like. Used when no Jira projects are
// known; with known projects only their keys count.
export const NOT_JIRA = new Set(['RFC', 'ISO', 'IEC', 'IEEE', 'CVE', 'CWE', 'UTF', 'SHA', 'TLS', 'SSL', 'HTTP', 'AES', 'RSA', 'ECMA', 'UTC', 'GMT', 'JSR', 'PEP', 'W3C', 'EN', 'DIN', 'NIST', 'OWASP']);

// "ABC-123" on its own: not glued to a word, path or branch name ("ABC-123-fix-it", "x/ABC-123").
export const JIRA_KEY = /(?<![\w/.-])([A-Z][A-Z0-9_]+-\d+)(?![\w-])/g;

export function isJiraKey(key, projects) {
  const p = key.split('-')[0];
  return projects?.size ? projects.has(p) : !NOT_JIRA.has(p);
}

// The ticket a PR or chat is about: a key in its title, or at the start of its branch name.
export function ticketOf({ title, branch } = {}, projects) {
  for (const m of String(title || '').matchAll(JIRA_KEY)) if (isJiraKey(m[1], projects)) return m[1];
  const b = String(branch || '').toUpperCase().match(/(?:^|\/)([A-Z][A-Z0-9_]+-\d+)(?=$|[-_/])/);
  return b && isJiraKey(b[1], projects) ? b[1] : null;
}

const ref = (p) => `${p.repo}#${p.number}`;
const stripKey = (title, key) => String(title || '').replace(new RegExp(`^\\[?${key}\\]?[:\\s-]*`), '').trim();
// "Changes requested" → "changes requested", but "CI failing" stays.
const lower = (x) => String(x || '').replace(/^[A-Z](?![A-Z])/, (c) => c.toLowerCase());
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const verdictText = { APPROVED: 'approved', CHANGES_REQUESTED: 'requested changes', COMMENTED: 'commented', DISMISSED: 'dismissed' };

// "owner/name#12" in a chat's title, for GitHub Issues.
const GH_ISSUE = /(?<![\w/.-])([\w-][\w.-]*\/[\w-][\w.-]*#\d+)\b/;
const TRACKER_LABEL = { jira: 'Jira', github: 'GitHub' };

export function groupStandup(s, { clock = () => '' } = {}) {
  const y = s.yesterday || {}, t = s.today || {};
  const tracker = s.tracker || 'jira';
  const gh = y.github || {}, jira = y.tickets || y.jira || {};
  const projects = new Set(s.jiraProjects || []);
  // An owner/name#12 in a chat's title counts when it is an issue seen here (not a PR).
  const knownIssue = (r) => (r && (s.issueTitles?.[r] || (jira.done || []).some((i) => i.key === r) || (jira.touched || []).some((i) => i.key === r)) ? r : null);
  // The ticket a PR or chat belongs to, in this tracker.
  const prTicket = (p) => (tracker === 'jira' ? ticketOf({ title: p.title, branch: p.branch }, projects)
    : tracker === 'github' ? (p.issues || [])[0] || null : null);
  const chatTicket = (c) => (tracker === 'jira' ? (c.ticket && isJiraKey(c.ticket, projects) ? c.ticket : ticketOf({ title: c.title, branch: c.branch }, projects))
    : tracker === 'github' ? knownIssue(String(c.title || '').match(GH_ISSUE)?.[1]) : null);
  const units = new Map();
  const unit = (id) => {
    if (!units.has(id)) units.set(id, { id, ticket: null, prs: new Map(), chats: 0, touched: false, order: units.size });
    return units.get(id);
  };
  const ticket = (key, info) => { const u = unit(key); u.ticket = { key, ...u.ticket, ...info }; return u; };
  const addPr = (p, info) => {
    const key = prTicket(p);
    const u = key ? ticket(key, s.issueTitles?.[key] ? { summary: s.issueTitles[key] } : {}) : unit(ref(p));
    const r = ref(p);
    u.prs.set(r, { repo: p.repo, number: p.number, title: p.title, url: p.url, ...u.prs.get(r), ...info });
    return u;
  };

  // Since the last stand-up.
  for (const i of jira.done || []) Object.assign(ticket(i.key, { summary: i.summary, status: i.status, done: true }), { touched: true });
  for (const i of jira.touched || []) Object.assign(ticket(i.key, { summary: i.summary, status: i.status }), { touched: true });
  for (const p of gh.merged || []) Object.assign(addPr(p, { merged: true, commits: p.commits }), { touched: true });
  for (const p of gh.opened || []) Object.assign(addPr(p, { opened: true, draft: p.draft, commits: p.commits }), { touched: true });
  // Copilot chats only add to work that shows up elsewhere; on their own they go in the details.
  const loose = new Map();
  for (const c of y.copilot?.sessions || []) {
    const key = chatTicket(c);
    if (key) { const u = ticket(key, {}); u.chats++; u.touched = true; continue; }
    if (/^review\b/i.test(c.title || '')) continue; // a self-review of a branch: the branch's work shows elsewhere
    const repo = (c.repo || '').split('/')[1] || c.repo || '';
    const k = `${c.title}|${repo}`;
    loose.set(k, { title: c.title, repo, n: (loose.get(k)?.n || 0) + 1 });
  }

  // Now: what's open, and who has the ball.
  for (const i of t.inProgress || []) ticket(i.key, { summary: i.summary, status: i.status, inProgress: !i.waiting && !/review|\bqa\b|verif|test|blocked|waiting|on hold|pending/i.test(i.status || '') });
  for (const p of [...(t.myPrs || []), ...(t.inReview || [])]) {
    addPr(p, { open: true, draft: p.draft, label: p.status?.label, owner: p.status?.owner, pendingReviewers: p.pendingReviewers || [], approvals: p.approvals || [] });
  }
  for (const b of s.blockers || []) if (b.repo) addPr(b, { blocker: b.days ?? true });

  // Each unit goes in the one section that fits best.
  const yesterday = [], today = [], blockers = [], details = [];
  const prState = (p) => {
    if (p.merged) return 'merged';
    if (p.draft) return 'draft';
    if (p.owner === 'me') return lower(p.label);
    if (p.open) return p.approvals?.length ? 'approved, not merged yet' : p.pendingReviewers?.length ? `waiting for ${p.pendingReviewers.join(', ')}` : lower(p.label || 'in review');
    return 'opened';
  };
  const label = (u) => {
    if (u.ticket) {
      const first = [...u.prs.values()][0];
      const summary = u.ticket.summary || (tracker === 'jira' ? stripKey(first?.title, u.ticket.key) : first?.title) || '';
      return `${u.ticket.key}: ${summary}`.replace(/: $/, '');
    }
    const p = [...u.prs.values()][0];
    return `${ref(p)} ${p.title}`;
  };
  const prList = (u, skip, ...more) => {
    const parts = [...u.prs.values()].map((p) => {
      const st = prState(p);
      const head = u.ticket ? ref(p) : '';
      const tail = st === skip ? '' : st;
      return [head, tail].filter(Boolean).join(' ');
    }).concat(more).filter(Boolean);
    return parts.length ? ` (${parts.join('; ')})` : '';
  };
  for (const u of units.values()) {
    const prs = [...u.prs.values()];
    const mine = prs.find((p) => p.open && p.owner === 'me' && !p.draft && !p.merged);
    const waiting = prs.some((p) => p.open && p.owner !== 'me' && !p.draft && !p.merged) || /review|\bqa\b|verif|test/i.test(u.ticket?.status || '');
    const blocked = prs.filter((p) => p.blocker);
    const done = u.ticket?.done || prs.some((p) => p.merged);
    if (!u.touched && !u.ticket?.inProgress && !prs.some((p) => p.open)) continue;
    if (blocked.length) {
      const d = (p) => (typeof p.blocker === 'number' ? `${p.blocker}d` : 'a while');
      blockers.push({ order: -Math.max(...blocked.map((p) => +p.blocker || 0)), text: `${label(u)}: ${blocked.map((p) => `${ref(p)} has waited ${d(p)} for review${p.pendingReviewers?.length ? ` (${p.pendingReviewers.join(', ')})` : ''}`).join('; ')}` });
    } else if (mine) {
      today.push({ order: 0, text: `${mine.label}: ${label(u)}${prList(u, lower(mine.label))}` });
    } else if (u.ticket?.inProgress) {
      today.push({ order: 1, text: `Continue ${label(u)}${prList(u)}` });
    } else if (done) {
      const merged = prs.some((p) => p.merged);
      yesterday.push({ order: merged ? 0 : 1, text: `${merged ? 'Merged, ready to test' : 'Finished'}: ${label(u)}${prList(u, 'merged')}` });
    } else if (waiting) {
      (u.touched ? yesterday : today).push({ order: 2, text: `In review: ${label(u)}${prList(u)}` });
    } else {
      const opened = prs.find((p) => p.opened);
      yesterday.push({ order: 3, text: `${opened ? `Opened ${opened.draft ? 'draft ' : ''}PR for` : 'Worked on'} ${label(u)}${prList(u, opened?.draft ? 'draft' : 'opened', !opened && u.ticket?.status)}` });
    }
    // The full story of each unit, folded away on the page.
    const facts = [
      u.ticket?.status && `${TRACKER_LABEL[tracker] || 'Ticket'}: ${u.ticket.status}`,
      ...prs.map((p) => `${ref(p)} ${[p.opened && 'opened', prState(p)].filter((x, i, a) => x && a.indexOf(x) === i).join(', ')}${p.commits ? `, ${plural(p.commits, 'commit')}` : ''}`),
      u.chats && plural(u.chats, 'Copilot chat'),
    ].filter(Boolean);
    if (u.touched || facts.length) details.push(`${label(u)}${facts.length ? ` · ${facts.join(' · ')}` : ''}`);
  }
  const sorted = (a) => a.sort((x, z) => x.order - z.order).map((x) => x.text);
  const out = { yesterday: sorted(yesterday), today: sorted(today), blockers: sorted(blockers), details };

  // Other people's PRs: what I reviewed, and what's waiting for me.
  const asked = new Set((t.reviews || []).map(ref));
  const reviewed = (gh.reviewed || []).filter((p) => !asked.has(ref(p)));
  if (reviewed.length) out.yesterday.push(`Reviewed ${reviewed.map((p) => `${ref(p)} (${[p.author, verdictText[p.verdict] || String(p.verdict || '').toLowerCase()].filter(Boolean).join(', ')})`).join(', ')}`);
  if (t.reviews?.length) out.today.push(`Review ${t.reviews.map((p) => `${ref(p)}${p.author ? ` (${p.author})` : ''}`).join(', ')}`);

  for (const x of s.extra || []) {
    x.yesterday.forEach((l) => out.yesterday.push(`${x.label}: ${l}`));
    x.today.forEach((l) => out.today.push(`${x.label}: ${l}`));
  }
  if (t.meetings?.length) out.today.push(`Meetings: ${t.meetings.map((e) => `${clock(e.start)} ${e.title}`.trim()).join(', ')}`);

  for (const c of loose.values()) out.details.push(`Copilot chat: ${c.title}${c.repo ? ` (${c.repo})` : ''}${c.n > 1 ? ` ×${c.n}` : ''}`);
  const commits = (gh.commits || []).filter((c) => c.count);
  if (commits.length) out.details.push(`Commits: ${commits.map((c) => `${c.count} in ${c.repo.split('/')[1] || c.repo}`).join(', ')}`);
  return out;
}
