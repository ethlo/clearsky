// Clearsky page: one item in full, the stand-up, hover cards and restarting Clearsky.
// The server joins web/js/*.js in name order into one script in index.html, so they share one scope.

// ---------------------------------------------------------------- one item in full

let curItem = null;
function openItem(it) {
  if (!it) return;
  if (it.kind === 'session') { openChat(true, true); if (it.sid !== chat.session || !chat.turns) openSession(it.sid, it.cwd); return; }
  if (it.read) return openReader(it.read.src, it.read.key, it.url);
  curItem = it;
  renderItem();
  location.hash = '#item';
}
// A ticket's fix version, flagged when it's released but the ticket isn't done.
const fixText = (d) => (!d.fixVersions ? '' : !d.fixVersions.length ? 'No fix version'
  : `Fix version ${d.fixVersions.map((v) => v.name).join(', ')}${d.statusCategory !== 'done' && d.fixVersions.some((v) => v.released) ? ' (released, still open)' : ''}`);
function whyLine(it) {
  const d = it.data || {};
  if (it.kind === 'review') return `${esc(d.author)} asked for your ${d.rerequested ? 're-review' : 'review'} ${esc(ago(d.requestedAt))}${d.viaTeam ? ' (via your team)' : ''}.`;
  if (it.kind === 'pr') return `${esc(d.status.label)}${d.status.detail ? `: ${esc(d.status.detail)}` : ''}.${prMeta(d) ? ` ${esc(prMeta(d))[0].toUpperCase()}${esc(prMeta(d)).slice(1)}.` : ''} Updated ${esc(ago(d.updatedAt))}.`;
  if (it.kind === 'mention') return it.src === 'Jira' ? `${esc(d.people.join(', '))} mentioned you ${esc(ago(d.at))}${d.count > 1 ? `, ${d.count} times` : ''}.${d.status ? ` Ticket is ${esc(d.status)}.` : ''}`
    : it.src === 'Slack' ? `${esc(d.by)} mentioned you in ${esc(d.channel)} ${esc(ago(d.at))}.` : `You were mentioned. Updated ${esc(ago(d.updatedAt))}.`;
  if (it.kind === 'ticket') return `Assigned to ${esc(d.assignee || 'you')} · ${esc([d.status, d.type, fixText(d), d.priority && `${d.priority} priority`, d.due && `due ${d.due}`].filter(Boolean).join(' · '))}.`;
  return esc(it.step || '');
}
const PR_TONE = { bad: 'red', warn: 'amber', good: 'green' };
// PRs found merged or closed since the lists were loaded (their page, the chat header): no
// reviewer picker and no next step for them.
const prClosed = new Map();
function notePrState(key, d) {
  if (d?.state === 'MERGED' || d?.state === 'CLOSED') prClosed.set(key, d.state === 'MERGED' ? 'Merged' : 'Closed'); else if (d?.state) prClosed.delete(key);
}
const ticketTone = (t) => (t.statusCategory === 'done' ? 'green' : t.statusCategory === 'indeterminate' ? 'blue' : 'gray');
// Where the work stands, in one place: the ticket's status and each PR's, with who reviews it.
function standsHtml(it, rel) {
  const tickets = new Map(), prs = new Map();
  const addTicket = (key, t) => { if (key && !tickets.has(key)) tickets.set(key, t || ticketInfo.get(key) || null); };
  const addPr = (p) => {
    const k = p?.repo && `${p.repo}#${p.number}`;
    if (!k || prs.has(k)) return;
    const shut = prClosed.get(k);
    prs.set(k, shut ? { ...p, state: shut.toLowerCase(), status: { label: shut, tone: shut === 'Merged' ? 'good' : 'neutral' } } : p);
  };
  if (it.issue) addTicket(it.issue, it.kind === 'ticket' ? { ...it.data, mine: true } : ticketInfo.get(it.issue));
  if (it.pr) addPr({ ...it.data, state: 'open', mine: it.kind === 'pr' });
  for (const x of rel) {
    if (x.issue) addTicket(x.issue, x.kind === 'ticket' ? { ...x.data, mine: true } : ticketInfo.get(x.issue));
    else if (x.pr) addPr({ ...x.data, state: 'open', mine: x.kind === 'pr' });
  }
  if (it.issue) (ticketPrs.get(it.issue)?.prs || []).forEach(addPr);
  const people = (p) => {
    const chips = [...(p.state === 'open' ? p.pendingReviewers || [] : []).map((n) => [n, 'asked', 'gray']), ...(p.changesRequested || []).map((n) => [n, 'changes requested', 'red']),
      ...(p.approvals || []).map((n) => [n, 'approved', 'green'])];
    return chips.length ? chips.map(([n, st, tone]) => `<span class="badge b-${tone}">${esc(n.replace(/^team:/, ''))} · ${st}</span>`).join('')
      : p.state === 'open' && !['No reviewer yet', 'Ready for a reviewer', 'In review rounds', 'CI build running'].includes(p.status?.label) ? '<span class="badge b-amber">No reviewer assigned</span>' : '';
  };
  const rows = [
    ...[...tickets].map(([key, t]) => `<div class="stand"><span class="lbl-next">Ticket</span><a href="#" data-open-key="issue:${esc(key)}">${esc(key)}</a>
      ${t?.status ? `<span class="badge b-${ticketTone(t)}">${esc(t.status)}</span>` : '<span class="muted">…</span>'}
      ${t ? `<span class="muted">${t.mine ? 'assigned to you' : t.assignee ? `assigned to ${esc(t.assignee)}` : t.status ? 'unassigned' : ''}</span>` : ''}</div>`),
    ...[...prs.values()].map((p) => `<div class="stand"><span class="lbl-next">PR</span><a href="#" data-open-key="pr:${esc(p.repo)}#${p.number}">${esc(prName(p))}</a>
      <span class="badge b-${PR_TONE[p.status?.tone] || 'gray'}">${esc(p.status?.label || p.state)}${p.status?.detail ? ` · ${esc(p.status.detail)}` : ''}</span>${p.author && !p.mine ? `<span class="muted">by ${esc(p.author)}</span>` : ''}
      ${people(p)}${p.mine && p.state === 'open' && it.kind !== 'pr' ? `<button class="icon-btn small" data-rv-open="${esc(p.repo)}#${p.number}">${icon('users', 14)} Request review</button>` : ''}</div>`),
  ];
  if (it.issue && !prs.size && ticketPrs.get(it.issue)?.prs) rows.push('<div class="stand"><span class="lbl-next">PR</span><span class="muted">None yet with this key in its title or branch</span></div>');
  return rows.length ? `<div class="stands">${rows.join('')}</div>` : '';
}
async function renderItem() {
  const it = curItem, el = $('#item');
  if (!it) return;
  const where = { GitHub: 'Open on GitHub', Jira: 'Open in Jira', Slack: 'Open in Slack' }[it.src] || 'Open';
  const sessions = cpLinks.links[itemKey(it.url || '')] || [];
  $('#it-crumb').textContent = `${it.src || ''}${it.ref ? ` · ${it.ref}` : ''}`;
  const rel = it.kind === 'session' ? [] : relatedItems(it, inboxItems());
  const head = () => {
    const t = it.issue && ticketInfo.get(it.issue);
    const title = it.title === it.issue && t?.summary ? t.summary : it.title;
    return `<div class="src"><span class="st ${esc(it.glyph)}"></span>${esc(it.ref || '')}</div>
    <h2>${esc(title)}</h2><div class="why">${it.kind === 'linked' ? 'Not in your lists.' : whyLine(it)}</div>${standsHtml(it, rel)}${lastActLine(it)}
    ${(() => { const n = nextHtml(it, nextStep(it, rel)); return n ? `<div class="next-row"><span class="lbl-next">Next</span>${n}</div>` : ''; })()}`;
  };
  const acts = () => `<div class="acts-row">${it.url ? `<a class="icon-btn primary" href="${esc(it.url)}" target="_blank" rel="noopener">${where} ↗</a>` : ''}
    ${it.kind === 'pr' || it.kind === 'review' ? `<a class="icon-btn" href="${esc(it.url.replace('https://github.com/', 'https://github.dev/'))}" target="_blank" rel="noopener" title="The PR in VS Code in the browser: highlighted diffs and a file tree">Review in VS Code (web) ↗</a>` : ''}
    ${it.data?.own && it.data.own.state !== 'read' ? `<button class="icon-btn" data-own-read="${esc(it.url)}" data-oid="${esc(it.data.own.headOid || '')}" title="I've read it, up to the latest commit">${DONE_ICON} Mark read</button>`
      : it.data?.own?.readOid ? `<button class="icon-btn" data-own-read="${esc(it.url)}" data-oid="" title="You marked it read; mark it not read">Mark not read</button>` : ''}
    ${it.kind === 'pr' && !prClosed.has(it.pr) ? `<button class="icon-btn" data-rv-open="${esc(it.data.repo)}#${it.data.number}">${icon('users', 14)} Request review</button>` : ''}
    ${refFromUrl(it.url) ? `<button class="icon-btn" data-ask="${esc(it.url)}" data-title="${esc(it.title)}">${icon('spark', 14)} Copilot on this</button>` : ''}
    ${it.kind === 'linked' ? '' : `<button class="icon-btn" data-mute="${esc(it.k)}">${MUTE_ICON} Snooze</button>
    <button class="icon-btn" data-done="${esc(it.k)}" data-stamp="${esc(it.stamp ?? '')}" data-back-after>${DONE_ICON} Done</button>`}</div>`;
  const cps = sessions.length ? `<h3>Copilot on this</h3><div class="cps">${sessions.map(chip).join('')}</div>` : '';
  const quote = it.quote ? `<h3>${it.src === 'Slack' ? 'Message' : 'Latest mention'}</h3><div class="quote">${esc(it.quote)}</div>` : '';
  const ref = it.pr ? { pr: it.pr } : it.issue ? { issue: it.issue } : null;
  let facts = '', body = ref ? `<h3>Details</h3>${skeleton(2)}` : '';
  const draw = () => {
    if (curItem !== it || (el.dataset.k === it.k && $('#item .rv-pick'))) return; // don't redraw under an open review picker
    el.dataset.k = it.k;
    el.innerHTML = head() + (facts ? `<div class="facts">${facts}</div>` : '') + acts() + '<div class="rv-slot"></div>' + quote + cps + body;
  };
  draw();
  // Tickets this PR is about, and PRs for this ticket, that aren't in your lists: ask Jira and GitHub.
  const unknown = [...(it.issue && it.kind !== 'ticket' ? [it.issue] : []), ...rel.filter((x) => x.issue && x.kind !== 'ticket').map((x) => x.issue)];
  unknown.filter((k) => !ticketInfo.has(k)).forEach((k) => preview({ dataset: { issue: k } }).then((d) => { if (!d.error) { ticketInfo.set(k, d); draw(); } }));
  if (it.issue && !rel.some((x) => x.pr)) loadTicketPrs(it.issue).then(draw);
  if (!ref) return;
  const d = await preview({ dataset: ref });
  if (d.error) { body = `<div class="err" style="margin:0">${esc(d.error)}</div>`; return draw(); }
  if (ref.pr) {
    notePrState(ref.pr, d);
    const [label, tone] = prState(d);
    facts = `<span class="${{ green: 'good', red: 'bad' }[tone] || ''}">${label}</span><span>${esc(d.author)}</span><span>+${d.size.additions} −${d.size.deletions} in ${d.size.files} files</span><span>updated ${esc(ago(d.updatedAt))}</span>`;
  } else {
    ticketInfo.set(ref.issue, { ...ticketInfo.get(ref.issue), ...d });
    facts = `${d.type ? `<span>${esc(d.type)}</span>` : ''}<span>${d.assignee ? `Assignee: ${esc(d.assignee)}` : 'Unassigned'}</span><span>${esc(fixText(d))}</span>${d.priority ? `<span>${esc(d.priority)} priority</span>` : ''}${d.reporter ? `<span>Reporter: ${esc(d.reporter)}</span>` : ''}`;
  }
  body = d.description ? `<h3>Description</h3><div class="desc">${esc(d.description)}</div>` : '';
  draw();
}
// Ask people to review your PR: a list of everyone who can, GitHub's suggestions first, with
// who is already asked or has reviewed marked, so nobody is asked twice by accident.
let lastActs = {};
// The latest thing done on an item: by you from Clearsky, or by Copilot in a linked session.
function lastActLine(it) {
  const mine = lastActs[it.url], cp = cpLinks.actions?.[itemKey(it.url || '')];
  const a = mine && (!cp || mine.at >= cp.at) ? { who: 'You', ...mine } : cp ? { who: 'Copilot', ...cp } : null;
  return a ? `<div class="last-act">${a.who}: ${esc(a.text)}, ${esc(ago(a.at))}.</div>` : '';
}
const loadActs = () => fetch('/api/actions').then((r) => r.json()).then((d) => { lastActs = d.actions || {}; }).catch(() => {});
loadActs();
const RV_STATE = { APPROVED: 'approved', CHANGES_REQUESTED: 'asked for changes', COMMENTED: 'commented', DISMISSED: 'dismissed' };
// It opens under the button, on a PR's page or next to a PR in a Copilot chat's context.
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-rv-open]');
  if (!btn) return;
  const [repo, number] = btn.dataset.rvOpen.split('#');
  const slot = btn.closest('#item, .ctx-item')?.querySelector('.rv-slot');
  if (!slot) return;
  if (slot.firstChild) { slot.replaceChildren(); return; }
  slot.innerHTML = `<div class="rv-pick">${skeleton(3)}</div>`;
  let d;
  try { d = await (await fetch(`/api/pr/reviewers?repo=${encodeURIComponent(repo)}&number=${number}`)).json(); } catch (err) { d = { error: err.message }; }
  if (!slot.isConnected) return;
  if (d.error) { slot.innerHTML = `<div class="rv-pick"><div class="err" style="margin:0">${esc(d.error)}</div></div>`; return; }
  const li = (p) => `<li class="${p.requested ? 'off' : ''}" data-q="${esc(`${p.login} ${p.name || ''}`.toLowerCase())}"><label>
    <input type="checkbox" value="${esc(p.login)}" ${p.requested ? 'checked disabled' : p.last ? 'checked' : ''}>${esc(p.name || p.login)}${p.name ? ` <span class="muted">${esc(p.login)}</span>` : ''}
    <small>${p.requested ? 'asked' : p.last ? 'last time' : p.reviewed ? esc(RV_STATE[p.reviewed] || 'reviewed') + ', ask again' : p.suggested ? 'suggested' : ''}</small></label></li>`;
  slot.innerHTML = `<div class="rv-pick"><input type="search" placeholder="Find a person" aria-label="Find a person">
    <ul>${d.people.map(li).join('') || '<li class="off"><label>Nobody else can review this repo.</label></li>'}</ul>
    <div class="rv-foot"><button class="icon-btn primary" data-rv-send disabled>Request review</button><span class="muted rv-msg"></span></div></div>`;
  const box = slot.firstChild, sendBtn = box.querySelector('[data-rv-send]');
  const picked = () => [...box.querySelectorAll('input[type=checkbox]:checked:not(:disabled)')].map((x) => x.value);
  box.querySelector('input[type=search]').focus();
  box.querySelector('input[type=search]').addEventListener('input', (ev) => {
    const q = ev.target.value.trim().toLowerCase();
    for (const x of box.querySelectorAll('li[data-q]')) x.hidden = !!q && !x.dataset.q.includes(q);
  });
  const count = () => { const n = picked().length; sendBtn.disabled = !n; sendBtn.textContent = n > 1 ? `Request review from ${n}` : 'Request review'; };
  box.addEventListener('change', count);
  count(); // your last pick is ticked already
  sendBtn.addEventListener('click', async () => {
    // Asking people to read code under your name that you haven't read yourself.
    const own = (state.github?.myPrs || []).find((p) => p.repo === repo && p.number === Number(number))?.own;
    if (own && own.state !== 'read' && !confirm(`You haven't read ${own.state === 'new' ? `the ${own.unread} new commit${own.unread > 1 ? 's' : ''}` : 'this PR'} yet (${own.by}${own.lines ? `, ${own.lines} lines` : ""}). Ask for review anyway?`)) return;
    sendBtn.disabled = true;
    try {
      await post('/api/pr/request-review', { repo, number: Number(number), logins: picked() });
      await loadActs();
      slot.replaceChildren();
      if (location.hash === '#item') renderItem();
      loadAll(true);
    } catch (err) { box.querySelector('.rv-msg').textContent = err.message; sendBtn.disabled = false; }
  });
});

