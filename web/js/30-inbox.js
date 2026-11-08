// Clearsky page: the inbox and work tables, links between items, and the next step.
// The server joins web/js/*.js in name order into one script in index.html, so they share one scope.

// ---------------------------------------------------------------- the inbox

// Everything that can need you becomes the same kind of row: what it is, what it's called, a
// status glyph, one label, and how old it is. The group says why it's there; colour is kept for
// the glyphs and for labels that need you.
const shortRepo = (repo) => (repo || '').split('/').pop();
const shortAgo = (iso) => ago(iso).replace(' ago', '');
const prMeta = (p) => [p.approvals.length && `approved by ${p.approvals.join(', ')}`,
  p.changesRequested.length && `changes from ${p.changesRequested.join(', ')}`,
  p.pendingReviewers.length && `waiting on ${p.pendingReviewers.join(', ')}`,
  p.botSuggestions && `Copilot left ${p.botSuggestions} suggestion${p.botSuggestions > 1 ? 's' : ''}`].filter(Boolean).join(' · ');
// Who reviews a PR and where each stands, as small chips: asked, approved, changes asked.
function reviewerChips(p) {
  if (!p) return '';
  const people = new Map();
  (p.pendingReviewers || []).forEach((n) => people.set(n, ['asked', 'gray']));
  (p.changesRequested || []).forEach((n) => people.set(n, ['changes requested', 'red']));
  (p.approvals || []).forEach((n) => people.set(n, ['approved', 'green']));
  if (!people.size) return '';
  return `<div class="rv-who">${[...people].map(([n, [st, tone]]) => `<span class="badge b-${tone}" title="${esc(n)}: ${esc(st)}">${esc(n.replace(/^team:/, ''))} · ${esc(st)}</span>`).join('')}</div>`;
}
const prByKey = (k) => [...(state.github?.myPrs || []), ...(state.github?.reviewRequested || [])].find((p) => `pr:${p.repo}#${p.number}` === k);
const snoozedUntil = (k) => { const u = mutedMap[k]; return u && Date.parse(u) > Date.now() ? u : null; };

// The rows come from the server (lib/items.mjs), one list per source as it loads.
// PRs you merged here leave the lists at once: GitHub's search can show them open a little longer.
const mergedAt = new Map();
const justMerged = (url) => url && Date.now() - (mergedAt.get(url) || 0) < 10 * 6e4;
function inboxItems() {
  const out = [];
  for (const name of ['github', 'jira', 'jiraMentions', 'slack', ...extraSources.map((x) => x.name)]) {
    const d = state[name];
    if (d && !d.error) (d.work || []).filter((x) => !justMerged(x.url)).forEach((x) => out.push({ ...x }));
  }
  for (const it of out) { it.done = isHidden(it); it.snoozed = !it.done && snoozedUntil(it.k); }
  // Mentions: newest first, after reviews and your own PRs.
  const order = { review: 0, pr: 1, mention: 2, extra: 3 };
  return out.sort((a, b) => (a.group === 'needs' && b.group === 'needs'
    ? (order[a.kind] - order[b.kind]) || (a.kind === 'mention' ? Date.parse(b.at) - Date.parse(a.at) : 0) : 0));
}

// One piece of work across sources: a PR links to the Jira tickets in its title or branch and the
// GitHub issues it closes (its `links`); a ticket or issue links back to those PRs. Ticket keys
// count only for projects you have tickets in, so "UTF-8" in a branch isn't taken for a ticket.
function relatedItems(it, all) {
  const projects = new Set(all.filter((x) => x.issue).map((x) => x.issue.split('-')[0]));
  const ghKey = (x) => (x.kind === 'issue' && x.data ? `gh:${x.data.repo}#${x.data.number}` : null);
  const id = (x) => (x.issue ? `issue:${x.issue}` : x.url);
  const links = (x) => (x.links || []).filter((l) => !l.startsWith('issue:') || projects.has(l.slice(6).split('-')[0]));
  let match = () => false;
  if (it.pr && it.links) {
    const mine = new Set(links(it));
    match = (x) => (x.issue && mine.has(`issue:${x.issue}`)) || mine.has(ghKey(x));
  } else if (it.issue || it.kind === 'issue') {
    match = (x) => !!x.pr && links(x).some((l) => l === `issue:${it.issue}` || l === ghKey(it));
  }
  // The ticket or PR itself rather than a mention of it, when both are listed.
  const seen = new Set([id(it)]), out = [];
  for (const x of [...all].sort((a, b) => (a.kind === 'mention') - (b.kind === 'mention'))) {
    if (!seen.has(id(x)) && match(x)) { seen.add(id(x)); out.push(x); }
  }
  // A PR's tickets that aren't in your lists (someone else's, or closed) still get a link.
  if (it.pr) for (const l of links(it)) if (l.startsWith('issue:') && !seen.has(l)) out.push(unlistedTicket(l.slice(6)));
  return out;
}
// A ticket you don't have in a list, opened here with what Jira says about it.
function unlistedTicket(key) {
  const site = [...(state.jira?.assigned || []), ...(state.jiraMentions?.tickets || [])].map((t) => t.url).find(Boolean);
  const url = site ? `${new URL(site).origin}/browse/${key}` : '';
  return { group: 'linked', kind: 'linked', k: `linked:${key}`, issue: key, ref: key, url, title: key, src: 'Jira', glyph: 'todo', label: ['not in your lists'], step: 'Not in your lists: assigned to someone else, or closed.', data: {} };
}
// The item behind a key like pr:owner/repo#12 or issue:ABC-1: the one in your lists, or
// one made up from the key so it still opens here (with what GitHub or Jira says about it).
function itemForKey(k) {
  const all = xrefAll.length ? xrefAll : inboxItems();
  const rank = (x) => ({ pr: 0, review: 0, ticket: 0, issue: 1, mention: 2 }[x.kind] ?? 3);
  const hit = all.filter((x) => (k.startsWith('issue:') ? x.issue === k.slice(6) : x.url && itemKey(x.url) === k)).sort((a, b) => rank(a) - rank(b))[0];
  if (hit) return hit;
  if (k.startsWith('issue:')) return unlistedTicket(k.slice(6));
  const m = k.match(/^(pr|gh):([\w.-]+\/[\w.-]+)#(\d+)$/);
  if (!m) return null;
  const url = `https://github.com/${m[2]}/${m[1] === 'pr' ? 'pull' : 'issues'}/${m[3]}`;
  return { group: 'linked', kind: 'linked', k: `linked:${k}`, pr: m[1] === 'pr' ? `${m[2]}#${m[3]}` : null, ref: `${shortRepo(m[2])} #${m[3]}`, url,
    title: `${m[2]}#${m[3]}`, src: 'GitHub', glyph: 'todo', label: ['not in your lists'], step: 'Not in your lists.', data: { repo: m[2], number: Number(m[3]) } };
}
document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-open-key]');
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  const it = itemForKey(a.dataset.openKey);
  if (!it) return;
  e.preventDefault(); e.stopPropagation();
  openItem(it);
}, true);

