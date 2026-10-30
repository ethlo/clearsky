// Clearsky page: the Copilot chat, its sessions, references, theme and talk.
// The server joins web/js/*.js in name order into one script in index.html, so they share one scope.

// ---------------------------------------------------------------- Copilot chat

const chat = { session: null, cwd: null, turns: 0, stop: null, info: null, refs: [], title: null, items: [], queued: [] };
const CUR_KEY = 'clearsky.chatSession';
// Remember the open chat, so a reload picks it up again.
function rememberChat() {
  try { localStorage.setItem(CUR_KEY, chat.turns ? JSON.stringify({ id: chat.session, cwd: chat.cwd }) : ''); } catch {}
}
const CP_KEY = 'clearsky.copilot';
let cpPrefs = {};
try { cpPrefs = JSON.parse(localStorage.getItem(CP_KEY) || '{}'); } catch {}
// Each chat keeps the model, effort and access it was given, so switching back to it (or
// reopening it later) keeps its mode rather than taking whatever the pickers last showed.
const CHAT_MODES_KEY = 'clearsky.copilot.modes';
let chatModes = {};
try { chatModes = JSON.parse(localStorage.getItem(CHAT_MODES_KEY) || '{}') || {}; } catch {}
const pickerMode = () => ({ model: $('#cp-model').value.trim(), effort: $('#cp-effort').value, permission: $('#cp-perm').value });
function rememberMode(id = chat.session, mode = pickerMode()) {
  if (!id) return;
  delete chatModes[id];
  chatModes[id] = mode;
  const ids = Object.keys(chatModes);
  if (ids.length > 200) ids.slice(0, ids.length - 200).forEach((k) => delete chatModes[k]);
  try { localStorage.setItem(CHAT_MODES_KEY, JSON.stringify(chatModes)); } catch {}
}
function restoreMode(id) {
  const m = chatModes[id];
  if (!m || !chat.info?.permissions) return;
  $('#cp-model').value = m.model || '';
  $('#cp-effort').value = m.effort || '';
  if (chat.info.permissions[m.permission]) $('#cp-perm').value = m.permission;
  chatSub();
}
const saveCp = () => {
  cpPrefs = { model: $('#cp-model').value.trim(), effort: $('#cp-effort').value, permission: $('#cp-perm').value,
    allow: $('#cp-allow').value, deny: $('#cp-deny').value };
  try { localStorage.setItem(CP_KEY, JSON.stringify(cpPrefs)); } catch {}
  if (chat.turns) rememberMode();
  chatSub();
};
// ---------------------------------------------------------------- switching chats