// What Clearsky notified you about, newest first, kept across restarts (the last 100).
const NOTE_KIND = { review: 'Review requested', pr: 'Your PR', mention: 'Mention', slack: 'Slack' };
async function renderNotes() {
  const el = $('#notes');
  el.innerHTML = skeleton(4);
  let d;
  try { d = await getJson('/api/notifications/log'); } catch (e) { el.innerHTML = `<div class="err">${esc(e.message)}</div>`; return; }
  $('#notes-sub').textContent = `checked every ${d.pollMinutes} min · ${d.notifier === 'desktop' ? 'desktop banners' : d.notifier === 'browser' ? 'browser notifications' : 'off'}`;
  const log = [...(d.log || [])].reverse();
  el.innerHTML = log.length ? `<ul class="notes">${log.map((n) => `<li>
      <span class="when" title="${esc(new Date(n.at).toLocaleString())}">${esc(ago(n.at))}</span>
      <span class="what">${n.url ? `<a href="${esc(n.url)}" target="_blank" rel="noopener">${esc(n.title || n.key)}</a>` : esc(n.title || n.key)}
        ${n.body ? `<small>${esc(n.body.split('\n')[0])}</small>` : ''}</span>
      <span class="kind">${esc(NOTE_KIND[n.kind] || n.kind || '')}${n.quiet ? ' · quiet hours, no banner' : ''}</span></li>`).join('')}</ul>`
    : '<div class="empty">Nothing yet. New review requests, PRs that turn your move, and mentions show up here.</div>';
}