// ---------------------------------------------------------------- the next step
// What to do next on an item, as one verb phrase and how to do it here:
//   { label, run: 'review' }                    open the reviewer picker (your PR)
//   { label, run: 'copilot', skill, prompt }    continue its Copilot chat, or start one
//   { label, run: 'url', url }                  something only GitHub or Jira does (reply)
//   { label, run: 'merge', repo, number, url }  merge your PR (asks first); ↗ beside it opens it
//   { label, run: 'item', k }                   go to the item that holds the next step
//   { label, wait: true }                       nothing for you to do; who or what it waits on
const hasSkill = (n) => (chat.info?.skills || []).some((s) => s.name === n);
// What GitHub and Jira say about a ticket whose PR isn't in your lists: the PRs that carry its
// key (/api/issue/KEY/prs) and the ticket itself. Fetched by the item page and the chat header.
const ticketPrs = new Map(), ticketInfo = new Map();
function loadTicketPrs(key) {
  const hit = ticketPrs.get(key);
  if (hit && Date.now() - hit.at < 120_000) return hit.promise;
  const promise = getJson(`/api/issue/${encodeURIComponent(key)}/prs`).then((d) => { ticketPrs.set(key, { at: Date.now(), promise, prs: d.prs || [] }); return d.prs || []; })
    .catch(() => []);
  ticketPrs.set(key, { at: Date.now(), promise, prs: hit?.prs });
  return promise;
}
const WAITING_STATUS = /review|\bqa\b|verif|test|blocked|waiting|on hold|pending/i;
const prName = (p) => `${shortRepo(p.repo)} #${p.number}`;
// The server says what's next on each item (lib/items.mjs); here it gets what only the page
// knows: a ticket's PR, whether a Copilot chat already works on it, and which skills you have.
function nextStep(it, rel = relatedItems(it, xrefAll.length ? xrefAll : inboxItems())) {
  if (it.pr && prClosed.has(it.pr)) return { label: `${prClosed.get(it.pr)}: nothing left on this PR`, wait: true };
  if (it.kind !== 'mention' && (it.issue || it.kind === 'issue' || it.kind === 'linked')) {
    // A ticket with a PR: the PR's next step is the ticket's.
    const pr = rel.find((x) => x.kind === 'pr' || x.kind === 'review');
    if (pr) { const n = nextStep(pr, []); return !n ? null : n.wait ? { ...n, label: `${pr.ref}: ${n.label.toLowerCase()}` } : { label: `${n.label} (${pr.ref})`, run: 'item', k: pr.k }; }
    // A PR found by the ticket's key, when none is in your lists.
    const found = it.issue && ticketPrs.get(it.issue)?.prs;
    const open = found?.find((p) => p.state === 'open');
    if (open) {
      const n = open.next;
      if (n.wait) return { ...n, label: `${prName(open)}: ${n.label[0].toLowerCase()}${n.label.slice(1)}` };
      return { ...n, label: `${n.label} (${prName(open)})`, ...(n.run === 'review' && { repo: open.repo, number: open.number }), ...(n.skill && { skill: hasSkill('continue-work') ? 'continue-work' : '' }) };
    }
    // No open PR: where the ticket stands says it.
    const t = ticketInfo.get(it.issue) || (it.kind === 'ticket' ? it.data : null);
    const merged = found?.find((p) => p.state === 'merged');
    if (t?.statusCategory === 'done') return { label: `${t.status}: nothing left to do`, wait: true };
    if (t?.status && WAITING_STATUS.test(t.status)) return { label: `Waiting: ${t.status}${merged ? ` (${prName(merged)} merged)` : ''}`, wait: true };
    if (it.kind === 'linked' && t?.assignee) return { label: `Assigned to ${t.assignee}`, wait: true };
  }
  const n = it.next || (it.kind === 'linked' ? { label: 'Start it', run: 'start' } : null);
  if (!n || n.wait || n.run !== 'start' && n.skill !== 'continue') return n;
  const cont = hasSkill('continue-work') ? 'continue-work' : '';
  if (n.run !== 'start') return { ...n, skill: cont };
  const chats = cpLinks.links[itemKey(it.url || '')] || [], did = cpLinks.actions?.[itemKey(it.url || '')]?.text;
  const feature = hasSkill('feature-delivery') ? 'feature-delivery' : cont;
  if (chats.some((c) => c.status === 'working')) return { label: 'Copilot is working on it', wait: true };
  if (chats.length) return { label: `Continue the Copilot chat${did ? `: it ${did}` : ''}`, run: 'copilot', skill: cont || feature, prompt: '' };
  return { label: it.glyph === 'prog' ? 'Pick it up in Copilot' : 'Start it in Copilot', tip: 'Copilot makes the branch, writes the code and opens the PR', run: 'copilot', skill: feature, prompt: '' };
}
function nextHtml(it, n = nextStep(it)) {
  if (!n) return '';
  return n.wait ? `<span class="next wait">${icon('wait', 13)} ${esc(n.label)}</span>`
    : `<button class="next" data-next="${esc(it.k)}" title="${n.run === 'merge' ? `Merge ${esc(n.repo)}#${esc(n.number)} on GitHub` : esc(n.tip || `Next step: ${n.label}`)}">→ ${esc(n.label)}</button>${n.run === 'merge' && n.url ? `<a class="next-ext" href="${esc(n.url)}" target="_blank" rel="noopener" title="Open on GitHub" aria-label="Open on GitHub">↗</a>` : ''}`;
}
// Merging your PR from its next-step button: asks first, then says how it went in place.
async function mergePr(n, btn) {
  if (!confirm(`Merge ${n.repo}#${n.number}?`)) return;
  const label = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = 'Merging…'; }
  try {
    const r = await post('/api/pr/merge', { repo: n.repo, number: n.number });
    if (btn) btn.textContent = `✓ Merged${r.method ? ` (${r.method})` : ''}`;
    if (n.url) mergedAt.set(n.url, Date.now());
    if (typeof prClosed !== 'undefined') prClosed.set(`${n.repo}#${n.number}`, 'Merged');
    // Let the ✓ show for a moment, then the list without it; fetch again once GitHub has caught up.
    setTimeout(() => { renderToday(); loadSource('github', true); }, 1200);
    setTimeout(() => loadSource('github', true).then(loadPlan), 8000);
  } catch (err) {
    if (btn) { btn.disabled = false; btn.textContent = label; }
    alert(`Couldn't merge ${n.repo}#${n.number}: ${err.message}`);
  }
}
// Doing the next step: the reviewer picker in place, Copilot in its chat, or GitHub/Jira.
function runNext(it, btn) {
  const n = nextStep(it);
  if (!n || n.wait) return;
  if (n.run === 'url') return window.open(n.url, '_blank', 'noopener');
  if (n.run === 'merge') return mergePr(n, btn);
  if (n.run === 'item') { const x = (xrefAll.length ? xrefAll : inboxItems()).find((y) => y.k === n.k); return x && openItem(x); }
  if (n.run === 'review') {
    const d = n.repo ? { repo: n.repo, number: n.number } : it.data || {};
    const inChat = !$('#chat').hidden && $(`#chat-ctx [data-rv-open="${d.repo}#${d.number}"]`);
    if (inChat) return inChat.click();
    if ($('#v-item').hidden || curItem?.k !== it.k) { openItem(it); setTimeout(() => $(`#item [data-rv-open="${d.repo}#${d.number}"]`)?.click(), 600); return; }
    return $(`#item [data-rv-open="${d.repo}#${d.number}"]`)?.click();
  }
  if (n.run === 'copilot') {
    const ref = refFromUrl(it.url);
    const linked = (cpLinks.links[itemKey(it.url || '')] || []).slice().sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0))[0];
    if (linked) {
      // Carry on in the chat that already knows this work; the request waits in the box for you to send.
      openChat(true, true);
      // A one-click step (a merge conflict) is sent at once; it waits its turn if the chat is busy.
      openSession(linked.id, linked.cwd).then(() => {
        if (!n.prompt) return;
        $('#chat-text').value = n.auto ? [n.skill && `/${n.skill}`, n.prompt].filter(Boolean).join(' ') : n.prompt;
        if (n.auto) $('#chat-form').requestSubmit(); else $('#chat-text').focus();
      });
      return;
    }
    if (!ref) return;
    if (!chat.session || chat.turns || chat.stop) newChat();
    chat.refs = [];
    addRef(ref);
    openChat(true, true);
    send([n.skill && `/${n.skill}`, n.prompt].filter(Boolean).join(' ') || 'What is the next step on this?');
  }
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-next]');
  if (!b) return;
  e.preventDefault(); e.stopPropagation();
  const k = b.dataset.next;
  const it = (xrefAll.length ? xrefAll : inboxItems()).find((y) => y.k === k) || (curItem?.k === k ? curItem : null)
    || (k.startsWith('linked:') ? itemForKey(k.slice(7)) : null);
  if (it) runNext(it, b);
}, true);