// Chats you had open here lately, so you can hop between them (Alt+1…9, Alt+N for a new one).
const RECENT_KEY = 'clearsky.recentChats';
let recentChats = [];
try { recentChats = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch {}
function saveRecent() { try { localStorage.setItem(RECENT_KEY, JSON.stringify(recentChats.slice(0, 8))); } catch {} }
function remember(id, cwd, title) {
  if (!id) return;
  // Tabs keep their place; a chat new to the list goes first.
  const old = recentChats.find((x) => x.id === id);
  if (old) Object.assign(old, { cwd: cwd || old.cwd, title: title || old.title });
  else recentChats = [{ id, cwd: cwd || null, title: title || null }, ...recentChats].slice(0, 8);
  saveRecent();
}
function chatTabs() {
  const live = new Map((cpLinks.live || []).map((x) => [x.id, x]));
  const known = new Map(Object.values(cpLinks.links || {}).flat().map((x) => [x.id, x]));
  const ids = [...new Set([...(cpLinks.live || []).map((x) => x.id), ...recentChats.map((x) => x.id)])];
  // Busy and waiting chats first, then the ones you used last; at most eight.
  return ids.map((id) => {
    const r = recentChats.find((x) => x.id === id), l = live.get(id) || known.get(id);
    const current = id === chat.session && (chat.turns || chat.stop);
    const status = current && chat.stop ? ($('#chat-log .perm-b button') ? 'needs-you' : 'working') : live.get(id)?.status || 'closed';
    return { id, cwd: l?.cwd || r?.cwd, title: (current && chat.title) || (r?.title?.startsWith('/') && l?.title) || r?.title || l?.title || 'Copilot chat', status, live: live.has(id) };
  }).sort((a, b) => (b.live - a.live)).slice(0, 8);
}
function drawTabs() {
  const tabs = chatTabs(), onChat = !$('#chat').hidden;
  const isNew = !chat.turns && !chat.stop;
  const folder = (d) => (d || '').split('/').filter(Boolean).pop() || '';
  $('#side-cp').innerHTML = tabs.map((t, i) => `<a class="ni cp${onChat && t.id === chat.session && !isNew ? ' on' : ''}" href="#copilot"
      data-tab="${esc(t.id)}" data-cwd="${esc(t.cwd || '')}" title="${esc(t.title)}${STATUS_TEXT[t.status] ? ` · ${STATUS_TEXT[t.status]}` : ''}${i < 9 ? ` (Alt+${i + 1})` : ''}">
      <span class="live s-${esc(t.status)}"></span><span class="lab">${esc(t.title)}<small>${esc([STATUS_TEXT[t.status] || (t.live ? 'open' : ''), folder(t.cwd)].filter(Boolean).join(' · '))}</small></span>
      ${t.live ? '' : `<span class="x" data-forget="${esc(t.id)}" title="Remove from this list" aria-label="Remove">✕</span>`}</a>`).join('')
    + (onChat && isNew ? '<a class="ni cp on" href="#copilot"><span class="live"></span><span class="lab">New chat</span></a>' : '');
}
$('#side-cp').addEventListener('click', (e) => {
  const f = e.target.closest('[data-forget]');
  if (f) { e.preventDefault(); e.stopPropagation(); recentChats = recentChats.filter((x) => x.id !== f.dataset.forget); saveRecent(); if (f.dataset.forget === chat.session) newChat(); else drawTabs(); return; }
  const t = e.target.closest('[data-tab]');
  if (!t) return;
  e.preventDefault();
  openChat(true, true);
  if (t.dataset.tab !== chat.session || !chat.turns) openSession(t.dataset.tab, t.dataset.cwd);
});
$('#cp-new-side').onclick = () => { newChat(); openChat(true, true); $('#chat-text').focus(); };
document.addEventListener('keydown', (e) => {
  if (!e.altKey || e.ctrlKey || e.metaKey) return;
  if (e.key === 'n' || e.key === 'N') { e.preventDefault(); newChat(); openChat(true, true); $('#chat-text').focus(); return; }
  const n = Number(e.key);
  if (n >= 1 && n <= 9) {
    const t = chatTabs()[n - 1];
    if (t) { e.preventDefault(); openChat(true, true); if (t.id !== chat.session || !chat.turns) openSession(t.id, t.cwd); }
  }
});
// While the panel is open, keep the dots fresh.
setInterval(() => { if (!$('#chat').hidden && !document.hidden) loadLinks(); }, 10_000);

// The header under the title: what this chat is about, where it runs and where it's at.
function itemIndex() {
  const out = new Map(), g = state.github || {}, j = state.jira || {}, jm = state.jiraMentions || {};
  const pr = (p, status, tone) => itemKey(p.url || '') && !out.has(itemKey(p.url)) && out.set(itemKey(p.url), { title: p.title, url: p.url, status, tone });
  (g.reviewRequested || []).forEach((p) => pr(p, p.rerequested ? 'Re-review' : 'Review requested', 'amber'));
  (g.myPrs || []).forEach((p) => pr(p, p.status?.label, toneOf[p.status?.tone] || 'gray'));
  [...(g.mentions || []), ...(g.assigned || [])].forEach((p) => pr(p));
  (j.assigned || []).forEach((i) => out.set(`issue:${i.key}`, { title: i.summary, url: i.url, status: i.status, tone: statusTone(i.statusCategory) }));
  (jm.tickets || []).forEach((t) => !out.has(`issue:${t.key}`) && out.set(`issue:${t.key}`, { title: t.summary, url: t.url }));
  return out;
}
// Jira status of a ticket that isn't in your lists, fetched for the chat header and kept a
// couple of minutes, so a refresh (or reopening the chat) shows where it is now.
const ctxTickets = new Map();
const ctxPrs = new Set();
function ctxTicketStatus(key) {
  const hit = ctxTickets.get(key);
  if (hit && Date.now() - hit.at < 120_000) return hit.data;
  ctxTickets.set(key, { at: Date.now(), data: hit?.data || null });
  getJson(`/api/issue/${encodeURIComponent(key)}`).then((d) => {
    if (d?.error) return;
    ctxTickets.set(key, { at: Date.now(), data: { status: d.status, tone: statusTone(d.statusCategory) } });
    drawCtx();
  }).catch(() => {});
  return hit?.data || null;
}
function drawCtx() {
  drawTabs();
  if ($('#chat-ctx .rv-pick')) return; // don't redraw under an open review picker
  if (chat.session && chat.turns && chat.title) {
    const r = recentChats.find((x) => x.id === chat.session);
    if (!r) remember(chat.session, chat.cwd, chat.title); else if (r.title !== chat.title) { r.title = chat.title; saveRecent(); }
  }
  const el = $('#chat-ctx');
  const keys = new Set(chat.items);
  // Items linked to this session elsewhere: attached earlier, its branch, or its title.
  for (const [k, list] of Object.entries(cpLinks.links || {})) if (list.some((x) => x.id === chat.session)) keys.add(k);
  const live = [...(cpLinks.live || []), ...Object.values(cpLinks.links || {}).flat()].find((x) => x.id === chat.session);
  const title = chat.title || live?.title;
  const asking = !!$('#chat-log .perm-b button');
  const status = asking ? 'needs-you' : chat.stop ? 'working' : live?.status || (chat.turns ? 'waiting' : null);
  if (!chat.turns && !keys.size && !chat.cwd) { el.hidden = true; return; }
  const idx = itemIndex();
  const items = [...keys].map((k) => {
    const info = idx.get(k) || {};
    const label = k.replace(/^(pr|gh|issue):/, '');
    const url = info.url || (k.startsWith('pr:') ? `https://github.com/${label.replace('#', '/pull/')}` : k.startsWith('gh:') ? `https://github.com/${label.replace('#', '/issues/')}`
      : jiraBaseGuess() ? `${jiraBaseGuess()}/browse/${label}` : '');
    // Whether it's still open: a PR merged since the lists loaded can't take reviewers.
    if (k.startsWith('pr:') && !ctxPrs.has(label)) { ctxPrs.add(label); preview({ dataset: { pr: label } }).then((d) => { notePrState(label, d); if (prClosed.has(label)) drawCtx(); }); }
    const shut = prClosed.get(label);
    const mine = !shut && k.startsWith('pr:') && (state.github?.myPrs || []).some((p) => `pr:${p.repo}#${p.number}` === k);
    return `<div class="ctx-item">📎 <a href="${esc(url || '#')}" data-open-key="${esc(k)}" title="Open here">${esc(label)}</a>${url ? `<a class="ext" href="${esc(url)}" target="_blank" rel="noopener" title="Open on ${k.startsWith('issue:') ? 'Jira' : 'GitHub'}" aria-label="Open on ${k.startsWith('issue:') ? 'Jira' : 'GitHub'}">↗</a>` : ''}
      ${shut ? `<span class="badge b-${shut === 'Merged' ? 'green' : 'gray'}">${shut}</span>` : info.status ? `<span class="badge b-${info.tone || 'gray'}">${esc(info.status)}</span>` : ''}<span>${esc(info.title || '')}</span>
      ${k.startsWith('pr:') && !shut ? reviewerChips(prByKey(k)) : ''}
      ${mine ? `<button class="chip" data-rv-open="${esc(label)}">👥 Request review</button><div class="rv-slot"></div>` : ''}</div>`;
  }).join('');
  el.hidden = false;
  // Where the work stands comes first: the ticket's Jira status and the PR's, then the chat's own state.
  const work = [...keys].map((k) => {
    const info = idx.get(k) || {};
    if (k.startsWith('issue:')) {
      const st = info.status ? info : ctxTicketStatus(k.slice(6));
      return st?.status ? `<a class="badge b-${st.tone || 'gray'}" href="#" data-open-key="${esc(k)}" title="Open ${esc(k.slice(6))} here">${esc(k.slice(6))} · ${esc(st.status)}</a>` : '';
    }
    const shut = k.startsWith('pr:') && prClosed.get(k.slice(3));
    if (shut) return `<a class="badge b-${shut === 'Merged' ? 'green' : 'gray'}" href="#" data-open-key="${esc(k)}">${esc(k.replace(/^(pr|gh):[\w.-]+\//, '').replace('#', ' #'))} · ${shut}</a>`;
    return info.status ? `<a class="badge b-${info.tone || 'gray'}" href="#" data-open-key="${esc(k)}" title="Open ${esc(k.slice(3))} here">${esc(k.replace(/^(pr|gh):[\w.-]+\//, '').replace('#', ' #'))} · ${esc(info.status)}</a>` : '';
  }).filter(Boolean).join('');
  // The next step on this work: the PR's if there is one, else the ticket's.
  const mainKey = [...keys].find((k) => k.startsWith('pr:')) || [...keys].find((k) => k.startsWith('issue:')) || [...keys][0];
  const mainItem = mainKey && itemForKey(mainKey);
  const next = mainItem ? nextHtml(mainItem) : '';
  el.innerHTML = `<div class="ctx-line"><span class="ctx-title">${esc(title || (chat.turns ? 'Copilot session' : 'New chat'))}</span></div>
    <div class="ctx-line ctx-work">${work}${status ? `<span class="ctx-st s-${esc(status)}" title="This chat"><i></i>chat ${esc(STATUS_TEXT[status] || status)}</span>` : ''}</div>
    ${next ? `<div class="ctx-line ctx-next"><span class="lbl-next">Next</span>${next}</div>` : ''}
    ${items}
    ${chat.cwd ? `<div class="ctx-dir" title="${esc(chat.cwd)}">📁 ${esc(chat.cwd.replace(/^\/home\/[^/]+/, '~'))}</div>` : ''}`;
}

function chatSub() {
  drawCtx();
  if (!$('#chat-title input')) $('#chat-title').textContent = chat.title || (chat.turns ? 'Copilot session' : 'New chat');
  const i = chat.info;
  $('#chat-sub').textContent = !i ? '' : !i.available ? 'Copilot CLI not found' : `${i.permissions[$('#cp-perm').value] || ''}${chat.turns ? ` · ${chat.turns} turn${chat.turns > 1 ? 's' : ''}` : ''}`;
}

const jiraBaseGuess = () => standupData?.jiraBase || (state.jira?.assigned?.[0]?.url || '').replace(/\/browse\/.*$/, '') || '';

// Just enough Markdown for chat answers: code blocks, inline code, bold, and links for
// URLs, Jira keys and PRs (which get hover cards).
function md(text) {
  return text.split(/```[\w-]*\n?/).map((part, i) => {
    if (i % 2) return `<pre><code>${esc(part.replace(/\n$/, ''))}</code></pre>`;
    let h = linkify(i ? part.replace(/^\n/, '') : part, jiraBaseGuess());
    h = h.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (m, pre, url) => `${pre}<a href="${url}" target="_blank" rel="noopener">${url}</a>`);
    h = h.replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>').replace(/^#{1,4} (.+)$/gm, '<b>$1</b>');
    return `<span class="txt">${h}</span>`;
  }).join('');
}

function addMsg(cls, html) {
  const log = $('#chat-log');
  log.querySelector('.chat-empty')?.remove();
  const el = document.createElement('div');
  el.className = `msg ${cls}`;
  el.innerHTML = html;
  log.append(el);
  log.scrollTop = log.scrollHeight;
  return el;
}

// Stop watching the chat on screen (it goes on in the background) before showing another.
function detach() {
  chat.stop?.();
  chat.stop = chat.halt = null;
  chat.queued = [];
  sendLabel();
}

function newChat() {
  detach();
  chat.session = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  chat.cwd = null;
  chat.turns = 0;
  chat.title = null; chat.items = [];
  if (chat.info?.permissions) { pickDefaults(); saveCp(); }
  rememberChat();
  showHistory(false);
  $('#chat-log').innerHTML = `<div class="chat-empty">Ask about your PRs, tickets and meetings. Copilot sees what's on your dashboard
    when the chat starts, and runs on your machine with your own Copilot login.</div>`;
  chatSub();
}

// A new chat starts with the defaults from Settings → Copilot, where set, else what you
// picked last; changing a picker applies to the chat you're in.
function pickDefaults() {
  const i = chat.info || {}, d = i.defaults || {};
  $('#cp-model').value = d.model || cpPrefs.model || '';
  $('#cp-effort').value = d.effort || cpPrefs.effort || '';
  const perm = d.permission || cpPrefs.permission;
  $('#cp-perm').value = perm && i.permissions?.[perm] ? perm : 'ask';
}

async function loadCopilotInfo() {
  try { chat.info = await getJson('/api/copilot'); } catch (e) { chat.info = { available: false, error: e.message }; }
  const i = chat.info;
  $('#cp-models').innerHTML = (i.models || []).map((m) => `<option value="${esc(m)}">`).join('');
  $('#cp-effort').innerHTML = `<option value="">Balanced</option>${(i.efforts || []).map((e) => `<option>${esc(e)}</option>`).join('')}`;
  $('#cp-perm').innerHTML = Object.entries(i.permissions || {}).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('');
  pickDefaults();
  $('#cp-allow').value = cpPrefs.allow || '';
  $('#cp-deny').value = cpPrefs.deny || '';
  $('#cp-skills').innerHTML = (i.skills || []).map((sk) =>
    `<button class="chip" data-skill="${esc(sk.name)}" title="${esc(sk.description)}">${esc(sk.name)}</button>`).join('');
  if (!i.available) addMsg('cp', `<div class="err">${esc(i.error || 'The GitHub Copilot CLI wasn’t found on this machine. Install it, or set COPILOT_BIN in ~/.config/clearsky/.env.')}</div>`);
  chatSub();
}

// One answer is a list of segments: text, tool steps and approval questions, in order.
function renderAnswer(segs) {
  return segs.map((g) => {
    if (g.type === 'text') return md(g.text);
    if (g.type === 'tool') return `<div class="tool s-${esc(g.status || 'pending')}"><span>⚙</span>${esc(g.title || 'Tool')}<i>${esc((g.status || '').replace('_', ' '))}</i></div>`;
    if (g.type === 'permission') {
      return `<div class="perm"><div class="perm-t">${esc(g.title)}</div>${g.detail ? `<code>${esc(g.detail)}</code>` : ''}
        <div class="perm-b">${g.answered ? `<span class="perm-done">${esc(g.answered)}</span>`
          : g.options.map((o) => `<button class="${/^allow/.test(o.kind) ? 'ok' : 'no'}" data-perm="${esc(g.id)}" data-option="${esc(o.id)}" data-name="${esc(o.name)}">${esc(o.name)}</button>`).join('')}</div></div>`;
    }
    if (g.type === 'error') return `<div class="err">${esc(g.message)}</div>`;
    if (g.type === 'note') return `<div class="tool"><span>📁</span>${esc(g.text)}</div>`;
    return '';
  }).join('');
}

// Reopen a Copilot session (from here, the terminal or an editor) with its conversation so far.
async function openSession(id, cwd) {
  detach();
  showHistory(false);
  $('#chat-log').innerHTML = '<span class="typing">Opening session</span>';
  try {
    const q = cwd ? `?cwd=${encodeURIComponent(cwd)}` : '';
    const h = await getJson(`/api/copilot/sessions/${encodeURIComponent(id)}${q}`);
    chat.session = h.id; chat.cwd = h.cwd; chat.turns = h.messages.filter((m) => m.role === 'me').length || 1;
    restoreMode(h.id);
    chat.items = [];
    chat.title = h.title || h.messages.find((m) => m.role === 'me')?.text.trim().split('\n')[0].slice(0, 120) || null;
    $('#chat-log').innerHTML = '';
    for (const m of h.messages) {
      if (m.role === 'me') addMsg('me', esc(m.text));
      else { const el = addMsg('cp', renderAnswer(m.segs)); el.segs = m.segs; }
    }
    if (!h.messages.length && !h.busy) addMsg('cp', '<span class="perm-done">Nothing said in this session yet. Carry on below.</span>');
    rememberChat();
    remember(h.id, h.cwd);
    if (h.busy) attachLive(h.id);
  } catch (e) {
    newChat();
    addMsg('cp', `<div class="err">Couldn't open that session: ${esc(e.message)}</div>`);
  }
  chatSub();
}

let sessions = null;
async function loadSessions(force) {
  $('#hist-list').innerHTML = '<div class="chat-empty"><span class="typing">Asking Copilot</span></div>';
  try { sessions = await getJson(`/api/copilot/sessions${force ? '?refresh' : ''}`); drawSessions(); }
  catch (e) { $('#hist-list').innerHTML = `<div class="err">${esc(e.message)}</div>`; }
}
function drawSessions() {
  if (!sessions) return;
  const q = $('#hist-q').value.trim().toLowerCase(), here = $('#hist-here').checked;
  const list = sessions.sessions.filter((x) => (!here || x.cwd === sessions.cwd) && (!q || `${x.title} ${x.cwd}`.toLowerCase().includes(q)));
  const folder = (d) => (d || '').split('/').filter(Boolean).pop() || d || '';
  $('#hist-list').innerHTML = list.map((x) => `<button class="hs${x.id === chat.session ? ' cur' : ''}" data-sid="${esc(x.id)}" data-cwd="${esc(x.cwd || '')}">
      <b>${esc(x.title || 'Untitled session')}</b>
      <small>${x.updatedAt ? esc(ago(x.updatedAt)) : ''}${x.cwd ? ` · ${esc(folder(x.cwd))}` : ''}</small>${x.working ? '<span class="hbadge work">working</span>' : x.open ? '<span class="hbadge" title="Open in a terminal or editor">open</span>' : ''}${x.here ? '<span class="hbadge">live here</span>' : ''}
    </button>`).join('') || '<div class="chat-empty">No sessions match.</div>';
}
function showHistory(open = $('#chat-hist').hidden) {
  $('#chat-hist').hidden = !open;
  $('#chat-hist-btn').classList.toggle('on', open);
  if (open) { loadSessions(); $('#hist-q').focus(); }
}

// ---- PRs and tickets attached to the next message

function refLabel(r) { return r.kind === 'issue' ? r.key : `${r.repo.split('/').pop()}#${r.number}`; }
function refCandidates() {
  const out = new Map();
  const add = (r, title, where) => { const k = refLabel(r) + (r.repo || ''); if (!out.has(k)) out.set(k, { ...r, title, where }); };
  const g = state.github || {}, j = state.jira || {}, jm = state.jiraMentions || {};
  const pr = (p, where) => /\/pull\/\d+/.test(p.url || '') && add({ kind: 'pr', repo: p.repo, number: p.number }, p.title, where);
  (g.reviewRequested || []).forEach((p) => pr(p, 'review'));
  (g.myPrs || []).forEach((p) => pr(p, 'my PR'));
  (g.mentions || []).forEach((p) => pr(p, 'mention'));
  (g.assigned || []).forEach((p) => pr(p, 'assigned'));
  const ghIssue = (i, where) => /\/issues\/\d+/.test(i.url || '') && add({ kind: 'gh', repo: i.repo, number: i.number }, i.title, where);
  (g.assigned || []).forEach((i) => ghIssue(i, 'GitHub issue'));
  (g.mentions || []).forEach((i) => ghIssue(i, 'mention'));
  (jm.tickets || []).forEach((t) => add({ kind: 'issue', key: t.key }, t.summary, 'mention'));
  (j.assigned || []).forEach((i) => add({ kind: 'issue', key: i.key }, i.summary, i.status || 'Jira'));
  return [...out.values()];
}
// Also take a typed reference: SSP-1234, org/repo#12, or a PR or Jira link.
function parseRef(q) {
  q = q.trim();
  let m = q.match(/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)/);
  if (m) return { kind: 'gh', repo: m[1], number: Number(m[2]) };
  m = q.match(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/) || q.match(/^([\w.-]+\/[\w.-]+)#(\d+)$/);
  if (m) return { kind: 'pr', repo: m[1], number: Number(m[2]) };
  m = q.match(/\/browse\/([A-Z][A-Z0-9_]+-\d+)/i) || q.match(/^([A-Z][A-Z0-9_]+-\d+)$/i);
  return m ? { kind: 'issue', key: m[1].toUpperCase() } : null;
}
function drawRefs() {
  $('#cp-refs').querySelectorAll('.ref').forEach((el) => el.remove());
  for (const [i, r] of chat.refs.entries()) {
    if (r.key && r.title?.startsWith(r.key)) r.title = r.title.slice(r.key.length).replace(/^\s*·\s*/, '');
    const el = document.createElement('span');
    el.className = 'ref';
    el.innerHTML = `<span title="${esc(r.title || '')}">${esc(refLabel(r))}${r.title ? ` ${esc(r.title)}` : ''}</span><button type="button" data-unref="${i}" aria-label="Remove">✕</button>`;
    $('#cp-refs').append(el);
  }
}
function addRef(r) {
  if (!r || chat.refs.some((x) => refLabel(x) === refLabel(r) && x.repo === r.repo) || chat.refs.length >= 8) return;
  chat.refs.push(r);
  drawRefs();
}
function closeRefPick() { $('#cp-refs .ref-pick:not(.slash)')?.remove(); }
function openRefPick() {
  if ($('#cp-refs .ref-pick:not(.slash)')) return closeRefPick();
  const box = document.createElement('div');
  box.className = 'ref-pick';
  box.innerHTML = '<input placeholder="Find a PR or ticket, or paste SSP-1234 / a link" spellcheck="false"><ul></ul>';
  $('#cp-refs').append(box);
  const input = box.querySelector('input'), ul = box.querySelector('ul');
  const all = refCandidates();
  let shown = [], on = 0;
  const draw = () => {
    const q = input.value.trim().toLowerCase();
    shown = all.filter((r) => !q || `${refLabel(r)} ${r.repo || ''} ${r.title || ''}`.toLowerCase().includes(q)).slice(0, 40);
    const typed = parseRef(input.value);
    if (typed && !shown.some((r) => refLabel(r) === refLabel(typed))) shown.unshift({ ...typed, title: '', where: 'add' });
    on = Math.min(on, Math.max(shown.length - 1, 0));
    ul.innerHTML = shown.map((r, i) => `<li data-i="${i}" class="${i === on ? 'on' : ''}"><code>${esc(refLabel(r))}</code>${esc(r.title || '')}<small>${esc(r.where || '')}</small></li>`).join('')
      || '<li class="none">Nothing on your dashboard matches. Type a key like SSP-1234 or org/repo#12.</li>';
  };
  const pick = (i) => { const r = shown[i]; if (!r) return; addRef({ ...r }); closeRefPick(); $('#chat-text').focus(); };
  input.addEventListener('input', () => { on = 0; draw(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { on = Math.min(on + 1, shown.length - 1); draw(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { on = Math.max(on - 1, 0); draw(); e.preventDefault(); }
    else if (e.key === 'Enter') { pick(on); e.preventDefault(); }
    else if (e.key === 'Escape') { closeRefPick(); e.stopPropagation(); }
  });
  ul.addEventListener('mousedown', (e) => { const li = e.target.closest('[data-i]'); if (li) { e.preventDefault(); pick(+li.dataset.i); } });
  draw();
  input.focus();
}

async function send(text) {
  if (!text.trim() || chat.stop) return;
  const refs = chat.refs.map(({ kind, key, repo, number }) => ({ kind, key, repo, number }));
  addMsg('me', `${refs.length ? `<span class="refs-sent">📎 ${chat.refs.map((r) => esc(refLabel(r))).join(', ')}</span>` : ''}${esc(text)}`);
  chat.refs = [];
  chat.items = [...new Set([...chat.items, ...refs.map(refKeyOf)])];
  if (!chat.turns && !chat.title) chat.title = text.trim().split('\n')[0].slice(0, 120);
  drawRefs();
  const out = addMsg('cp', '<span class="typing">Thinking</span>');
  const segs = [];
  out.segs = segs;
  const draw = () => { out.innerHTML = renderAnswer(segs) || '<span class="typing">Thinking</span>'; $('#chat-log').scrollTop = $('#chat-log').scrollHeight; drawCtx(); };
  const apply = (e) => {
    const last = segs.at(-1);
    if (e.type === 'text') { if (last?.type === 'text') last.text += e.text; else segs.push({ type: 'text', text: e.text }); }
    else if (e.type === 'tool') { const t = segs.find((g) => g.type === 'tool' && g.id === e.id); if (t) Object.assign(t, Object.fromEntries(Object.entries(e).filter(([, v]) => v != null))); else segs.push(e); }
    else if (e.type === 'permission' || e.type === 'error') segs.push(e);
    else if (e.type === 'session') { if (here()) { chat.session = e.id; rememberChat(); } rememberMode(e.id, mine.mode); mine.id = e.id; remember(e.id, chat.cwd, mine.title); drawTabs(); }
    else if (e.type === 'commands' && chat.info) chat.info.commands = e.commands;
    // A new chat about a PR or ticket is named after it, not after the skill or first words.
    else if (e.type === 'title') { mine.title = e.title; if (here()) { chat.title = e.title; drawCtx(); } }
    else if (e.type === 'cwd') { if (here()) { chat.cwd = e.cwd; drawCtx(); } segs.push({ type: 'note', text: `Working in ${e.cwd}` }); }
    if (e.type === 'done' || e.type === 'error') ended = true;
  };
  let ended = false;
  const ctrl = new AbortController();
  // This turn's chat; a new one gets Copilot's own id once it starts.
  const mine = { id: chat.session, title: chat.turns ? null : text.trim().split('\n')[0].slice(0, 120), mode: pickerMode() };
  rememberMode(chat.session, mine.mode);
  const here = () => chat.session === mine.id;
  let halted = false;
  chat.stop = () => ctrl.abort(); // stop watching (switching chats); the turn goes on
  chat.halt = () => { halted = true; haltTurn(mine.id); };
  sendLabel();
  drawCtx();
  try {
    const res = await fetchWithToken('/api/copilot', { method: 'POST', signal: ctrl.signal,
      body: JSON.stringify({ message: skillPrompt(text), session: chat.session, resume: chat.turns > 0, cwd: chat.cwd, refs, ...cpPrefs, permission: $('#cp-perm').value }) });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    const reader = res.body.getReader(), dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const l of lines) if (l.trim()) { try { apply(JSON.parse(l)); } catch {} }
      draw();
    }
    const last = segs.at(-1);
    if (last?.type === 'text') last.text = last.text.trimEnd();
    if (!ended) segs.push({ type: 'error', message: 'Interrupted: Copilot stopped before finishing (was Clearsky restarted?). Send a message to carry on in this session.' });
    if (here()) chat.turns++;
  } catch (e) {
    segs.push({ type: 'error', message: e.name !== 'AbortError' ? e.message : halted ? 'Stopped.' : 'Stopped watching; it goes on in the background.' });
    if (e.name === 'AbortError' && here()) chat.turns++;
  } finally {
    if (here()) rememberChat();
    setTimeout(loadLinks, 500);
    if (!segs.length) segs.push({ type: 'error', message: 'No answer.' });
    // Switched to another chat meanwhile: that one owns the panel now.
    if (!here()) return;
    draw();
    chat.stop = chat.halt = null;
    sendLabel();
    chatSub();
    sendQueued();
  }
}

// Stop a turn on purpose (the Stop button), here or one that went on in the background.
async function haltTurn(id) {
  try { await post('/api/copilot/stop', { chat: id }); } catch {}
  setTimeout(() => { if (chat.session === id && chat.stop) chat.stop(); }, 3000);
}

// Back on a chat that is still busy: show its open questions and follow it to the end of the
// turn, then reload it so the whole answer is there.
async function attachLive(id) {
  const out = addMsg('cp', '<span class="typing">Still working</span>');
  const segs = [];
  out.segs = segs;
  const draw = () => { out.innerHTML = renderAnswer(segs) || '<span class="typing">Still working</span>'; $('#chat-log').scrollTop = $('#chat-log').scrollHeight; drawCtx(); };
  const ctrl = new AbortController();
  chat.stop = () => ctrl.abort();
  chat.halt = () => haltTurn(id);
  sendLabel();
  drawCtx();
  let done = false;
  try {
    const res = await fetch(`/api/copilot/sessions/${encodeURIComponent(id)}/live`, { signal: ctrl.signal });
    const reader = res.body.getReader(), dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done: end } = await reader.read();
      if (end) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const l of lines) {
        let e; try { e = JSON.parse(l); } catch { continue; }
        const last = segs.at(-1);
        if (e.type === 'text') { if (last?.type === 'text') last.text += e.text; else segs.push({ type: 'text', text: e.text }); }
        else if (e.type === 'tool') { const t = segs.find((g) => g.type === 'tool' && g.id === e.id); if (t) Object.assign(t, Object.fromEntries(Object.entries(e).filter(([, v]) => v != null))); else segs.push(e); }
        else if (e.type === 'permission' || e.type === 'error') segs.push(e);
        else if (e.type === 'done') done = true;
      }
      draw();
    }
  } catch { /* switched away */ }
  if (chat.session !== id) return;
  chat.stop = chat.halt = null;
  sendLabel();
  if (sendQueued()) return;
  if (done) openSession(id, chat.cwd); else chatSub();
}