// What Copilot changed as you (GitHub and Jira show it as you; this tells it apart), newest first.
const DECIDED = { auto: 'went through', allowed: 'you allowed', 'allowed with a step': 'with a step you allowed', declined: 'you declined', read: 'read', 'vpn off': 'VPN off', failed: 'failed' };
function changeRows(list, { chats = true } = {}) {
  const name = (id) => recentChats.find((r) => r.id === id)?.title || 'a Copilot chat';
  return `<ul class="notes changes">${list.map((w) => `<li class="d-${esc(w.decided.split(' ')[0])}">
      <span class="when" title="${esc(new Date(w.at).toLocaleString())}">${esc(ago(w.at))}</span>
      <span class="what"><b>${esc({ jira: 'Jira', grafana: 'Grafana (read)', build: w.kind === 'test' ? 'Tests' : 'Build', review: 'Self-review' }[w.where] || 'GitHub')}${w.repo || w.target ? ` · ${esc(w.repo || w.target)}` : ''}</b><small>${esc(w.what)}${w.removed ? ` · ${w.removed} secret${w.removed > 1 ? 's' : ''} removed` : ''}</small>
        ${chats && w.chats?.length ? `<small>${w.chats.length > 1 ? 'one of: ' : ''}${w.chats.map((c) => esc(name(c.id))).join(', ')}</small>` : ''}</span>
      <span class="kind">${esc(DECIDED[w.decided] || w.decided)}</span></li>`).join('')}</ul>`;
}
async function renderChanges() {
  const el = $('#changes');
  el.innerHTML = skeleton(4);
  let d;
  try { d = await getJson('/api/agent-log'); } catch (e) { el.innerHTML = `<div class="err">${esc(e.message)}</div>`; return; }
  el.innerHTML = d.writes.length ? changeRows(d.writes) : '<div class="empty">Nothing yet. Comments, pushes, PR edits and Jira changes Copilot makes from its sandbox show up here.</div>';
}