// A link to a related item: opens it here, or on its own site when it isn't listed.
function xrefChip(x, withState) {
  const [lt, tone] = x.label || [];
  const name = x.issue || x.ref;
  return `<a class="xref" href="${esc(x.url)}" target="_blank" rel="noopener" data-xref="${esc(x.k)}" title="Open ${esc(name)} here: ${esc(x.title)}${lt ? ` (${esc(lt)})` : ''}">${tone ? `<i class="${esc(tone)}"></i>` : ''}${esc(name)}${withState && lt ? ` · ${esc(lt)}` : ''}</a>`;
}
let xrefAll = [];
document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-xref]');
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  const k = a.dataset.xref;
  const x = (xrefAll.length ? xrefAll : inboxItems()).find((y) => y.k === k) || (k.startsWith('linked:') ? unlistedTicket(k.slice(7)) : null);
  if (!x) return;
  e.preventDefault(); e.stopPropagation();
  openItem(x);
}, true);

// Copilot sessions open anywhere (here, a terminal, an editor), most urgent first.
// The state of one of your PRs by its item key (pr:owner/repo#n), as a short line.
function prStateOf(k) {
  const p = k?.startsWith('pr:') && (state.github?.myPrs || []).find((x) => `pr:${x.repo}#${x.number}` === k);
  return p?.status ? `PR: ${p.status.label}${p.status.detail ? ` (${p.status.detail})` : ''}` : '';
}
function sessionItems() {
  const order = { 'needs-you': 0, waiting: 1, working: 2 };
  const linked = (id) => Object.entries(cpLinks.links || {}).find(([, l]) => l.some((x) => x.id === id))?.[0];
  return [...(cpLinks.live || [])].sort((a, b) => order[a.status] - order[b.status] || Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .map((x) => {
      const k = linked(x.id), folder = (x.cwd || '').split('/').filter(Boolean).pop() || '';
      // A chat on one of your PRs also shows where the PR stands (review rounds, CI, reviewer).
      const st = prStateOf(k);
      return { group: 'copilot', kind: 'session', sid: x.id, cwd: x.cwd, k: `cp:${x.id}`, title: x.title || 'Copilot chat',
        ref: k ? k.replace(/^(pr|gh):[\w.-]+\//, '').replace('#', ' #').replace(/^issue:/, '') : folder, step: [st, k ? folder : ''].filter(Boolean).join(' · '),
        glyph: `s-${x.status}`, label: [STATUS_TEXT[x.status] || x.status, x.status === 'needs-you' ? 'amber' : x.status === 'working' ? 'green' : 'blue'],
        at: x.updatedAt, status: x.status };
    });
}

const LIST_VIEWS = { inbox: 'Work', reviews: 'Reviews', prs: 'Your PRs', mentions: 'Mentions', tickets: 'Tickets' };
let listView = 'inbox', listItems = [], selK = null, showWaiting = false;

// Your PRs and Tickets show as tables: what links to what, and which branch the work is on.
// Columns can be resized (drag a header edge) and hidden (Columns); that's kept in this browser.
const WORK_COLS = {
  prs: [['id', 'PR', 110], ['t', 'Title'], ['r', 'Read by you', 150], ['x', 'Ticket', 110], ['b', 'Branch', 180], ['s', 'State', 150], ['u', 'Updated', 64]],
  tickets: [['id', 'Ticket', 96], ['t', 'Title'], ['x', 'Pull requests', 200], ['b', 'Branch', 180], ['v', 'Fix version', 100], ['a', 'Assignee', 120], ['p', 'Priority', 90], ['s', 'State', 120], ['u', 'Updated', 64]],
};
const WCOLS_KEY = 'clearsky.work.cols';
let wcolPrefs = {};
try { wcolPrefs = JSON.parse(localStorage.getItem(WCOLS_KEY) || '{}') || {}; } catch {}
const wprefs = (v) => (wcolPrefs[v] ||= { widths: {}, hidden: [] });
const saveWcols = () => { try { localStorage.setItem(WCOLS_KEY, JSON.stringify(wcolPrefs)); } catch {} };
const wcolWidth = (v, c) => Math.min(480, Math.max(40, wprefs(v).widths[c] || WORK_COLS[v].find((x) => x[0] === c)[2]));
function applyWcols() {
  const el = $('#list'), v = listView, cols = WORK_COLS[v];
  el.classList.remove(...[...el.classList].filter((c) => c.startsWith('no-')));
  if (!cols) return el.style.removeProperty('--wcols');
  const off = new Set([...wprefs(v).hidden, ...(wcolEmpty[v] || [])]);
  // When the window is too narrow for every column, the least needed ones step aside until the
  // title has room again (they come back when it widens; Columns still hides them for good).
  const room = (el.clientWidth || innerWidth) - 40, need = () => cols.filter(([c]) => !off.has(c)).reduce((n, [c]) => n + (c === 't' ? TITLE_MIN : wcolWidth(v, c)) + 10, 26);
  for (const c of AUTO_DROP) if (need() > room && cols.some(([x]) => x === c)) off.add(c);
  el.style.setProperty('--wcols', ['16px', ...cols.filter(([c]) => !off.has(c)).map(([c]) => (c === 't' ? `minmax(${TITLE_MIN}px, 1fr)` : `${wcolWidth(v, c)}px`))].join(' '));
  off.forEach((c) => el.classList.add(`no-${c}`));
}
// Columns with nothing to show in any row step aside too (Read by you, before GitHub has told who wrote what).
const wcolEmpty = {};
const TITLE_MIN = 260, AUTO_DROP = ['a', 'v', 'p', 'u', 'b', 'x'];
let wcolsTimer;
window.addEventListener('resize', () => { clearTimeout(wcolsTimer); wcolsTimer = setTimeout(() => { if (WORK_COLS[listView]) applyWcols(); }, 100); });
// Sorting by a column: click a header (again to reverse, a third time for the usual order).
// Within each group, so what needs you stays on top.
const natural = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
const TONE_RANK = { red: 0, amber: 1, blue: 2, green: 3 };
const PRIORITY_RANK = { blocker: 0, highest: 0, critical: 1, high: 1, major: 2, medium: 2, low: 3, minor: 3, lowest: 4, trivial: 4 };
const PRIORITY_TONE = (p) => ['red', 'red', 'amber', 'gray', 'gray'][PRIORITY_RANK[String(p).toLowerCase()]] || 'gray';

// Quick filters over a table: one menu per field, its values (with counts) from the rows in view.
// Fields combine; remembered per table.
const FILTERS = {
  tickets: [['fix', 'Fix version', (x) => (x.data?.fixVersions?.length ? x.data.fixVersions.map((v) => v.name) : x.data?.fixVersions ? ['(none)'] : [])],
    ['assignee', 'Assignee', (x) => [x.data?.assignee || (x.kind === 'ticket' ? '(unassigned)' : '')]], ['priority', 'Priority', (x) => [x.data?.priority]],
    ['state', 'State', (x) => [x.data?.status || x.label?.[0]]], ['type', 'Type', (x) => [x.data?.type]], ['project', 'Project', (x) => [x.data?.project || x.data?.repo]]],
  prs: [['state', 'State', (x) => [x.data?.status?.label]], ['read', 'Read', (x) => [x.data?.own && (x.data.own.state === 'read' ? 'read' : 'not read')]], ['repo', 'Repo', (x) => [x.data?.repo]]],
};
const filterVals = (f, x) => f[2](x).filter(Boolean);
const passesFilters = (v, x) => (FILTERS[v] || []).every((f) => { const want = wprefs(v).filter?.[f[0]]; return !want || filterVals(f, x).includes(want); });
function filterBar(v, rows) {
  const on = wprefs(v).filter || {};
  return (FILTERS[v] || []).map((f) => {
    const counts = new Map();
    for (const x of rows) for (const val of filterVals(f, x)) counts.set(val, (counts.get(val) || 0) + 1);
    if (!counts.size && !on[f[0]]) return '';
    const opts = [...counts].sort((a, b) => natural(a[0], b[0]));
    if (on[f[0]] && !counts.has(on[f[0]])) opts.push([on[f[0]], 0]);
    return `<select class="qf${on[f[0]] ? ' on' : ''}" data-qf="${f[0]}" aria-label="Filter by ${f[1].toLowerCase()}"><option value="">${f[1]}: all</option>${
      opts.map(([val, n]) => `<option value="${esc(val)}"${on[f[0]] === val ? ' selected' : ''}>${f[1]}: ${esc(val)} (${n})</option>`).join('')}</select>`;
  }).join('') + (Object.values(on).some(Boolean) ? '<button class="qf-clear" data-qf-clear>Clear filters</button>' : '');
}
document.addEventListener('change', (e) => {
  const s = e.target.closest('[data-qf]');
  if (!s || !FILTERS[listView]) return;
  const p = wprefs(listView);
  p.filter = { ...(p.filter || {}), [s.dataset.qf]: s.value || undefined };
  saveWcols(); renderList();
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('[data-qf-clear]') || !FILTERS[listView]) return;
  wprefs(listView).filter = {}; saveWcols(); renderList();
});
function sortKey(it, c) {
  const d = it.data || {};
  switch (c) {
    case 'id': return it.issue || it.ref || '';
    case 't': return it.title || '';
    case 'x': return relatedItems(it, xrefAll)[0]?.ref || '';
    case 'b': return branchesOf(it, relatedItems(it, xrefAll))[0]?.branch || '';
    case 'v': return d.fixVersions?.length ? d.fixVersions.map((v) => v.name).join(', ') : null;
    case 'a': return d.assignee || null;
    case 'p': return d.priority ? `${PRIORITY_RANK[d.priority.toLowerCase()] ?? 5} ${d.priority}` : null;
    case 's': return it.label ? `${TONE_RANK[it.label[1]] ?? 4} ${it.label[0]}` : null;
    case 'u': return it.at ? Date.parse(it.at) || 0 : null;
    case 'r': return d.own ? `${{ unread: 0, new: 1, read: 2 }[d.own.state]} ${d.own.label[0]}` : null;
    default: return '';
  }
}
function sortRows(v, items) {
  const s = wprefs(v).sort;
  if (!s) return items;
  const dir = s.dir === 'desc' ? -1 : 1;
  return [...items].sort((a, b) => {
    const x = sortKey(a, s.c), y = sortKey(b, s.c);
    if (x == null || x === '') return y == null || y === '' ? 0 : 1; // empty last, either way
    if (y == null || y === '') return -1;
    return dir * (typeof x === 'number' ? x - y : natural(x, y));
  });
}
document.addEventListener('click', (e) => {
  const h = e.target.closest('.wt-head [data-wsort]');
  if (!h || e.target.closest('.rz') || !WORK_COLS[listView]) return;
  const p = wprefs(listView), c = h.dataset.wsort;
  p.sort = p.sort?.c !== c ? { c, dir: c === 'u' ? 'desc' : 'asc' } : p.sort.dir === (c === 'u' ? 'desc' : 'asc') ? { c, dir: c === 'u' ? 'asc' : 'desc' } : null;
  saveWcols(); renderList();
});
function workHead(v, rows = []) {
  const cols = WORK_COLS[v], off = new Set(wprefs(v).hidden), s = wprefs(v).sort;
  const menu = `<div class="wt-bar pick">${filterBar(v, rows)}<details class="cols"><summary>Columns</summary><div class="menu">${cols.filter(([c]) => c !== 't').map(([c, label]) =>
    `<label><input type="checkbox" data-wcol="${c}"${off.has(c) ? '' : ' checked'}> ${label}</label>`).join('')}
    <button class="reset" data-wcols-reset>Reset widths</button></div></details></div>`;
  const arrow = (c) => (s?.c === c ? (s.dir === 'desc' ? ' ▼' : ' ▲') : '');
  const aria = (c) => (s?.c === c ? (s.dir === 'desc' ? 'descending' : 'ascending') : 'none');
  return `${menu}<div class="wt-head"><span></span>${cols.map(([c, label]) => `<span class="c-${c} sortable" data-wsort="${c}" role="columnheader" aria-sort="${aria(c)}" title="Sort by ${label.toLowerCase()}">${label}${arrow(c)}${c !== 't' ? `<i class="rz" data-wrz="${c}" title="Drag to resize"></i>` : ''}</span>`).join('')}</div>`;
}
document.addEventListener('change', (e) => {
  const c = e.target.closest('[data-wcol]')?.dataset.wcol;
  if (!c || !WORK_COLS[listView]) return;
  const p = wprefs(listView);
  p.hidden = e.target.checked ? p.hidden.filter((x) => x !== c) : [...new Set([...p.hidden, c])];
  saveWcols(); applyWcols();
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('[data-wcols-reset]') || !WORK_COLS[listView]) return;
  wprefs(listView).widths = {}; saveWcols(); applyWcols();
});
document.addEventListener('pointerdown', (e) => {
  const h = e.target.closest('[data-wrz]');
  if (!h) return;
  e.preventDefault();
  const v = listView, c = h.dataset.wrz, x0 = e.clientX, w0 = wcolWidth(v, c);
  h.classList.add('on'); h.setPointerCapture(e.pointerId);
  const move = (ev) => { wprefs(v).widths[c] = Math.round(w0 + ev.clientX - x0); applyWcols(); };
  const up = () => { h.classList.remove('on'); h.removeEventListener('pointermove', move); h.removeEventListener('pointerup', up); wprefs(v).widths[c] = wcolWidth(v, c); saveWcols(); };
  h.addEventListener('pointermove', move); h.addEventListener('pointerup', up);
});