// Approve or deny a step Copilot asked about (Ask mode).
$('#chat-log').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-perm]');
  if (!b) return;
  const msg = b.closest('.msg'), seg = msg?.segs?.find((g) => g.type === 'permission' && g.id === b.dataset.perm);
  if (seg) seg.answered = b.dataset.name;
  b.closest('.perm-b').innerHTML = `<span class="perm-done">${esc(b.dataset.name)}</span>`;
  drawCtx();
  try { await post('/api/copilot/permission', { chat: chat.session, id: b.dataset.perm, option: b.dataset.option }); }
  catch (err) { if (seg) seg.answered = `Couldn't send: ${err.message}`; }
});

// The chat is a view of its own (#copilot). With `ready`, the caller has already picked the
// session; otherwise the one you had open last comes back.
function openChat(open = true, ready = false) {
  if (!open) return back();
  if (location.hash !== '#copilot') { openChatSkip = ready; location.hash = '#copilot'; } else showChat(ready);
}
function showChat(ready) {
  if (!chat.session && !ready) {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(CUR_KEY) || 'null'); } catch {}
    if (saved?.id) openSession(saved.id, saved.cwd); else newChat();
  }
  if (!chat.info) loadCopilotInfo();
  drawCtx();
  setTimeout(() => $('#chat-text').focus(), 0);
}