// The agent map (lib/map.mjs): per chat, each repo, ticket and environment it worked on, with what
// it did there in order (same acts folded: "pushed ×3"). New ones a chat found along the way show
// as they come, after what it was started on.
const MAP_KIND = { repo: ['pr', 'Repo'], ticket: ['ticket', 'Ticket'], project: ['ticket', 'Jira project'], env: ['source', 'Grafana'], folder: ['folder', 'Folder'] };
const actTone = (a) => (/failed|fix first|declined/.test(a.act) ? 'bad' : /passed|ready|merged/.test(a.act) ? 'good' : a.decided === 'allowed' ? 'warn' : '');
function foldActs(acts) {
  const out = [];
  for (const a of acts) {
    const last = out.at(-1);
    const label = a.act + (a.pr ? ` #${a.pr}` : '');
    if (last && last.label === label) { last.n++; last.at = a.at; last.details.push(a.detail); } else out.push({ ...a, label, n: 1, details: [a.detail] });
  }
  return out;
}
function mapNode(n, jira) {
  const [ico, kind] = MAP_KIND[n.kind] || ['tool', n.kind];
  const href = n.kind === 'repo' ? `https://github.com/${n.key}` : n.kind === 'ticket' && jira ? `${jira.replace(/\/$/, '')}/browse/${n.key}` : null;
  const name = href ? `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(n.key)}</a>` : esc(n.key);
  const extra = [n.branches?.length && `branches: ${n.branches.join(', ')}`, n.prs?.length && `PRs: ${n.prs.map((x) => `#${x}`).join(', ')}`].filter(Boolean).join(' · ');
  const acts = foldActs(n.acts);
  return `<li class="mn${n.scope ? ' scope' : ''}"><span class="mi">${icon(ico, 14)}</span><div><b>${name}</b> <small>${esc(kind)}${n.scope && !acts.length ? ' · started on, nothing done yet' : n.scope ? ' · started on' : n.first ? ` · from ${esc(ago(n.first))}` : ''}${extra ? ` · ${esc(extra)}` : ''}</small>
    ${acts.length ? `<div class="acts">${acts.map((a) => `<span class="act ${actTone(a)}" title="${esc([new Date(a.at).toLocaleString(), ...new Set(a.details.filter(Boolean))].join('\n'))}">${esc(a.label)}${a.n > 1 ? ` ×${a.n}` : ''}</span>`).join('<i>›</i>')}</div>` : ''}</div></li>`;
}
function mapChat(ch, jira, { head = true } = {}) {
  const name = ch.title || recentChats.find((r) => r.id === ch.id)?.title || 'A Copilot chat';
  return `<div class="mapc">${head ? `<div class="mh"><a href="#copilot" data-sid="${esc(ch.id)}">${esc(name)}</a><small>${ch.live ? 'open · ' : ''}${ch.at ? `last ${esc(ago(ch.at))}` : ''}${ch.shared ? ` · ${ch.shared} change${ch.shared > 1 ? 's' : ''} could have been another working chat's` : ''}</small></div>` : ''}
    <ul class="mapn">${ch.nodes.map((n) => mapNode(n, jira)).join('')}</ul></div>`;
}
document.addEventListener('click', (e) => {
  const a = e.target.closest('.mh [data-sid]');
  if (!a) return;
  e.preventDefault();
  openChat(true, true);
  openSession(a.dataset.sid);
});
async function renderMap() {
  const el = $('#map');
  el.innerHTML = skeleton(4);
  let d;
  try { d = await getJson('/api/copilot/map'); } catch (e) { el.innerHTML = `<div class="err">${esc(e.message)}</div>`; return; }
  el.innerHTML = d.chats.length ? `<div class="map-key">In order, oldest first. <span class="act good">green</span> passed or ready, <span class="act bad">red</span> failed, <span class="act warn">amber</span> went through after you allowed it. Hover a step for its command and time.</div>${d.chats.map((ch) => mapChat(ch, d.jira)).join('')}`
    : '<div class="empty">Nothing yet. As Copilot builds, tests, reviews, pushes, comments and moves tickets from its sandbox, each chat\'s map shows here.</div>';
}

// Done or snoozed from the item page: back to the list.
document.addEventListener('click', (e) => { if (e.target.closest('[data-back-after]')) setTimeout(back, 0); });

// Sources from plugins (lib/sources, ~/.config/clearsky/sources) each get a page of their own,
// listed in the menu: personal ones under Personal, the rest under Work.
let extraSources = [];
function addSourcePanels(list) {
  extraSources = list.filter((x) => x.panel);
  for (const x of extraSources) {
    if (document.querySelector(`[data-nav="src-${x.name}"]`)) continue;
    const a = document.createElement('a');
    a.className = 'ni'; a.href = `#src-${x.name}`; a.dataset.nav = `src-${x.name}`;
    a.innerHTML = `<span class="ico">${icon(x.area === 'personal' ? 'home' : 'source')}</span><span class="lab">${esc(x.panel.title)}</span><b></b>`;
    $(x.area === 'personal' ? '#side-personal' : '#side-work').append(a);
  }
  personalSide();
  route();
}
function renderExtra() {
  for (const x of extraSources) {
    const d = state[x.name], nav = document.querySelector(`[data-nav="src-${x.name}"]`);
    if (nav) nav.hidden = !!d?.disabled;
    const list = d && !d.error ? vis((d.items || []).map((i) => ({ ...i, src: x.name, url: i.url || '', dismissKey: i.key ? `${x.name}:${i.key}` : undefined }))) : [];
    const table = x.panel.view === 'table';
    // An inbox counts what's unread; other panels count what they show.
    const count = table ? list.filter((i) => i.unread).length : list.length;
    if (nav) { const b = nav.querySelector('b'); b.textContent = count || ''; b.classList.toggle('hot', !!count && x.panel.zone === 'needs'); }
    if (location.hash !== `#src-${x.name}`) continue;
    $('#src-title').textContent = x.panel.title;
    const el = $('#src-body');
    PANEL_SOURCES[el.id] = [x.name];
    if (!d) { card(el, x.panel.title, null, skeleton(3)); continue; }
    // The school week sits above the messages; drawn after card(), which replaces the panel.
    const week = d.planEvents?.length ? `<div id="wk-${esc(x.name)}"></div>` : '';
    card(el, x.panel.title, d.error ? null : count, week + (d.error ? `<div class="err">${esc(d.error)}${d.needsLogin ? ' <a href="/settings#extra">Log in again in Settings</a>' : ''}</div>` : '') +
      (list.length ? (table ? tableView(x, list, 40) : rows(`x-${x.name}`, list, (i) => row(i), 30))
        : d.error ? '' : '<div class="empty">Nothing here.</div>'));
    if (week) drawWeek(x.name, d.planEvents);
  }
}

// The school week: Monday to Friday side by side, from the weekly plans, each class in a
// colour of its own. ‹ › moves a week; it opens on this week (next week from Saturday).
const weekAt = {};
const WHO_COLORS = ['#2563eb', '#16a34a', '#d97706', '#9333ea', '#dc2626', '#0891b2'];
function mondayOf(d) { const m = new Date(d); m.setHours(0, 0, 0, 0); m.setDate(m.getDate() - ((m.getDay() + 6) % 7)); return m; }
function drawWeek(src, events) {
  const el = document.getElementById(`wk-${src}`);
  if (!el) return;
  const now = new Date();
  weekAt[src] ??= +mondayOf(new Date(+now + (now.getDay() === 6 || now.getDay() === 0 ? 2 * 864e5 : 0)));
  const mon = new Date(weekAt[src]);
  const whos = [...new Set(events.map((e) => e.who || 'School'))].sort();
  const color = (w) => WHO_COLORS[whos.indexOf(w) % WHO_COLORS.length];
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const days = [0, 1, 2, 3, 4].map((i) => new Date(+mon + i * 864e5 + 3 * 36e5)); // 03:00, so a DST shift can't move the day
  const on = (d) => events.filter((e) => ymd(new Date(e.start)) === ymd(d))
    .sort((a, b) => (a.allDay === b.allDay ? String(a.start).localeCompare(String(b.start)) : a.allDay ? -1 : 1) || String(a.who).localeCompare(String(b.who)));
  const ev = (e) => `<button class="wk-ev k-${esc(e.kind || 'activity')}" style="--c:${color(e.who || 'School')}" data-read-src="${esc(e.read?.src || src)}" data-read-key="${esc(e.read?.key || '')}" title="${esc(e.description || '')}">
      <span class="wk-who">${esc(e.who || 'School')}</span>${e.allDay ? '' : `<time>${hm(e.start)}${e.kind === 'ends' ? '' : `–${hm(e.end)}`}</time>`}<span class="wk-t">${esc(e.what || e.title)}</span></button>`;
  const today = ymd(now);
  const count = days.reduce((n, d) => n + on(d).length, 0);
  el.innerHTML = `<section class="wk"><div class="wk-head"><h2>Week ${weekNo(mon)}</h2>
      <button class="icon-btn" data-wk="${esc(src)}" data-step="-1" aria-label="Previous week">‹</button><button class="icon-btn" data-wk="${esc(src)}" data-step="0">This week</button><button class="icon-btn" data-wk="${esc(src)}" data-step="1" aria-label="Next week">›</button>
      <span class="spacer"></span>${whos.map((w) => `<span class="wk-leg" style="--c:${color(w)}">${esc(w)}</span>`).join('')}</div>
    ${count ? `<div class="wk-grid">${days.map((d) => {
    // The day's schedule first; under it, the homework to do that day, in a section of its own.
    const plan = on(d).filter((e) => e.kind !== 'homework'), hw = homeworkOn(events, ymd(d));
    return `<div class="wk-day${ymd(d) === today ? ' today' : ''}"><h3>${d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}</h3>${plan.map(ev).join('') || '<div class="muted wk-none">—</div>'}${
      hw.length ? `<div class="wk-hw"><h4>Homework</h4>${hw.map(ev).join('')}</div>` : ''}</div>`;
  }).join('')}</div>`
      : '<div class="empty">No weekly plan for this week yet.</div>'}</section>`;
}
// Homework shows on the days it gets done, not the day it's due: "til tirsdag" the school day
// before (Friday for Monday), the week's homework every school day up to the due day. Each
// says when it's due ("for Thu").
function homeworkOn(events, day) {
  const local = (iso) => { const x = new Date(iso); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
  const out = [];
  for (const e of events) {
    if (e.kind !== 'homework') continue;
    const due = new Date(e.start); due.setHours(12, 0, 0, 0);
    const days = [];
    for (let t = new Date(due); days.length < 7;) {
      t.setDate(t.getDate() - 1);
      if (t.getDay() === 0 || t.getDay() === 6) continue;
      days.push(local(t));
      if (e.span !== 'week' || t.getDay() === 1) break;
    }
    if (days.includes(day)) out.push({ ...e, what: `${e.what || e.title} · for ${due.toLocaleDateString([], { weekday: 'short' })}` });
  }
  return out.sort((a, b) => String(a.start).localeCompare(String(b.start)) || String(a.who).localeCompare(String(b.who)));
}

// ISO week: the week with that week's Thursday in it, counted from the year's first Thursday.
function weekNo(d) { const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate() + 3 - ((d.getDay() + 6) % 7))); return 1 + Math.floor((t - Date.UTC(t.getUTCFullYear(), 0, 1)) / 6048e5); }
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-wk]');
  if (!b) return;
  const src = b.dataset.wk, step = Number(b.dataset.step);
  const now = new Date();
  weekAt[src] = step ? +mondayOf(new Date(weekAt[src] + step * 7 * 864e5 + 12 * 36e5)) : +mondayOf(new Date(+now + (now.getDay() === 6 || now.getDay() === 0 ? 2 * 864e5 : 0)));
  drawWeek(src, state[src]?.planEvents || []);
});