// Branches in your clones that carry a ticket's key, local or pushed.
let ticketBranches = {};
const loadBranches = () => fetch('/api/branches').then((r) => r.json()).then((d) => {
  ticketBranches = d.branches || {};
  if (!$('#v-list').hidden && listView === 'tickets') renderList();
}).catch(() => {});
setInterval(() => { if (!document.hidden) loadBranches(); }, 60_000);
// The branches an item is on: a PR's head branch; for a ticket, its PRs' branches and any in your clones.
function branchesOf(it, rel) {
  if (it.pr) return it.data?.branch ? [{ branch: it.data.branch, repo: it.data.repo }] : [];
  const out = new Map();
  rel.filter((x) => x.data?.branch).forEach((x) => out.set(x.data.branch, { branch: x.data.branch, repo: x.data.repo, pr: true }));
  (ticketBranches[it.issue] || []).forEach((b) => out.set(b.branch, { ...out.get(b.branch), ...b }));
  return [...out.values()];
}
function branchCell(list) {
  if (!list.length) return '';
  const tip = list.map((b) => `${b.repo ? `${shortRepo(b.repo)}: ` : ''}${b.branch}${b.pr ? ' (PR)' : b.local && !b.remote ? ' (local only)' : b.remote && !b.local ? ' (remote only)' : ''}`).join('\n');
  return `<span title="${esc(tip)}">${esc(list[0].branch)}${list.length > 1 ? ` +${list.length - 1}` : ''}</span>`;
}
// The next step in a row, only when there's something for you to do.
function rowNext(it, rel) {
  if (it.kind === 'session' || it.group === 'linked') return '';
  const n = nextStep(it, rel);
  return n && !n.wait ? nextHtml(it, n) : '';
}
// A PR's title without the ticket key it starts with ("ABC-12: …", "[ABC-12] …") when the
// Ticket column shows that key anyway.
function tableTitle(it, rel) {
  if (!it.pr || $('#list').classList.contains('no-x')) return it.title;
  const m = it.title.match(/^\[?([A-Z][A-Z0-9_]+-\d+)\]?[:\s-]+\s*(.+)$/);
  return m && rel.some((x) => x.issue === m[1]) ? m[2] : it.title;
}
function tableRow(it, i, rel, chips, acts, fresh) {
  const [lt, tone] = it.label || [];
  const readCol = !!it.data?.own && !$('#list').classList.contains('no-r');
  const cell = {
    id: `<span class="c c-id id"${refAttrs(it)}>${esc(it.issue || it.ref || '')}</span>`,
    // A table keeps a row to its title and next step; the details are on hover and in the other columns.
    t: `<span class="c c-t t"${it.step ? ` title="${esc(`${it.title}\n${it.step}`)}"` : ''}><a href="${esc(it.url)}" target="_blank" rel="noopener">${esc(tableTitle(it, rel))}</a>${readCol && /^Read /.test(nextStep(it, rel)?.label || '') ? '' : rowNext(it, rel)}${chips}</span>`,
    x: `<span class="c c-x">${rel.slice(0, 3).map((x) => xrefChip(x, !it.pr)).join('')}</span>`,
    b: `<span class="c c-b">${branchCell(branchesOf(it, rel))}</span>`,
    v: `<span class="c c-v${(it.data?.fixVersions || []).some((v) => v.released) && it.data?.statusCategory !== 'done' ? ' warn' : ''}"${it.data?.fixVersions ? ` title="${esc(fixText(it.data))}"` : ''}>${it.data?.fixVersions ? (it.data.fixVersions.length ? esc(it.data.fixVersions.map((v) => v.name).join(', ')) : '<span class="muted">none</span>') : ''}</span>`,
    a: `<span class="c c-a">${esc(it.data?.assignee || '')}</span>`,
    p: `<span class="c c-p">${it.data?.priority ? `<span class="lbl ${PRIORITY_TONE(it.data.priority)}"><i></i>${esc(it.data.priority)}</span>` : ''}</span>`,
    s: `<span class="c c-s">${lt ? `<span class="lbl${tone ? ` ${tone}` : ''}">${tone ? '<i></i>' : ''}${esc(lt)}</span>` : ''}</span>`,
    u: `<span class="c c-u age">${esc(shortAgo(it.at))}</span>`,
    r: `<span class="c c-r">${ownCell(it.data?.own, it.url)}</span>`,
  };
  return `<li class="r tbl${it.group === 'waiting' ? ' quiet' : ''}${it.k === selK ? ' sel' : ''}" data-i="${i}" tabindex="-1">
    ${fresh ? '<span class="new-dot" title="New since you last looked" aria-label="New"></span>' : ''}<span class="st ${esc(it.glyph)}"></span>
    ${WORK_COLS[listView].map(([c]) => cell[c]).join('')}${acts}</li>`;
}