// ---------------------------------------------------------------- theme

function setTheme(t) {
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  try { localStorage.setItem('clearsky.theme', t === 'auto' ? '' : t); } catch {}
  for (const b of document.querySelectorAll('[data-theme-pick]')) b.setAttribute('aria-pressed', String(b.dataset.themePick === (t || 'auto')));
}
$('#theme').onclick = (e) => { const b = e.target.closest('[data-theme-pick]'); if (b) setTheme(b.dataset.themePick); };
setTheme(document.documentElement.dataset.theme || 'auto');

// ---------------------------------------------------------------- talk

// Click to talk, with the browser's own speech recognition (Chrome sends the audio to Google
// to turn it into text). What you say lands in the message box; you still press Send.
const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
if (Speech) {
  $('#chat-mic').hidden = false;
  $('#chat-mic').onclick = () => {
    if (rec) { rec.stop(); return; }
    const box = $('#chat-text'), before = box.value ? `${box.value.replace(/\s*$/, '')} ` : '';
    rec = new Speech();
    rec.lang = navigator.language || 'en-US';
    rec.interimResults = true;
    rec.continuous = true;
    rec.onresult = (e) => { box.value = before + [...e.results].map((r) => r[0].transcript).join('').trim(); };
    rec.onerror = (e) => { if (e.error !== 'aborted' && e.error !== 'no-speech') addMsg('cp', `<div class="err">Talk: ${esc(e.error === 'not-allowed' ? 'the browser blocked the microphone' : e.error)}</div>`); };
    rec.onend = () => { rec = null; $('#chat-mic').classList.remove('on'); $('#chat-mic').setAttribute('aria-pressed', 'false'); box.focus(); };
    rec.start();
    $('#chat-mic').classList.add('on'); $('#chat-mic').setAttribute('aria-pressed', 'true');
  };
}
$('#chat-new').onclick = newChat;
$('#chat-hist-btn').onclick = () => showHistory();
$('#hist-q').addEventListener('input', drawSessions);
$('#hist-here').addEventListener('change', drawSessions);
$('#hist-refresh').onclick = () => loadSessions(true);
$('#hist-list').addEventListener('click', (e) => { const b = e.target.closest('[data-sid]'); if (b) openSession(b.dataset.sid, b.dataset.cwd); });
$('#cp-ref-add').onclick = openRefPick;
$('#cp-refs').addEventListener('click', (e) => { const i = e.target.closest('[data-unref]')?.dataset.unref; if (i != null) { chat.refs.splice(+i, 1); drawRefs(); } });
document.addEventListener('mousedown', (e) => { if (!e.target.closest('.ref-pick, #cp-ref-add')) closeRefPick(); });
for (const id of ['#cp-model', '#cp-effort', '#cp-perm', '#cp-allow', '#cp-deny']) $(id).addEventListener('change', saveCp);
$('#chat-form').onsubmit = (e) => {
  e.preventDefault();
  const t = $('#chat-text').value;
  // While Copilot works, a message waits for the turn to end; an empty box means Stop.
  if (chat.stop && !t.trim()) return chat.halt ? chat.halt() : chat.stop();
  $('#chat-text').value = '';
  if (chat.stop) {
    const el = addMsg('me', `${esc(t)}<span class="queued">Sends when Copilot is done</span>`);
    el.classList.add('is-queued');
    chat.queued.push({ text: t, el });
  } else send(t);
  sendLabel();
};
// The button says what Enter will do.
const SEND_ICONS = {
  send: '<path d="M2.5 2.75 14 8 2.5 13.25 4.25 8zM4.25 8H9"/>',
  queue: '<path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10"/>',
  stop: '<rect x="1" y="1" width="14" height="14" rx="2"/>',
};
function sendLabel() {
  const st = !chat.stop ? 'send' : $('#chat-text').value.trim() ? 'queue' : 'stop', b = $('#chat-send');
  if (b.dataset.state === st) return;
  b.dataset.state = st;
  b.innerHTML = `<svg viewBox="0 0 16 16">${SEND_ICONS[st]}</svg>`;
  const t = { send: 'Send (Enter)', queue: 'Queue: sends when Copilot is done (Enter)', stop: 'Stop Copilot' }[st];
  b.title = t; b.setAttribute('aria-label', t.replace(/ \(.*/, ''));
}
$('#chat-text').addEventListener('input', sendLabel);
// Typing @ (at the start or after a space) opens the PR/ticket picker instead.
$('#chat-text').addEventListener('input', (e) => {
  const ta = e.target, i = ta.selectionStart;
  if (e.data !== '@' || ta.value[i - 1] !== '@' || (i > 1 && !/\s/.test(ta.value[i - 2]))) return;
  ta.value = ta.value.slice(0, i - 1) + ta.value.slice(i);
  ta.setSelectionRange(i - 1, i - 1);
  openRefPick();
});
// After a turn: send the next message you typed meanwhile. True if it did.
function sendQueued() {
  const next = chat.queued.shift();
  if (!next) return false;
  next.el.remove();
  send(next.text);
  return true;
}
// "/" at the start of the message opens a menu of skills and a few panel commands.
const SLASH = [
  { name: 'new', description: 'Start a new chat', run: () => newChat() },
  { name: 'history', description: 'Your Copilot sessions', run: () => showHistory(true) },
  { name: 'ref', description: 'Attach a PR or ticket', run: () => openRefPick() },
];
let slash = null;
function slashItems() {
  const q = $('#chat-text').value.match(/^\/([\w-]*)$/)?.[1];
  if (q == null) return null;
  const skills = (chat.info?.skills || []).map((sk) => ({ ...sk, skill: true }));
  // In Ask mode Copilot runs slash commands itself, so offer everything it listed.
  const names = new Set(skills.map((x) => x.name));
  const cmds = (chat.info?.commands || []).filter((c) => !names.has(c.name)).map((c) => ({ ...c, skill: true, kind: 'command' }));
  return [...skills, ...cmds, ...SLASH].filter((x) => x.name.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => b.name.toLowerCase().startsWith(q.toLowerCase()) - a.name.toLowerCase().startsWith(q.toLowerCase()));
}
function drawSlash() {
  const items = slashItems();
  $('#cp-refs .slash')?.remove();
  if (!items) { slash = null; return; }
  slash = { items, on: Math.min(slash?.on || 0, Math.max(items.length - 1, 0)) };
  const box = document.createElement('div');
  box.className = 'ref-pick slash';
  box.innerHTML = `<ul>${items.map((x, i) => `<li data-si="${i}" class="${i === slash.on ? 'on' : ''}"><code>/${esc(x.name)}</code>${esc(x.description || '')}<small>${x.kind || (x.skill ? 'skill' : '')}</small></li>`).join('')
    || '<li class="none">No skill or command matches.</li>'}</ul>`;
  $('#cp-refs').append(box);
}
function pickSlash(i) {
  const x = slash?.items[i];
  if (!x) return;
  const ta = $('#chat-text');
  ta.value = x.skill ? `/${x.name} ` : '';
  $('#cp-refs .slash')?.remove();
  slash = null;
  if (x.run) x.run(); else ta.focus();
}
// Click the chat's title to rename it; Enter saves, Esc cancels.
$('#chat-title').addEventListener('click', () => {
  const h = $('#chat-title');
  if (!chat.session || !chat.turns || h.querySelector('input')) return;
  const input = Object.assign(document.createElement('input'), { value: chat.title || '', className: 'rename', maxLength: 120 });
  input.setAttribute('aria-label', 'Chat name');
  h.replaceChildren(input);
  input.focus(); input.select();
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    h.textContent = (save && v) || chat.title || 'Copilot session';
    if (save && v && v !== chat.title) {
      chat.title = v;
      rememberChat();
      await post('/api/copilot/rename', { id: chat.session, title: v }).catch(() => {});
      loadLinks();
    }
    drawCtx();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
});
// /commands go to Copilot as typed; without its command list, skills are asked for in words.
function skillPrompt(text) {
  if (chat.info?.commands) return text;
  const m = text.match(/^\/([\w-]+)(?:\s+([\s\S]*))?$/);
  const sk = m && (chat.info?.skills || []).find((x) => x.name === m[1]);
  return sk ? `Use the ${sk.name} skill.${m[2] ? ` ${m[2]}` : ''}` : text;
}
$('#chat-text').addEventListener('input', drawSlash);
$('#chat-text').addEventListener('blur', () => setTimeout(() => { $('#cp-refs .slash')?.remove(); slash = null; }, 150));
$('#cp-refs').addEventListener('mousedown', (e) => { const li = e.target.closest('[data-si]'); if (li) { e.preventDefault(); pickSlash(+li.dataset.si); } });
$('#chat-text').addEventListener('keydown', (e) => {
  if (slash?.items.length) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { slash.on = (slash.on + (e.key === 'ArrowDown' ? 1 : -1) + slash.items.length) % slash.items.length; drawSlash(); e.preventDefault(); return; }
    if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') { e.preventDefault(); pickSlash(slash.on); return; }
    if (e.key === 'Escape') { $('#cp-refs .slash')?.remove(); slash = null; e.stopPropagation(); return; }
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#chat-form').requestSubmit(); }
});
$('#cp-skills').addEventListener('click', (e) => {
  const name = e.target.closest('[data-skill]')?.dataset.skill;
  if (!name) return;
  const ta = $('#chat-text');
  ta.value = `/${name} ${ta.value.replace(/^\/[\w-]*\s*/, '')}`.trimEnd() + ' ';
  ta.focus();
});