// A source panel as an inbox: newest first, date, sender and group as columns, filtered by
// group (School, or a child), with a paperclip on anything that has files. Columns can be
// resized (drag a header edge) and hidden (Columns); that's kept in this browser.
const groupPick = {};
const COLS = [['d', 'Date', 118], ['f', 'From', 150], ['g', 'Group', 90], ['s', 'Subject'], ['p', 'Preview'], ['att', 'Attachments']];
const COLS_KEY = 'clearsky.inbox.cols';
let colPrefs = { widths: {}, hidden: [] };
try { colPrefs = { widths: {}, hidden: [], ...JSON.parse(localStorage.getItem(COLS_KEY) || '{}') }; } catch {}
const saveCols = () => { try { localStorage.setItem(COLS_KEY, JSON.stringify(colPrefs)); } catch {} };
const colWidth = (c) => Math.min(480, Math.max(48, colPrefs.widths[c] || COLS.find((x) => x[0] === c)[2]));
// The grid's columns, leaving out hidden ones. Preview sits under the subject, so it takes none.
function colTemplate() {
  const off = new Set(colPrefs.hidden);
  return [...['d', 'f', 'g'].filter((c) => !off.has(c)).map((c) => `${colWidth(c)}px`), 'minmax(0, 1fr)', ...(off.has('att') ? [] : ['22px'])].join(' ');
}
const colClasses = () => colPrefs.hidden.map((c) => `no-${c}`).join(' ');
function applyCols() {
  for (const ul of document.querySelectorAll('.inbox')) { ul.style.setProperty('--cols', colTemplate()); ul.className = `inbox ${colClasses()}`; }
}
function tableView(x, list, limit = 12) {
  const groups = [...new Set(list.map((i) => i.group).filter(Boolean))]
    .sort((a, b) => (a === 'School' ? -1 : b === 'School' ? 1 : a.localeCompare(b)));
  const pick = groups.includes(groupPick[x.name]) ? groupPick[x.name] : '';
  // Newest first, or by the column you clicked (see data-isort below).
  const so = colPrefs.sort, key = { d: (i) => i.at || '', f: (i) => i.from || '', g: (i) => i.group || '', s: (i) => i.title || '' };
  const items = list.filter((i) => !pick || i.group === pick).sort((a, b) => (so && key[so.c]
    ? (so.dir === 'desc' ? -1 : 1) * key[so.c](a).localeCompare(key[so.c](b), undefined, { numeric: true, sensitivity: 'base' })
    : String(b.at || '').localeCompare(String(a.at || ''))));
  const unread = (g) => list.filter((i) => i.unread && (!g || i.group === g)).length;
  const chip = (g, label) => `<button data-pick="${esc(x.name)}" data-group="${esc(g)}" class="${pick === g ? 'on' : ''}">${esc(label)}${unread(g) ? `<span class="n">${unread(g)}</span>` : ''}</button>`;
  const id = `x-${x.name}-${pick}`;
  const shown = expanded.has(id) ? items : items.slice(0, limit);
  const date = (iso) => {
    if (!iso) return '';
    const d = new Date(iso), now = new Date();
    if (d.toDateString() === now.toDateString()) return hm(iso);
    return `${d.toLocaleDateString([], { day: 'numeric', month: 'short', ...(d.getFullYear() !== now.getFullYear() && { year: 'numeric' }) })} ${hm(iso)}`;
  };
  const line = (i) => `<li class="${i.unread ? 'unread' : ''}" tabindex="0"${i.detail && i.key ? ` data-row-read="${esc(i.src)}" data-key="${esc(i.key)}" data-url="${esc(i.url)}"` : ` data-row-url="${esc(i.url)}"`}>
    <span class="d" title="${esc(i.at ? new Date(i.at).toLocaleString([], { dateStyle: 'full', timeStyle: 'short', hourCycle: hourCycle() }) : '')}">${esc(date(i.at))}</span>
    <span class="f" title="${esc(i.from || '')}">${esc(i.from || '')}${i.group ? ` <span class="gm">· ${esc(i.group)}</span>` : ''}</span>
    <span class="g" title="${esc(i.group || '')}">${esc(i.group || '')}</span>
    <span class="s">${i.badge ? `<span class="badge b-${i.tone || 'gray'}">${esc(i.badge)}</span>` : ''}<a href="${esc(i.url)}" target="_blank" rel="noopener"${i.detail && i.key ? ` data-read="${esc(i.src)}" data-key="${esc(i.key)}"` : ''}>${esc(i.title || '(no subject)')}</a>
      ${i.meta ? `<div class="p">${esc(i.meta)}</div>` : i.quote ? `<div class="p">${esc(i.quote)}</div>` : ''}</span>
    <span class="att">${i.files ? `<span title="${i.files} file${i.files > 1 ? 's' : ''}" aria-label="Has attachments">${icon('clip', 13)}</span>` : ''}</span>
  </li>`;
  const cols = `<details class="cols"><summary>Columns</summary><div class="menu">${COLS.filter(([c]) => c !== 's').map(([c, label]) =>
    `<label><input type="checkbox" data-col="${c}"${colPrefs.hidden.includes(c) ? '' : ' checked'}> ${label}</label>`).join('')}
    <button class="reset" data-cols-reset>Reset widths</button></div></details>`;
  const arrow = (c) => (so?.c === c ? (so.dir === 'desc' ? ' ▼' : ' ▲') : '');
  const head = (c, label) => `<span class="${c} sortable" data-isort="${c}" title="Sort by ${label.toLowerCase()}">${label}${arrow(c)}${['d', 'f', 'g'].includes(c) ? `<i class="rz" data-rz="${c}" title="Drag to resize"></i>` : ''}</span>`;
  const markAll = unread(pick) ? `<button class="mark-all" data-mark-all="${esc(x.name)}" data-group="${esc(pick)}">Mark ${pick ? `${esc(pick)} ` : 'all '}read</button>` : '';
  return `<div class="pick">${groups.length > 1 ? chip('', 'All') + groups.map((g) => chip(g, g)).join('') : ''}${markAll}${cols}</div>` +
    `<ul class="inbox ${colClasses()}" style="--cols: ${colTemplate()}"><li class="head">${head('d', 'Date')}${head('f', 'From')}${head('g', 'Group')}${head('s', 'Subject')}<span class="att"></span></li>${shown.map(line).join('')}</ul>` +
    (items.length > shown.length ? `<button class="more" data-more="${id}">Show ${items.length - shown.length} more</button>` : '');
}
document.addEventListener('click', (e) => {
  const h = e.target.closest('[data-isort]');
  if (!h || e.target.closest('.rz')) return;
  const c = h.dataset.isort, first = c === 'd' ? 'desc' : 'asc';
  colPrefs.sort = colPrefs.sort?.c !== c ? { c, dir: first } : colPrefs.sort.dir === first ? { c, dir: first === 'asc' ? 'desc' : 'asc' } : null;
  try { localStorage.setItem(COLS_KEY, JSON.stringify(colPrefs)); } catch {}
  renderExtra();
});
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-pick]');
  if (!b) return;
  groupPick[b.dataset.pick] = b.dataset.group;
  renderExtra();
});
// The whole row opens the message; links and buttons inside it keep their own clicks.
function openRow(li, e) {
  if (li.dataset.rowRead) openReader(li.dataset.rowRead, li.dataset.key, li.dataset.url);
  else if (li.dataset.rowUrl) window.open(li.dataset.rowUrl, '_blank', 'noopener');
}
document.addEventListener('click', (e) => {
  const li = e.target.closest('.inbox li[tabindex]');
  if (!li || e.target.closest('a, button, input, label') || getSelection().toString()) return;
  openRow(li, e);
});
document.addEventListener('keydown', (e) => {
  const li = e.target.closest?.('.inbox li[tabindex]');
  if (li && e.target === li && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openRow(li, e); }
});
document.addEventListener('change', (e) => {
  const c = e.target.closest('[data-col]')?.dataset.col;
  if (!c) return;
  colPrefs.hidden = e.target.checked ? colPrefs.hidden.filter((x) => x !== c) : [...new Set([...colPrefs.hidden, c])];
  saveCols(); applyCols();
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('[data-cols-reset]')) return;
  colPrefs.widths = {}; saveCols(); applyCols();
});
// Close the Columns menu on a click elsewhere.
document.addEventListener('click', (e) => { for (const d of document.querySelectorAll('.pick .cols[open]')) if (!d.contains(e.target)) d.open = false; });
document.addEventListener('pointerdown', (e) => {
  const h = e.target.closest('[data-rz]');
  if (!h) return;
  e.preventDefault();
  const c = h.dataset.rz, x0 = e.clientX, w0 = colWidth(c);
  h.classList.add('on'); h.setPointerCapture(e.pointerId);
  const move = (ev) => { colPrefs.widths[c] = Math.round(w0 + ev.clientX - x0); applyCols(); };
  const up = () => { h.classList.remove('on'); h.removeEventListener('pointermove', move); h.removeEventListener('pointerup', up); colPrefs.widths[c] = colWidth(c); saveCols(); };
  h.addEventListener('pointermove', move); h.addEventListener('pointerup', up);
});