// "Read by you" on one of your PRs (lib/own-read.mjs): who wrote what you haven't read, and a
// button that marks it read up to its latest commit.
function ownCell(own, url) {
  if (!own) return '';
  const [lt, tone] = own.label;
  const tip = own.state === 'read' ? (own.viaViewed ? 'Every file is ticked Viewed on GitHub.' : own.readOid ? 'You marked this read at its latest commit.' : 'Every commit is yours.')
    : `${own.step}\nWritten by: ${own.writers.join(', ')}`;
  const mark = own.state !== 'read' ? `<button class="own-read" data-own-read="${esc(url)}" data-oid="${esc(own.headOid || '')}" title="Mark read: I've read it, up to the latest commit" aria-label="Mark read">✓</button>`
    : own.readOid ? `<button class="own-read undo" data-own-read="${esc(url)}" data-oid="" title="Mark as not read" aria-label="Mark as not read">↺</button>` : '';
  if (!tone) return `<span class="muted" title="${esc(tip)}">${esc(lt)}</span>${mark}`;
  return `<span class="lbl ${tone}" title="${esc(tip)}"><i></i>${esc(lt)}</span>${mark}`;
}
async function markOwnRead(url, oid) {
  await post('/api/read', { marks: [{ key: `prread:${url}`, at: oid || null }] });
  await loadSource('github');
  // The PR's page in Clearsky shows the new state too.
  if (location.hash === '#item' && curItem?.url === url) { curItem = inboxItems().find((x) => x.k === curItem.k) || curItem; renderItem(); }
}
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-own-read]');
  if (!b) return;
  e.preventDefault(); e.stopPropagation();
  b.disabled = true;
  try { await markOwnRead(b.dataset.ownRead, b.dataset.oid); readAsk(null); } catch (err) { b.disabled = false; $('#status').textContent = `Could not save: ${err.message}`; }
}, true);

// Opening one of your unread PRs on GitHub from here (its link, "Read it", Open on GitHub): when
// you come back to Clearsky, a note asks whether you read it, with Mark read. Clearsky can't see
// what you read on GitHub, so it asks instead of guessing. Ticking every file Viewed there counts
// by itself.
let readPending = null;
function ownUnreadFor(href) {
  if (!href) return null;
  const p = (state.github?.myPrs || []).find((x) => x.own && x.own.state !== 'read' && (href === x.url || href.startsWith(`${x.url}/`)));
  return p ? { url: p.url, oid: p.own.headOid, title: `${shortRepo(p.repo)} #${p.number} ${p.title}` } : null;
}
function readAsk(p) {
  readPending = null;
  const el = $('#read-ask');
  el.hidden = !p;
  if (!p) return;
  el.innerHTML = `<span>Did you read <b>${esc(p.title)}</b>?</span><button class="primary" data-own-read="${esc(p.url)}" data-oid="${esc(p.oid || '')}">Mark read</button><button data-read-ask-no>Not yet</button>`;
}
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-read-ask-no]')) return readAsk(null);
  const a = e.target.closest('a[href^="https://github.com/"]');
  const n = !a && e.target.closest('[data-next]') && nextStep(listItems.find((x) => x.k === e.target.closest('[data-next]').dataset.next) || curItem || {});
  const p = ownUnreadFor(a ? a.href : n?.run === 'url' ? n.url : null);
  if (p) readPending = { ...p, at: Date.now() };
}, true);
const backFromGitHub = () => { if (readPending && !document.hidden && Date.now() - readPending.at > 3000) readAsk(readPending); };
window.addEventListener('focus', backFromGitHub);
document.addEventListener('visibilitychange', backFromGitHub);