// The menu: counts beside each view, and the dot on ☰ when it's folded away on a small screen.
function renderNav() {
  const all = inboxItems().filter((x) => !x.done && !x.snoozed);
  const cpWaiting = (cpLinks.live || []).filter((x) => x.status !== 'working').length;
  const set = (id, n, hot) => { const b = $(`#n-${id}`); b.textContent = n || ''; b.classList.toggle('hot', !!hot && !!n); };
  const needs = all.filter((x) => x.group === 'needs').length + cpWaiting;
  set('inbox', needs, true);
  set('reviews', all.filter((x) => x.kind === 'review').length, true);
  set('prs', all.filter((x) => x.kind === 'pr' && x.group === 'needs').length, true);
  set('mentions', all.filter((x) => x.kind === 'mention').length, true);
  set('tickets', all.filter((x) => x.kind === 'ticket').length);
  const p = state.plan?.plan;
  $('#n-calendar').textContent = p?.now ? 'now' : p?.next && sameDay(p.next.start) ? hm(p.next.start) : '';
  $('#menu-n').hidden = !needs; $('#menu-n').textContent = needs;
}

function renderToday() {
  view();
  renderNow(); renderNav(); renderExtra();
  if (!$('#v-list').hidden) renderList();
  if (!$('#v-calendar').hidden) renderCalendar();
}