function itemRow(it, i) {
  const [lt, tone] = it.label || [];
  const fresh = it.kind !== 'session' && isNew(it.k, it.stamp);
  const chips = it.url ? (cpLinks.links[itemKey(it.url)] || []).slice(0, 1).map((x) => chip(x, !WORK_COLS[listView])).join('') : '';
  const acts = it.kind === 'session' ? '' : `<span class="ra">${refFromUrl(it.url) ? `<button class="ask" data-ask="${esc(it.url)}" data-title="${esc(it.title)}" title="Copilot on this (A)" aria-label="Copilot on this">✦</button>` : ''}
    <button data-mute="${esc(it.k)}" title="Snooze (H)" aria-label="Snooze">${MUTE_ICON}</button>
    <button data-done="${esc(it.k)}" data-stamp="${esc(it.stamp ?? '')}" title="Done: hide until there's something new (E)" aria-label="Done">${DONE_ICON}</button></span>`;
  const rel = it.kind === 'session' ? [] : relatedItems(it, xrefAll);
  if (WORK_COLS[listView]) return tableRow(it, i, rel, chips, acts, fresh);
  // One related ticket or PR at most (it opens here); the rest is on the item's page.
  const xrefs = rel.slice(0, 1).map((x) => xrefChip(x, !it.pr)).join('');
  return `<li class="r${it.group === 'waiting' ? ' quiet' : ''}${it.k === selK ? ' sel' : ''}" data-i="${i}" tabindex="-1">
    ${fresh ? '<span class="new-dot" title="New since you last looked" aria-label="New"></span>' : ''}<span class="st ${esc(it.glyph)}"></span>
    <span class="id"${refAttrs(it)}>${esc(it.ref || '')}</span>
    <span class="t"><a href="${esc(it.url || '#copilot')}"${it.url ? ' target="_blank" rel="noopener"' : ''}>${esc(it.title)}</a>${xrefs}${rowNext(it, rel)}${it.step ? `<span class="step">${esc(it.step)}</span>` : ''}</span>
    <span class="lb">${chips}${lt ? `<span class="lbl${tone ? ` ${tone}` : ''}">${tone ? '<i></i>' : ''}${esc(lt)}</span>` : ''}</span>
    <span class="age">${esc(shortAgo(it.at))}</span>${acts}</li>`;
}

// The quick filter above a list: every word must turn up in the row (its key, title, repo,
// branch, status, who). Kept per list while the page is open.
const listQ = {};
function matchesQ(x, q) {
  if (!q) return true;
  const d = x.data || {};
  const hay = [x.ref, x.issue, x.pr, x.title, x.step, x.src, ...(x.label || []), x.next?.label, d.repo, d.branch, d.status?.label || d.status, d.status?.detail, d.author,
    d.type, d.priority, d.assignee, ...(d.fixVersions || []).map((v) => v.name), ...(d.pendingReviewers || []), ...(d.approvals || [])].filter(Boolean).join(' ').toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}
function renderList() {
  const el = $('#list'), all = inboxItems(), q = (listQ[listView] || '').trim();
  const shown = all.filter((x) => !x.done && !x.snoozed && matchesQ(x, q));
  const live = WORK_COLS[listView] ? shown.filter((x) => passesFilters(listView, x)) : shown;
  xrefAll = all;
  if ($('#list-q').value !== (listQ[listView] || '')) $('#list-q').value = listQ[listView] || '';
  const by = (f) => live.filter(f);
  const sources = [['GitHub', state.github], ['Jira', state.jira], ['Jira mentions', state.jiraMentions], ['Slack', state.slack]];
  const errs = sources.filter(([, s]) => s?.error).map(([n, s]) => `<div class="err">${esc(n)}: ${esc(s.error)}</div>`).join('')
    + sources.filter(([, s]) => s?.paused).map(([n, s]) => `<div class="paused">${esc(n)}: paused, ${esc(s.paused)}</div>`).join('');
  const loading = sources.some(([, s]) => !s);
  const groups = [];
  const group = (title, glyph, items, opts = {}) => groups.push({ title, glyph, items, ...opts });
  if (listView === 'inbox') {
    group('Copilot now', 's-working', sessionItems().filter((x) => matchesQ(x, q)), { hideEmpty: true });
    group('Needs you', 'ment', by((x) => x.group === 'needs'), { empty: loading ? null : 'Nothing needs you right now.' });
    group('Your tickets', 'prog', by((x) => x.group === 'tickets'), { hideEmpty: true });
    group('Waiting on others', 'wait', by((x) => x.group === 'waiting'), { hideEmpty: true, fold: !showWaiting });
  } else if (listView === 'reviews') group('Reviews for you', 'rev', by((x) => x.kind === 'review'), { empty: 'No reviews waiting.' });
  else if (listView === 'prs') {
    // Code under your name you haven't read (Copilot's, a colleague's) first, those out for review on top.
    const unread = (x) => x.kind === 'pr' && x.data?.own && x.data.own.state !== 'read';
    const risk = (x) => ({ approved: 0, asked: 1 }[x.data.own.risk] ?? 2);
    group('Not read by you', 'rev', by(unread).sort((a, b) => risk(a) - risk(b)), { hideEmpty: true });
    group('On your move', 'chg', by((x) => x.kind === 'pr' && x.group === 'needs' && !unread(x)), { empty: 'Nothing on your move.' });
    group('Waiting on others', 'wait', by((x) => x.kind === 'pr' && x.group === 'waiting' && !unread(x)), { hideEmpty: true });
  } else if (listView === 'mentions') group('Mentions', 'ment', by((x) => x.kind === 'mention'), { empty: 'No new mentions.' });
  else if (listView === 'tickets') {
    group('In progress', 'prog', by((x) => x.kind === 'ticket' && x.glyph === 'prog'), { hideEmpty: true });
    group('To do', 'todo', by((x) => x.kind === 'ticket' && x.glyph === 'todo'), { empty: 'Nothing assigned.' });
    group('GitHub issues', 'todo', by((x) => x.kind === 'issue'), { hideEmpty: true });
  }
  listItems = [];
  const inView = { prs: (x) => x.kind === 'pr', tickets: (x) => x.kind === 'ticket' || x.kind === 'issue' }[listView];
  if (listView === 'prs') wcolEmpty.prs = shown.some((x) => x.data?.own) ? [] : ['r'];
  let html = errs + (WORK_COLS[listView] ? workHead(listView, inView ? shown.filter(inView) : []) : '');
  applyWcols();
  if (q) for (const g of groups) { g.hideEmpty = true; }
  if (q && groups.every((g) => !g.items.length)) html += `<div class="empty">Nothing here matches “${esc(q)}”.</div>`;
  for (const g of groups) {
    if (!g.items.length && g.hideEmpty) continue;
    const head = `<div class="gh"><span class="st ${g.glyph}" style="width:12px;height:12px"></span>${esc(g.title)} <span class="n">${g.items.length}</span>`;
    if (g.fold) {
      const peek = g.items.slice(0, 3).map((x) => `${x.ref}${x.step ? ` ${x.step}` : ''}`).join(' · ');
      html += `${head}<span class="more-l">· ${esc(peek)}</span><span class="spacer" style="flex:1"></span><button data-unfold>Show</button></div>`;
      continue;
    }
    html += `${head}${g.title === 'Waiting on others' && listView === 'inbox' ? '<span class="spacer" style="flex:1"></span><button data-unfold>Hide</button>' : ''}</div>`;
    if (WORK_COLS[listView]) g.items = sortRows(listView, g.items);
    html += g.items.length ? `<ul class="list">${g.items.map((it) => itemRow(it, listItems.push(it) - 1)).join('')}</ul>`
      : g.empty === null ? skeleton(3) : `<div class="empty">✓ ${esc(g.empty)}</div>`;
  }
  // What you put away: done (back when something new happens) and snoozed (back at a set time).
  const scope = (x) => listView === 'inbox' || x.kind === { reviews: 'review', prs: 'pr', mentions: 'mention', tickets: 'ticket' }[listView];
  const done = all.filter((x) => x.done && scope(x)), later = all.filter((x) => x.snoozed && scope(x));
  if (done.length || later.length) {
    const label = [done.length && `${done.length} done`, later.length && `${later.length} snoozed`].filter(Boolean).join(', ');
    const item = (m, note, btn) => `<li><a href="${esc(m.url)}" target="_blank" rel="noopener">${esc(m.ref)} · ${esc(m.title)}</a><span>${note}</span>${btn}</li>`;
    html += `<div class="inbox-foot"><button class="muted-toggle" id="later-toggle">${showLater ? 'Hide' : 'Show'} ${label}</button>${showLater ? `<ul class="muted-list">${
      done.map((m) => item(m, 'done', `<button data-undone="${esc(m.k)}">Undo</button>`)).join('')}${
      later.map((m) => item(m, `until ${when(m.snoozed)}`, `<button data-unmute="${esc(m.k)}">Unsnooze</button>`)).join('')}</ul>` : ''}</div>`;
  }
  const top = el.scrollTop;
  el.innerHTML = html || skeleton(5);
  el.scrollTop = top;
}
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-unfold]')) { showWaiting = !showWaiting; renderList(); return; }
  if (e.target.closest('#later-toggle')) { showLater = !showLater; renderList(); return; }
  const r = e.target.closest('#list .r');
  if (!r || e.target.closest('button, .cp-chip, .next-ext') || getSelection().toString()) return;
  // Ctrl/Cmd-click on the title still opens the source's own page.
  if (e.target.closest('a') && (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0)) return;
  e.preventDefault();
  select(r);
  openItem(listItems[Number(r.dataset.i)]);
});

function select(r) {
  if (!r) return;
  document.querySelectorAll('#list .r.sel').forEach((x) => x.classList.remove('sel'));
  r.classList.add('sel');
  selK = listItems[Number(r.dataset.i)]?.k;
  r.scrollIntoView({ block: 'nearest' });
}

// J/K to move, Enter to open, E done, H snooze, A Copilot, O open the source's page.
document.addEventListener('keydown', (e) => {
  if ($('#v-list').hidden || e.ctrlKey || e.metaKey || e.altKey || e.target.closest?.('input, textarea, select, [contenteditable]') || !menu.hidden) return;
  const rows = [...document.querySelectorAll('#list .r')], cur = document.querySelector('#list .r.sel'), i = rows.indexOf(cur);
  const k = e.key.toLowerCase();
  if (k === 'j' || e.key === 'ArrowDown') { select(rows[Math.min(i + 1, rows.length - 1)] || rows[0]); e.preventDefault(); }
  else if (k === 'k' || e.key === 'ArrowUp') { select(rows[Math.max(i - 1, 0)]); e.preventDefault(); }
  else if (!cur) return;
  else if (e.key === 'Enter') { openItem(listItems[Number(cur.dataset.i)]); e.preventDefault(); }
  else if (k === 'o') { const u = listItems[Number(cur.dataset.i)]?.url; if (u) window.open(u, '_blank', 'noopener'); }
  else if (k === 'e') { cur.querySelector('[data-done]')?.click(); select(rows[i + 1] || rows[i - 1]); }
  else if (k === 'h') { const b = cur.querySelector('[data-mute]'); if (b) { e.preventDefault(); openMuteMenu(b); } }
  else if (k === 'a') { const b = cur.querySelector('[data-ask]'); if (b) { e.preventDefault(); openAskMenu(b); } }
});

$('#list-q').addEventListener('input', (e) => { listQ[listView] = e.target.value; renderList(); });
$('#list-q').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (e.target.value) { e.target.value = ''; listQ[listView] = ''; renderList(); } else $('#list').focus(); }
  if (e.key === 'Enter' || e.key === 'ArrowDown') { e.preventDefault(); $('#list').focus(); }
});
// "/" jumps to the filter from a list.
document.addEventListener('keydown', (e) => {
  if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || $('#v-list').hidden || e.target.closest?.('input, textarea, select, [contenteditable]')) return;
  e.preventDefault();
  $('#list-q').focus();
  $('#list-q').select();
});
// On an item's page, E and H do what they do on its row: Done (and back) and Snooze.
document.addEventListener('keydown', (e) => {
  if ($('#v-item').hidden || e.ctrlKey || e.metaKey || e.altKey || e.target.closest?.('input, textarea, select, [contenteditable]') || !menu.hidden) return;
  const k = e.key.toLowerCase();
  if (k === 'e') { const b = $('#it-acts [data-done]'); if (b) { e.preventDefault(); b.click(); } }
  else if (k === 'h') { const b = $('#it-acts [data-mute]'); if (b) { e.preventDefault(); openMuteMenu(b); } }
});