// ---------------------------------------------------------------- Stand-up

let standupData = null;

// Turn "ABC-1234" and "org/repo#12" in plain text into links with hover cards.
function linkify(text, jiraBase) {
  return esc(text).replace(/\b([\w.-]+\/[\w.-]+)#(\d+)\b|\b([A-Z][A-Z0-9_]+-\d+)\b/g, (m, repo, num, key) => {
    if (repo) return `<a class="ref" href="https://github.com/${repo}/pull/${num}" target="_blank" rel="noopener" data-pr="${repo}#${num}">${m}</a>`;
    return `<a class="ref" href="${jiraBase ? `${esc(jiraBase)}/browse/${key}` : '#'}" target="_blank" rel="noopener" data-issue="${key}">${key}</a>`;
  });
}

function renderStandup() {
  const s = standupData;
  if (!s) {
    $('#su-body').innerHTML = ['Yesterday', 'Today', 'Blockers'].map((h) => `<section class="card su-card"><h2>${h}</h2>${skeleton(3)}</section>`).join('');
    return;
  }
  if (s.error) { $('#su-body').innerHTML = `<div class="err">${esc(s.error)}</div>`; return; }
  const at = new Date(s.nextStandup).toLocaleString([], { weekday: 'long', hour: '2-digit', minute: '2-digit', hourCycle: hourCycle() });
  const errs = [s.yesterday.github.error && `GitHub: ${s.yesterday.github.error}`, s.yesterday.jira.error && `Jira: ${s.yesterday.jira.error}`].filter(Boolean);
  $('#su-sub').textContent = `For ${at} · since ${s.sinceLabel}`;
  // The text is "*Heading*" lines followed by "- item" lines.
  const sections = [];
  for (const line of s.text.split('\n')) {
    const h = line.match(/^\*(.+?)\*/);
    if (h) sections.push({ title: h[1], items: [] });
    else if (line.startsWith('- ') && sections.length) sections.at(-1).items.push(line.slice(2));
  }
  // What to say, in a few sentences (Copilot writes it from the lists below; Generate asks it).
  const say = `<section class="card su-card su-say"><h2>Say this</h2>
    <div id="su-say">${sayData?.text ? sayHtml(sayData.text) : sayData?.error ? `<div class="err">${esc(sayData.error)}</div>` : sayData?.loading ? skeleton(3) : '<p class="muted">A few sentences to say, grouped by what the work is for, written by Copilot from the lists below.</p>'}</div>
    <div class="acts-row"><button class="icon-btn${sayData?.text ? '' : ' primary'}" data-say="${sayData?.text ? 'refresh' : 'go'}" ${sayData?.loading ? 'disabled' : ''}>${sayData?.text ? 'Write it again' : 'Write it'}</button>${sayData?.text ? '<button class="icon-btn" data-say="copy">Copy</button>' : ''}</div></section>`;
  $('#su-body').innerHTML = say + (errs.length ? `<div class="err">${esc(errs.join(' · '))}</div>` : '') + sections.map((sec) =>
    `<section class="card su-card"><h2>${esc(sec.title)}</h2><ul>${sec.items.map((i) => `<li>${linkify(i, s.jiraBase)}</li>`).join('')}</ul></section>`).join('');
}

let sayData = null;
const sayHtml = (t) => t.split(/\n{2,}/).map((p) => `<p>${linkify(p.trim(), standupData?.jiraBase)}</p>`).join('');
async function loadSay(force) {
  sayData = { ...sayData, loading: true, error: null };
  renderStandup();
  try { sayData = await getJson(`/api/standup/say${force ? '?refresh=1' : ''}`); if (sayData.error) throw new Error(sayData.error); }
  catch (e) { sayData = { error: e.message }; }
  renderStandup();
}
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-say]');
  if (!b) return;
  if (b.dataset.say === 'copy') { await navigator.clipboard?.writeText(sayData?.text || ''); b.textContent = 'Copied'; return; }
  loadSay(b.dataset.say === 'refresh');
});

async function loadStandup(force) {
  busy(1);
  try { standupData = await getJson(`/api/standup${force ? '?refresh=1' : ''}`); }
  catch (e) { standupData = { error: e.message }; }
  finally { busy(-1); renderStandup(); }
  if (!sayData?.text) getJson('/api/standup/say?cached=1').then((d) => { if (d.text) { sayData = d; renderStandup(); } }).catch(() => {});
}

// ---------------------------------------------------------------- hover cards

const hc = $('#hc'), previews = new Map();
let hcFor = null, showTimer = null, hideTimer = null;

function preview(el) {
  const key = el.dataset.issue || el.dataset.pr;
  if (!previews.has(key)) {
    const url = el.dataset.issue ? `/api/issue/${encodeURIComponent(key)}`
      : `/api/pr?repo=${encodeURIComponent(key.split('#')[0])}&number=${key.split('#')[1]}`;
    previews.set(key, getJson(url).catch((e) => ({ error: e.message })));
  }
  return previews.get(key);
}

const statusTone = (c) => (c === 'done' ? 'green' : c === 'indeterminate' ? 'blue' : 'gray');
const prState = (p) => (p.state === 'MERGED' ? ['Merged', 'green'] : p.state === 'CLOSED' ? ['Closed', 'red'] : p.draft ? ['Draft', 'gray']
  : p.reviewDecision === 'APPROVED' ? ['Approved', 'green'] : p.reviewDecision === 'CHANGES_REQUESTED' ? ['Changes requested', 'red'] : ['Open', 'blue']);

function cardHtml(el, d) {
  if (!d) return '<div class="sk" style="width:40%"></div><div class="sk" style="width:85%;height:15px;margin:10px 0"></div><div class="sk"></div><div class="sk" style="margin-top:6px;width:70%"></div>';
  if (d.error) return `<div class="err" style="margin:0">${esc(d.error)}</div>`;
  if (el.dataset.issue) {
    return `<div class="top"><b style="color:var(--text)">${esc(d.key)}</b>${d.type ? `· ${esc(d.type)}` : ''}
        ${d.status ? `<span class="badge b-${statusTone(d.statusCategory)}">${esc(d.status)}</span>` : ''}</div>
      <h3>${esc(d.summary)}</h3>
      <div class="people">${[d.assignee ? `Assignee: ${esc(d.assignee)}` : 'Unassigned', esc(fixText(d)), d.priority && `Priority: ${esc(d.priority)}`].filter(Boolean).join(' · ')}</div>
      ${d.description ? `<p>${esc(d.description)}</p>` : ''}
      ${d.url ? `<div class="foot"><a href="${esc(d.url)}" target="_blank" rel="noopener">Open in Jira →</a></div>` : ''}`;
  }
  const [label, tone] = prState(d);
  return `<div class="top"><b style="color:var(--text)">${esc(d.key)}</b><span class="badge b-${tone}">${label}</span></div>
    <h3>${esc(d.title)}</h3>
    <div class="people">${esc(d.author)} · +${d.size.additions} −${d.size.deletions} in ${d.size.files} files · updated ${ago(d.updatedAt)}</div>
    ${d.description ? `<p>${esc(d.description)}</p>` : ''}
    <div class="foot"><a href="${esc(d.url)}" target="_blank" rel="noopener">Open on GitHub →</a></div>`;
}

function place(el) {
  const r = el.getBoundingClientRect(), w = Math.min(380, window.innerWidth - 24);
  const left = Math.min(Math.max(12, r.left + window.scrollX), window.scrollX + window.innerWidth - w - 12);
  const below = r.bottom + 8 + 260 < window.innerHeight;
  hc.style.left = `${left}px`;
  hc.style.top = below ? `${r.bottom + 8}px` : `${r.top - hc.offsetHeight - 8}px`;
}

async function showCard(el) {
  hcFor = el;
  hc.innerHTML = cardHtml(el, null);
  hc.classList.add('on');
  place(el);
  const d = await preview(el);
  if (hcFor !== el) return;
  hc.innerHTML = cardHtml(el, d);
  place(el);
}

function hideCard() { hcFor = null; hc.classList.remove('on'); }

document.addEventListener('mouseover', (e) => {
  const el = e.target.closest('[data-issue],[data-pr]');
  if (e.target.closest('#hc')) { clearTimeout(hideTimer); return; }
  if (!el) return;
  clearTimeout(hideTimer);
  if (hcFor === el) return;
  clearTimeout(showTimer);
  showTimer = setTimeout(() => showCard(el), 250);
});
document.addEventListener('mouseout', (e) => {
  if (!e.target.closest('[data-issue],[data-pr],#hc')) return;
  clearTimeout(showTimer);
  hideTimer = setTimeout(hideCard, 200);
});
document.addEventListener('focusin', (e) => { const el = e.target.closest('[data-issue],[data-pr]'); if (el) showCard(el); });
document.addEventListener('focusout', (e) => { if (e.target.closest('[data-issue],[data-pr]')) hideTimer = setTimeout(hideCard, 200); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideCard(); });

// ---------------------------------------------------------------- restarting Clearsky
// After an update (or `clearsky restart`), Clearsky restarts once no chat started here is
// mid-answer or waiting on your Allow/Deny. This note says what it waits for, and Restart now
// stops those chats (they can be continued afterwards).
let restartInfo = null;
async function loadRestart() {
  try { restartInfo = await getJson('/api/restart'); } catch { return; }
  const { pending, busy = [], updateReady } = restartInfo, el = $('#restart-note');
  el.hidden = !pending && !updateReady;
  if (el.hidden) return;
  const list = busy.length ? `<ul>${busy.map((c) => `<li>${esc(c.title)} (${c.status === 'needs-you' ? 'waiting for your OK' : 'working'})</li>`).join('')}</ul>` : '';
  el.innerHTML = pending
    ? `<div><b>Restart waiting</b> for ${busy.length ? `${busy.length} Copilot chat${busy.length > 1 ? 's' : ''} to finish:` : 'a moment…'}</div>${list}
       <div class="acts"><button class="primary" data-restart="now">Restart now</button></div>`
    : `<div><b>Update ready.</b> Restart to use it${busy.length ? ` (waits for ${busy.length} busy chat${busy.length > 1 ? 's' : ''})` : ''}.</div>${list}
       <div class="acts"><button class="primary" data-restart="idle">Restart</button>${busy.length ? '<button data-restart="now">Restart now</button>' : ''}</div>`;
}
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-restart]');
  if (!b) return;
  const now = b.dataset.restart === 'now', busy = restartInfo?.busy || [];
  if (now && busy.length && !confirm(`Restart now? This stops:\n${busy.map((c) => `• ${c.title}`).join('\n')}\n\nYou can continue them afterwards.`)) return;
  b.disabled = true;
  try { await post('/api/restart', { force: now }); } catch (err) { b.disabled = false; return alert(err.message); }
  $('#restart-note').innerHTML = '<div><b>Restarting…</b> the page reloads when Clearsky is back.</div>';
  // Wait for the old server to go away and the new one to answer, then reload.
  const started = Date.now();
  let wentDown = false;
  const poll = async () => {
    try { await fetch('/api/restart', { cache: 'no-store' }); if (wentDown || Date.now() - started > 60_000) return location.reload(); } catch { wentDown = true; }
    setTimeout(poll, 1000);
  };
  setTimeout(poll, 1000);
});
loadRestart();
setInterval(() => { if (!document.hidden) loadRestart(); }, 15_000);
