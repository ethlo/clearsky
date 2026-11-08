// Clearsky page: the Copilot chat, its sessions, references, theme and talk.
// The server joins web/js/*.js in name order into one script in index.html, so they share one scope.

// ---------------------------------------------------------------- Copilot chat

const chat = { session: null, cwd: null, turns: 0, stop: null, info: null, refs: [], files: [], title: null, items: [], queued: [] };
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
  cpPrefs = { model: $('#cp-model').value.trim(), effort: $('#cp-effort').value, permission: $('#cp-perm').value };
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
    const key = Object.entries(cpLinks.links || {}).find(([, list]) => list.some((x) => x.id === id))?.[0];
    return { id, cwd: l?.cwd || r?.cwd, title: (current && chat.title) || (r?.title?.startsWith('/') && l?.title) || r?.title || l?.title || 'Copilot chat', status, live: live.has(id), pr: prStateOf(key) };
  }).sort((a, b) => (b.live - a.live)).slice(0, 8);
}
function drawTabs() {
  const tabs = chatTabs(), onChat = !$('#chat').hidden;
  const isNew = !chat.turns && !chat.stop;
  const folder = (d) => (d || '').split('/').filter(Boolean).pop() || '';
  $('#side-cp').innerHTML = tabs.map((t, i) => `<a class="ni cp${onChat && t.id === chat.session && !isNew ? ' on' : ''}" href="#copilot"
      data-tab="${esc(t.id)}" data-cwd="${esc(t.cwd || '')}" title="${esc(t.title)}${STATUS_TEXT[t.status] ? ` · ${STATUS_TEXT[t.status]}` : ''}${i < 9 ? ` (Alt+${i + 1})` : ''}">
      <span class="live s-${esc(t.status)}"></span><span class="lab">${esc(t.title)}<small>${esc([STATUS_TEXT[t.status] || (t.live ? 'open' : ''), t.pr, folder(t.cwd)].filter(Boolean).join(' · '))}</small></span>
      ${t.status === 'working' || t.status === 'needs-you' ? '' : `<span class="x" data-nudge-tab="${esc(t.id)}" title="Nudge: send Copilot “Try again.”" aria-label="Nudge">${icon('refresh', 12)}</span>`}
      ${t.live ? '' : `<span class="x" data-forget="${esc(t.id)}" title="Remove from this list" aria-label="Remove">✕</span>`}</a>`).join('')
    + (onChat && isNew ? '<a class="ni cp on" href="#copilot"><span class="live"></span><span class="lab">New chat</span></a>' : '');
}
$('#side-cp').addEventListener('click', (e) => {
  const f = e.target.closest('[data-forget]');
  if (f) { e.preventDefault(); e.stopPropagation(); recentChats = recentChats.filter((x) => x.id !== f.dataset.forget); saveRecent(); if (f.dataset.forget === chat.session) newChat(); else drawTabs(); return; }
  const t = e.target.closest('[data-tab]');
  if (!t) return;
  e.preventDefault();
  if (e.target.closest('[data-nudge-tab]')) {
    e.stopPropagation();
    openChat(true, true);
    (async () => { if (t.dataset.tab !== chat.session || !chat.turns) await openSession(t.dataset.tab, t.dataset.cwd); if (!chat.stop) send('Try again.'); })();
    return;
  }
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
    const st = info.status ? info : k.startsWith('issue:') ? ctxTicketStatus(label) || {} : {};
    const mine = !shut && k.startsWith('pr:') && (state.github?.myPrs || []).some((p) => `pr:${p.repo}#${p.number}` === k);
    return `<div class="ctx-item">${icon('clip', 13)} <a href="${esc(url || '#')}" data-open-key="${esc(k)}" title="Open here">${esc(label)}</a>${url ? `<a class="ext" href="${esc(url)}" target="_blank" rel="noopener" title="Open on ${k.startsWith('issue:') ? 'Jira' : 'GitHub'}" aria-label="Open on ${k.startsWith('issue:') ? 'Jira' : 'GitHub'}">↗</a>` : ''}
      ${shut ? `<span class="badge b-${shut === 'Merged' ? 'green' : 'gray'}">${shut}</span>` : st.status ? `<span class="badge b-${st.tone || 'gray'}">${esc(st.status)}</span>` : ''}<span>${esc(info.title || '')}</span>
      ${k.startsWith('pr:') && !shut ? reviewerChips(prByKey(k)) : ''}
      ${mine ? `<button class="chip" data-rv-open="${esc(label)}">${icon('users', 14)} Request review</button><div class="rv-slot"></div>` : ''}</div>`;
  }).join('');
  el.hidden = false;
  // The next step on this work: the PR's if there is one, else the ticket's.
  const mainKey = [...keys].find((k) => k.startsWith('pr:')) || [...keys].find((k) => k.startsWith('issue:')) || [...keys][0];
  const mainItem = mainKey && itemForKey(mainKey);
  // Not while this chat is at it, and not "continue the chat" when you're in it.
  const n = mainItem && !['working', 'needs-you'].includes(status) && nextStep(mainItem);
  const next = n && n.run !== 'copilot' ? nextHtml(mainItem, n) : '';
  // Each ticket and PR once: its row says what it is and where it stands, so the chat's
  // title is left out when it only repeats them.
  const labels = [...keys].map((k) => k.replace(/^(pr|gh|issue):/, '').replace(/^[\w.-]+\//, ''));
  const showTitle = !labels.some((l) => (title || '').includes(l));
  el.innerHTML = `${showTitle ? `<div class="ctx-line"><span class="ctx-title">${esc(title || (chat.turns ? 'Copilot session' : 'New chat'))}</span></div>` : ''}
    ${items}
    <div class="ctx-line ctx-work">${status ? `<span class="ctx-st s-${esc(status)}" title="This chat"><i></i>chat ${esc(STATUS_TEXT[status] || status)}</span>` : ''}</div>
    ${next ? `<div class="ctx-line ctx-next"><span class="lbl-next">Next</span>${next}</div>` : ''}
    ${chat.cwd ? `<div class="ctx-dir" title="${esc(chat.cwd)}">${icon('folder', 13)} ${esc(tilde(chat.cwd))}</div>` : ''}`;
}

// What this chat runs with: mode and whether it's in the sandbox, model, effort, tokens, folders.
let infoFor = null, infoAt = 0, infoData = null;
async function drawInfo(force) {
  const id = chat.turns ? chat.session : null;
  if (force || id !== infoFor || Date.now() - infoAt > 15_000) {
    infoFor = id; infoAt = Date.now();
    try { infoData = await getJson(`/api/copilot/chat${id ? `?id=${encodeURIComponent(id)}` : ''}`); } catch { infoData = null; }
    drawTrim();
  }
  const d = infoData || {}, i = chat.info || {};
  const fmtCredits = (n) => String(n >= 10 ? Math.round(n) : Math.round(n * 10) / 10);
  const k = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
  const perm = $('#cp-perm').value;
  const sandbox = d.sandboxed != null ? (d.sandboxed ? 'sandboxed' : 'not sandboxed') : perm === 'sandboxed' || d.sandbox ? 'sandboxed' : 'not sandboxed';
  const u = d.usage;
  const rows = [
    ['Mode', `${i.permissions?.[perm] || perm} · ${sandbox}`],
    chat.turns && ['Turns', String(chat.turns)],
    ['Model', $('#cp-model').value.trim() || 'Copilot default'],
    ['Effort', $('#cp-effort').selectedOptions[0]?.textContent || 'Balanced'],
    u && ['Tokens', `in ${k(u.input)}${u.input ? ` (${Math.round(100 * u.cached / u.input)}% cached)` : ''} · out ${k(u.output)}${u.premium != null ? ` · ${u.premium} premium` : ''}`],
    // AI credits so far, split like the line a finished chat puts on its PR and ticket.
    d.credits && ['Credits', `${fmtCredits(d.credits.total)}${d.credits.parts.filter((p) => p.credits != null).length > 1 ? ` (${d.credits.parts.filter((p) => p.credits != null).map((p) => `${p.kind} ${fmtCredits(p.credits)}`).join(' · ')})` : ''}`],
    u?.context != null && ['Context', `${k(u.context)}${u.limit ? ` of ${k(u.limit)}` : ''}`],
    d.cwd && ['Folder', d.cwd],
    d.folders?.length && ['Can change', d.folders.join(', ')],
    d.read?.length && ['Can read', d.read.join(', ')],
    // Folders for this chat only: added here, on top of Settings → Copilot.
    chat.turns && ['This chat', `${(d.chatFolders || []).map((f) => `<span class="cf">${esc(f)}<button type="button" class="x" data-folder-off="${esc(f)}" title="Take ${esc(f)} off this chat" aria-label="Remove">✕</button></span>`).join('')}<form class="cf-add" data-folder-form><input name="f" placeholder="~/dev/another-repo" spellcheck="false" aria-label="Folder to add to this chat"><button type="submit" class="linkish" title="This chat may read and change files there; review, vm and outside work there too. It applies from your next message.">Add folder</button></form>`],
    d.github && ['GitHub', d.github],
    d.hosts && ['Hosts', `<details><summary>${d.hosts.length} allowed</summary>${d.hosts.map(esc).join(', ')}</details>`],
  ].filter(Boolean);
  $('#cp-info').innerHTML = rows.map(([a, b]) => `<dt>${a}</dt><dd>${a === 'Hosts' || a === 'This chat' ? b : esc(b)}${a === 'Credits' && d.credits.line ? ` <button type="button" class="linkish" data-copy-text="${esc(d.credits.line)}" title="${esc(d.credits.line)}">Copy line</button>` : ''}</dd>`).join('');
  $('#cp-restart').disabled = !d.running;
  $('#cp-restart').hidden = $('#cp-close').hidden = !chat.turns;
}

// This chat's VM (`vm <command>`): what Copilot has running in it, what it can reach, and its log.
let vmData = null, vmFor = null;
// Keeping a chat lean. Every step sends Copilot the whole conversation again, so a long one gets
// slower and loses track; one picked up after hours idle is read in full (its cache has expired).
// So: Compact (Copilot's own /compact) once it's over 60% full and not working, and Start fresh
// for a big chat you come back to after a day. Never a clear: that throws away what it knows.
const TRIM = { compact: 0.6, cold: 0.3, coldMs: 24 * 3600e3 };
function drawTrim() {
  const el = $('#cp-trim'), d = infoData || {}, u = d.usage;
  const full = u?.context != null && u.limit ? u.context / u.limit : 0;
  const cold = d.lastAt && Date.now() - d.lastAt > TRIM.coldMs && full >= TRIM.cold;
  const show = chat.turns && !chat.stop && !d.busy && (full >= TRIM.compact || cold);
  el.hidden = !show;
  if (!show) return;
  const pct = `${Math.round(100 * full)}% full`;
  el.innerHTML = `<span>${cold ? `This chat is ${pct} and was last used ${esc(ago(new Date(d.lastAt).toISOString()))}: picking it up reads all of it again.`
    : `This chat's context is ${pct}: long chats get slower and lose track.`}</span>
    <button type="button" data-trim="compact" title="Copilot's /compact: it replaces the conversation with its own summary">Compact</button>
    ${cold ? '<button type="button" data-trim="fresh" title="A new chat in the same folder, with the same PRs and tickets and this chat\'s last answer, ready for you to edit and send. This one stays in History.">Start fresh</button>' : ''}
    <button type="button" data-trim="hide" class="x" title="Not now" aria-label="Not now">✕</button>`;
}
$('#cp-trim').addEventListener('click', (e) => {
  const b = e.target.closest('[data-trim]');
  if (!b) return;
  $('#cp-trim').hidden = true;
  if (b.dataset.trim === 'compact') send('/compact');
  if (b.dataset.trim === 'fresh') freshStart();
});
// A new chat that picks up where this one left off, from facts and its last answer (no extra
// request to the old chat). You read the handoff before sending it.
function freshStart() {
  const cwd = chat.cwd, title = chat.title, refs = (infoData?.refs || []).map(parseRefKey).filter(Boolean);
  const answers = [...document.querySelectorAll('#chat-log .msg.cp')].map((m) => (m.segs || []).filter((g) => g.type === 'text').map((g) => g.text).join('')).filter((t) => t.trim());
  const last = (answers.at(-1) || '').trim();
  newChat();
  chat.cwd = cwd;
  chat.refs = refs;
  drawRefs();
  $('#chat-text').value = `Pick up this work from an earlier chat${title ? ` ("${title}")` : ''}. Check the current state (git status, the branch, the PR) before doing anything.${last ? `\n\nThe earlier chat's last answer:\n${last.length > 3000 ? `${last.slice(0, 3000)}…` : last}` : ''}\n\nNext: `;
  $('#chat-text').focus();
}
const parseRefKey = (k) => {
  const i = k.match(/^issue:([A-Z][A-Z0-9_]+-\d+)$/);
  if (i) return { kind: 'issue', key: i[1] };
  const p = k.match(/^pr:([\w.-]+\/[\w.-]+)#(\d+)$/);
  return p ? { kind: 'pr', repo: p[1], number: Number(p[2]) } : null;
};

async function drawVm() {
  const el = $('#cp-vm');
  const id = chat.turns ? chat.session : null;
  if (id !== vmFor) { vmFor = id; vmData = null; }
  if (id && !$('#chat').hidden && !document.hidden) {
    try { const d = await getJson(`/api/vm?id=${encodeURIComponent(id)}`); if (vmFor === id) vmData = d.vm; } catch {}
  }
  const v = vmData;
  if (!v) { el.hidden = true; return; }
  el.hidden = false;
  const on = v.state === 'running', gb = (mb) => `${(mb / 1024).toFixed(1)} GB`;
  const up = v.startedAt ? Math.round((Date.now() - Date.parse(v.startedAt)) / 6e4) : null;
  const sys = v.system ? `${gb(v.system.memUsedMb)} of ${gb(v.system.memTotalMb)}` : gb(v.memMb);
  // Waiting in line for a VM (Settings → Copilot → VMs at the same time): where, and of how many.
  const qd = v.queue?.position ? v.queue : null;
  const st = qd ? 'queued' : v.state;
  const head = `<div class="vm-h"><span class="vm-st s-${esc(st)}"><i></i>VM ${esc(qd ? 'waiting' : v.state === 'running' ? 'running' : v.state === 'starting' ? 'starting' : 'stopped')}</span>
    ${qd ? `<span class="vm-sub" title="${esc(`${qd.limit} VM${qd.limit === 1 ? '' : 's'} at a time (Settings → Copilot). Starts on its own when it's this chat's turn.`)}">${qd.position === 1 ? 'next in line' : `${qd.position - 1} ahead`} · ${qd.running} running</span>` : ''}
    ${on && up != null ? `<span class="vm-sub">up ${up < 1 ? '<1' : up} min · ${v.commands} run${v.commands === 1 ? '' : 's'}</span>` : ''}
    ${qd ? '<button class="chip" id="vm-stop" type="button" title="Leave the line: the waiting vm command stops">Leave line</button>'
      : v.state !== 'off' ? '<button class="chip" id="vm-stop" type="button" title="Stop this chat\'s VM; the next vm command starts a fresh one">Stop</button>' : ''}</div>`;
  const shares = `<div class="vm-tier"><div class="vm-lbl">Shared in</div>${v.shares.map((s) => `<div class="vm-share">${icon('folder', 12)} ${esc(s)}</div>`).join('')}</div>`;
  const ctrs = v.containers.length
    ? v.containers.map((c) => `<div class="vm-ctr c-${esc(c.state)}" title="${esc(`${c.image}\n${c.status}${c.ports ? `\n${c.ports}` : ''}`)}"><i></i><b>${esc(c.name)}</b><span>${esc(c.image)}</span>
        ${c.state === 'running' && (c.cpu || c.mem) ? `<em>${esc([c.cpu, (c.mem || '').split(' / ')[0]].filter(Boolean).join(' · '))}</em>` : `<em>${esc(c.status || c.state)}</em>`}
        ${c.ports ? `<small>${esc(c.ports.replace(/0\.0\.0\.0:|\[::\]:/g, '').split(', ').filter((x, i, a) => a.indexOf(x) === i).join(', '))}</small>` : ''}</div>`).join('')
    : `<div class="vm-empty">${on ? 'No containers yet' : qd ? 'Starts when it\'s this chat\'s turn' : 'Starts on the next vm command'}</div>`;
  const box = `<div class="vm-box"><div class="vm-box-h">${icon('source', 13)} ${v.vcpus} vCPUs · ${sys}${v.diskBytes ? ` · disk ${gb(v.diskBytes / 1048576)}` : ''}</div>
    <div class="vm-lbl">Docker</div>${ctrs}</div>`;
  // The hosts it can reach, grouped by what they're for.
  const GROUPS = [['Docker', /docker/], ['Maven', /maven|gradle|jfrog|sonatype/], ['GitHub', /github/], ['Ubuntu', /ubuntu/]];
  const groups = new Map();
  for (const h of v.network.hosts) { const g = (GROUPS.find(([, re]) => re.test(h)) || ['Other'])[0]; groups.set(g, [...(groups.get(g) || []), h]); }
  const net = `<div class="vm-tier"><div class="vm-lbl">Network · only via the sandbox's proxy</div>
    ${[...groups].map(([g, hs]) => `<div class="vm-net"><span>${esc(g)}</span><div>${hs.map((h) => `<code>${esc(h)}</code>`).join('')}</div></div>`).join('')}</div>`;
  const t = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const log = `<div class="vm-lbl">Events</div><ol class="vm-log">${v.events.map((e) => `<li class="k-${esc(e.kind)}"><time>${t(e.at)}</time><span>${esc(e.text)}</span></li>`).join('')}</ol>`;
  const old = el.querySelector('.vm-log'), atEnd = !old || old.scrollTop + old.clientHeight >= old.scrollHeight - 4;
  el.innerHTML = `<h4>VM</h4>${head}<div class="vm-map">${shares}<div class="vm-arrow"></div>${box}<div class="vm-arrow"></div>${net}</div>${log}`;
  const ol = el.querySelector('.vm-log');
  ol.scrollTop = atEnd ? ol.scrollHeight : old.scrollTop;
  const stop = $('#vm-stop');
  if (stop) stop.onclick = async () => { stop.disabled = true; await post('/api/vm/stop', { chat: id }).catch(() => {}); drawVm(); };
}
setInterval(() => { if (!$('#chat').hidden && !document.hidden && chat.turns) drawVm(); }, 3000);

// What this chat changed on GitHub and Jira (all chats: Copilot's changes in the menu).
async function drawChanges() {
  const el = $('#cp-changes'), id = chat.turns ? chat.session : null;
  let list = [];
  if (id) try { list = (await getJson(`/api/agent-log?chat=${encodeURIComponent(id)}&limit=8`)).writes; } catch {}
  if (id !== (chat.turns ? chat.session : null)) return;
  el.hidden = !list.length;
  el.innerHTML = list.length ? `<h4>Changed as you</h4>${changeRows(list, { chats: false })}<a href="#changes" class="more">All of Copilot's changes</a>` : '';
}

// Files for the next message: dropped on the chat or picked with the paperclip, uploaded at once.
async function attachFiles(list) {
  for (const file of [...list].slice(0, Math.max(0, 10 - chat.files.filter((x) => !x.pointed).length))) {
    const f = { name: file.name, size: file.size, path: null };
    if (file.size > 25 * 1024 * 1024) { $('#chat-sub').textContent = `${file.name} is over 25 MB`; continue; }
    chat.files.push(f); drawRefs();
    try {
      const r = await fetchWithToken(`/api/copilot/attach?name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file, headers: { 'Content-Type': 'application/octet-stream' } });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || r.statusText);
      f.path = d.path;
    } catch (e) { chat.files = chat.files.filter((x) => x !== f); $('#chat-sub').textContent = `Couldn't attach ${file.name}: ${e.message}`; }
    drawRefs();
  }
}
$('#cp-attach').onclick = () => $('#cp-file').click();
$('#cp-file').onchange = (e) => { attachFiles(e.target.files); e.target.value = ''; };
$('#cp-refs').addEventListener('click', (e) => { const b = e.target.closest('[data-unfile]'); if (b) { chat.files.splice(Number(b.dataset.unfile), 1); drawRefs(); } });
for (const ev of ['dragover', 'drop']) {
  $('#chat').addEventListener(ev, (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    if (ev === 'drop') attachFiles(e.dataTransfer.files);
  });
}

// What this chat made and changed: its files (yours attached, its own, what it wrote) with a
// preview, and the PRs, branches, tickets and CI runs it touched, with the usual hover cards.
const fsize = (n) => (n == null ? '' : n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} kB` : `${(n / 1048576).toFixed(1)} MB`);
const FILE_KIND = { attached: 'you attached', pointed: 'you pointed at', research: 'research', file: 'its files', wrote: 'written' };
async function drawOutputs() {
  const el = $('#cp-out'), id = chat.turns ? chat.session : null;
  let d = null;
  if (id) try { d = await getJson(`/api/copilot/outputs?chat=${encodeURIComponent(id)}`); } catch {}
  if (id !== (chat.turns ? chat.session : null)) return;
  const files = d?.files || [], links = d?.links || [];
  el.hidden = !files.length && !links.length;
  if (el.hidden) { el.innerHTML = ''; return; }
  const ref = (l) => (l.pr ? ` data-pr="${esc(l.pr)}"` : l.issue ? ` data-issue="${esc(l.issue)}"` : '');
  el.innerHTML = `${links.length ? `<ul class="outs">${links.map((l) => `<li><span class="mi">${icon({ pr: 'pr', branch: 'pr', ci: 'tool', ticket: 'ticket', project: 'ticket', env: 'source', repo: 'pr' }[l.kind] || 'tool', 13)}</span><div>${l.url ? `<a href="${esc(l.url)}" target="_blank" rel="noopener"${ref(l)}>${esc(l.label)}</a>` : `<b>${esc(l.label)}</b>`}${l.acts?.length ? `<small>${esc(l.acts.join(' · '))}</small>` : ''}</div></li>`).join('')}</ul>` : ''}
    ${files.length ? `<ul class="outs files">${files.slice(0, 30).map((f) => `<li class="${f.exists ? '' : 'gone'}"><span class="mi">${icon('clip', 13)}</span><div>${f.exists ? `<button type="button" class="linkish" data-fview="${esc(f.path)}" title="${esc(f.shown)}">${esc(f.name)}</button>` : `<s title="${esc(f.shown)}">${esc(f.name)}</s>`}<small>${esc([FILE_KIND[f.kind] || f.kind, fsize(f.size), f.at && ago(f.at), !f.exists && 'gone'].filter(Boolean).join(' · '))}</small></div></li>`).join('')}</ul>` : ''}`;
}
// A file in a box over the page: code highlighted with line numbers, what the chat changed in
// it as a diff (against where its branch left the default branch), images shown, and the rest
// opened in a new tab. VS Code opens the file itself.
const HL_KW = new Set(('abstract as assert async await break case catch class const continue def default defer delete do elif else enum export extends ' +
  'final finally fn for from func function go if impl implements import in instanceof interface is let match module mut namespace new nil none not null ' +
  'of or override package pass private protected pub public raise readonly record return sealed select self static struct super switch synchronized ' +
  'this throw throws trait true false try type typeof use val var void when where while with yield None True False').split(' '));
function hlLang(name) {
  const ext = (name.match(/\.(\w+)$/)?.[1] || name).toLowerCase();
  if (/^(sh|bash|zsh|py|rb|ya?ml|toml|properties|conf|cfg|env|ini|dockerfile|makefile|tf|hcl|gitignore)$/.test(ext)) return { line: '#' };
  if (/^(sql)$/.test(ext)) return { line: '--', block: true };
  if (/^(html?|xml|vue|svelte|md|markdown|csv|tsv|txt|log)$/.test(ext)) return null;
  return { line: '//', block: true };
}
// Comments, strings, numbers and keywords: enough to read code, small enough to live here.
function highlight(text, name) {
  const lang = hlLang(name);
  if (!lang) return esc(text);
  const lc = lang.line.replace(/[/#-]/g, (c) => `\\${c}`);
  const re = new RegExp(`(${lang.block ? '\\/\\*[\\s\\S]*?\\*\\/|' : ''}${lc}[^\\n]*)|("(?:[^"\\\\\\n]|\\\\.)*"|'(?:[^'\\\\\\n]|\\\\.)*'|\`(?:[^\`\\\\]|\\\\.)*\`)|\\b(\\d[\\d_.xXa-fA-FlLuU]*)\\b|(@?[A-Za-z_$][\\w$]*)`, 'g');
  let out = '', last = 0, m;
  while ((m = re.exec(text))) {
    out += esc(text.slice(last, m.index));
    const [w, com, str, num, id] = m;
    out += com ? `<span class="hl-c">${esc(com)}</span>` : str ? `<span class="hl-s">${esc(str)}</span>` : num ? `<span class="hl-n">${esc(num)}</span>`
      : id && id[0] === '@' ? `<span class="hl-a">${esc(id)}</span>` : id && HL_KW.has(id) ? `<span class="hl-k">${esc(id)}</span>`
      : id && /^[A-Z][a-z]/.test(id) ? `<span class="hl-t">${esc(id)}</span>` : esc(w);
    last = re.lastIndex;
  }
  return out + esc(text.slice(last));
}
// Highlighted HTML split into lines, keeping spans that run over a line end (a block comment) open.
function hlLines(html) {
  const out = [];
  let open = [];
  for (const line of html.split('\n')) {
    let l = open.join('') + line;
    for (const t of line.match(/<\/?span[^>]*>/g) || []) { if (t.startsWith('</')) open.pop(); else open.push(t); }
    out.push(l + '</span>'.repeat(open.length));
  }
  return out;
}
const codeView = (text, name) => `<div class="code">${hlLines(highlight(text, name)).map((l, i) => `<div class="ln"><i>${i + 1}</i><span>${l || ' '}</span></div>`).join('')}</div>`;
function diffView(diff, name) {
  const rows = [];
  let a = 0, b = 0;
  for (const line of diff.split('\n')) {
    const h = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (h) { a = Number(h[1]); b = Number(h[2]); rows.push(`<div class="ln hunk"><i></i><i></i><span>${esc(h[3].trim() || '⋯')}</span></div>`); continue; }
    if (!rows.length || /^\\ No newline/.test(line)) continue; // the header lines, and git's note
    const k = line[0], body = line.slice(1);
    const hl = hlLines(highlight(body, name))[0] || ' ';
    if (k === '+') rows.push(`<div class="ln add"><i></i><i>${b++}</i><span>${hl}</span></div>`);
    else if (k === '-') rows.push(`<div class="ln del"><i>${a++}</i><i></i><span>${hl}</span></div>`);
    else rows.push(`<div class="ln"><i>${a++}</i><i>${b++}</i><span>${hl}</span></div>`);
  }
  return `<div class="code diff">${rows.join('')}</div>`;
}
// vscode://file/… opens the file in VS Code wherever it's installed (Windows paths too).
const vscodeUrl = (p) => `vscode://file${p.startsWith('/') ? '' : '/'}${encodeURI(p.replace(/\\/g, '/'))}`;
let fvState = null;
function drawFview(tab) {
  const s = fvState, body = $('#fv-body');
  if (!s) return;
  s.tab = tab;
  document.querySelectorAll('[data-fv-tab]').forEach((b) => b.classList.toggle('on', b.dataset.fvTab === tab));
  if (tab === 'diff') body.innerHTML = diffView(s.diff, s.name);
  else body.innerHTML = s.text.length > 300_000 ? `${codeView(s.text.slice(0, 300_000), s.name)}<p class="muted">… cut here; open it in VS Code for the rest.</p>` : codeView(s.text, s.name);
}
document.addEventListener('click', (e) => { const t = e.target.closest('[data-fv-tab]'); if (t) drawFview(t.dataset.fvTab); });
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-fview]');
  if (!b) return;
  const pth = b.dataset.fview, src = `/api/copilot/file?chat=${encodeURIComponent(chat.session)}&path=${encodeURIComponent(pth)}`;
  const name = pth.split('/').pop();
  if (/\.pdf$/i.test(name)) { window.open(src, '_blank', 'noopener'); return; }
  fvState = null;
  $('#fv-name').textContent = name; $('#fv-name').title = pth; $('#fv-open').href = src; $('#fv-code').href = vscodeUrl(pth);
  $('#fv-tabs').hidden = true; $('#fview').hidden = false;
  const body = $('#fv-body');
  if (/\.(png|jpe?g|gif|webp)$/i.test(name)) { body.innerHTML = `<img alt="${esc(name)}" src="${esc(src)}">`; return; }
  body.innerHTML = '<span class="typing">Loading</span>';
  try {
    const [r, d] = await Promise.all([fetch(src), getJson(`${src}&diff=1`).catch(() => ({ diff: '' }))]);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
    if (!/^text\/plain/.test(r.headers.get('content-type') || '')) { body.innerHTML = `<p>No preview for this kind of file. <a href="${esc(vscodeUrl(pth))}">Open it in VS Code</a> or <a href="${esc(src)}">download it</a>.</p>`; return; }
    fvState = { name, text: await r.text(), diff: d.diff || '' };
    $('#fv-tabs').hidden = !fvState.diff;
    drawFview(fvState.diff ? 'diff' : 'file');
  } catch (err) { body.innerHTML = `<div class="err">${esc(err.message)}</div>`; }
});
const closeFview = () => { $('#fview').hidden = true; $('#fv-body').innerHTML = ''; fvState = null; };
$('#fv-close').onclick = closeFview;
$('#fview').addEventListener('click', (e) => { if (e.target.id === 'fview') closeFview(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#fview').hidden) closeFview(); });

// This chat's map: the repos and tickets it works on and what it did to each.
async function drawMap() {
  const el = $('#cp-map'), id = chat.turns ? chat.session : null;
  let d = null;
  if (id) try { d = await getJson(`/api/copilot/map?chat=${encodeURIComponent(id)}`); } catch {}
  if (id !== (chat.turns ? chat.session : null)) return;
  const ch = d?.chats?.find((x) => x.id === id);
  el.hidden = !ch?.nodes.length;
  el.innerHTML = ch?.nodes.length ? `<h4>Map</h4>${mapChat(ch, d.jira, { head: false })}<a href="#map" class="more">All chats' maps</a>` : '';
}

function chatSub() {
  drawCtx();
  drawInfo();
  drawVm();
  drawChanges();
  drawMap();
  drawOutputs();
  if (!$('#chat-title input')) $('#chat-title').textContent = chat.title || (chat.turns ? 'Copilot session' : 'New chat');
  const i = chat.info;
  // The header keeps to the title; mode and turns are in the composer and under This chat.
  $('#chat-sub').textContent = i && !i.available ? 'Copilot CLI not found' : '';
  const hint = i?.permissionHints?.[$('#cp-perm').value];
  $('#cp-perm').title = hint ? `What Copilot may do without asking: ${hint}` : 'What Copilot may do without asking';
}

const jiraBaseGuess = () => standupData?.jiraBase || (state.jira?.assigned?.[0]?.url || '').replace(/\/browse\/.*$/, '') || '';

// Just enough Markdown for chat answers: code blocks, inline code, bold, and links for
// URLs, Jira keys and PRs (which get hover cards). A ```choices block is a question with
// buttons (Copilot is asked to use one when you should pick: see CHOICES_HINT on the server).
function md(text) {
  // Fenced blocks: an opening ```lang line, then everything up to a closing ``` line. One still
  // open (Copilot is mid-answer) shows as code so far.
  const re = /^```([\w-]*)[ \t]*\n([\s\S]*?)^```[ \t]*$/gm;
  const block = (lang, body) => (lang === 'choices' ? choicesCard(body) : lang === 'remember' ? rememberCard(body) : `<div class="cblock"><button type="button" class="b-copy" data-copy-block title="Copy" aria-label="Copy">${icon('copy', 13)}</button><pre><code>${esc(body.replace(/\n$/, ''))}</code></pre></div>`);
  let out = '', last = 0, m;
  while ((m = re.exec(text))) { out += mdText(text.slice(last, m.index), last > 0); out += block(m[1], m[2]); last = re.lastIndex; }
  const rest = text.slice(last), open = rest.match(/^```([\w-]*)[ \t]*\n/m);
  if (!open) return out + mdText(rest, last > 0);
  return out + mdText(rest.slice(0, open.index), last > 0) + (open[1] === 'choices' || open[1] === 'remember' ? '' : block('', rest.slice(open.index + open[0].length)));
}
function mdText(part, afterBlock) {
  // "> " lines (a draft comment, a quote from a thread) as one quote, with a Copy button that
  // copies the quote's own Markdown: code, backticks and all, ready to paste where it's posted.
  // A quote's body is Markdown of its own, so a ``` block inside it shows as code.
  const quotes = [];
  let t = (afterBlock ? part.replace(/^\n/, '') : part).replace(/\n?((?:^> ?.*(?:\n|$))+)\n?/gm, (m, q) => {
    const raw = q.replace(/\n$/, '').split('\n').map((l) => l.replace(/^> ?/, '')).join('\n').trim();
    quotes.push(`<blockquote class="quote"><button type="button" class="q-copy b-copy" data-copy-quote title="Copy" aria-label="Copy">${icon('copy', 13)}</button><div class="q-body" data-raw="${esc(raw)}">${md(raw)}</div></blockquote>`);
    return `\n\u0000${quotes.length - 1}\u0000\n`;
  });
  let h = mdBlocks(t);
  h = h.replace(/\u0000(\d+)\u0000/g, (m, i) => quotes[i]);
  return h ? `<div class="txt md rich">${h}</div>` : '';
}
// Inline Markdown: `code`, **bold**, *italic*, ~~strike~~, [text](url), bare URLs, and PR and
// Jira references (hover cards). Code and links are held aside first so nothing inside them is
// formatted; everything else is escaped by linkify.
function mdInline(text) {
  const keep = [];
  const hold = (html) => `\u0001${keep.push(html) - 1}\u0001`;
  let t = text.replace(/`([^`\n]+)`/g, (m, c) => hold(`<code>${esc(c)}</code>`));
  t = t.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (m, label, url) => hold(`<a href="${esc(url)}" target="_blank" rel="noopener">${linkify(label, jiraBaseGuess())}</a>`));
  t = t.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (m, pre, url) => pre + hold(`<a href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a>`));
  // Emphasis as markers before escaping, so the tags linkify writes are never touched.
  t = t.replace(/\*\*([^*\n]+)\*\*/g, '\u0002b$1\u0003b').replace(/__([^_\n]+)__/g, '\u0002b$1\u0003b')
    .replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)\*(?!\w)/g, '$1\u0002i$2\u0003i').replace(/(^|[^\w])_(?!\s)([^_\n]+?)_(?!\w)/g, '$1\u0002i$2\u0003i')
    .replace(/~~([^~\n]+)~~/g, '\u0002s$1\u0003s');
  const h = linkify(t, jiraBaseGuess()).replace(/\u0002([bis])/g, '<$1>').replace(/\u0003([bis])/g, '</$1>');
  return h.replace(/\u0001(\d+)\u0001/g, (m, i) => keep[i]);
}
// Block Markdown: headings, lists (nested by indent), tables, rules and paragraphs. A line that
// is only a held quote (\u0000n\u0000) passes through.
function mdBlocks(text) {
  const lines = text.split('\n');
  const out = [];
  let para = [];
  const flush = () => { if (para.length) { out.push(`<p>${para.map(mdInline).join('<br>')}</p>`); para = []; } };
  const cells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\u0000\d+\u0000$/.test(line.trim())) { flush(); out.push(line.trim()); continue; }
    if (!line.trim()) { flush(); continue; }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { flush(); const l = Math.min(6, h[1].length + 2); out.push(`<h${l}>${mdInline(h[2])}</h${l}>`); continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); out.push('<hr>'); continue; }
    // A table: a | row, then a |---| line.
    if (line.includes('|') && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(lines[i + 1] || '')) {
      flush();
      const head = cells(line);
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
      i--;
      out.push(`<div class="tbl cblock"><button type="button" class="b-copy" data-copy-block title="Copy" aria-label="Copy">${icon('copy', 13)}</button><table><tr>${head.map((c) => `<th>${mdInline(c)}</th>`).join('')}</tr>${rows.map((r) => `<tr>${r.map((c) => `<td>${mdInline(c)}</td>`).join('')}</tr>`).join('')}</table></div>`);
      continue;
    }
    // A list: items at an indent; deeper ones nest, and wrapped lines join their item.
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      flush();
      const stack = []; // { indent, tag }
      let html = '';
      for (; i < lines.length; i++) {
        const m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
        if (!m) {
          if (lines[i].trim() && /^\s+\S/.test(lines[i]) && stack.length) { html += ` ${mdInline(lines[i].trim())}`; continue; }
          break;
        }
        const indent = m[1].replace(/\t/g, '  ').length, tag = /\d/.test(m[2]) ? 'ol' : 'ul';
        while (stack.length && indent < stack.at(-1).indent) html += `</li></${stack.pop().tag}>`;
        const top = stack.at(-1);
        if (!top || indent > top.indent) { html += `<${tag}${tag === 'ol' && parseInt(m[2], 10) > 1 ? ` start="${parseInt(m[2], 10)}"` : ''}><li>`; stack.push({ indent, tag }); }
        else if (top.tag !== tag) { html += `</li></${stack.pop().tag}><${tag}><li>`; stack.push({ indent, tag }); }
        else html += '</li><li>';
        html += mdInline(m[3].replace(/^\[([ xX])\]\s+/, (x, c) => (c === ' ' ? '☐ ' : '☑ ')));
      }
      while (stack.length) html += `</li></${stack.pop().tag}>`;
      i--;
      out.push(html);
      continue;
    }
    para.push(line);
  }
  flush();
  return out.join('');
}
// "Question\n- Option | what happens\n- Option (recommended) | …"
function choicesCard(body) {
  const lines = body.split('\n').map((l) => l.trim()).filter(Boolean);
  const q = lines.filter((l) => !/^[-*]\s/.test(l)).join(' ');
  const opts = lines.filter((l) => /^[-*]\s/.test(l)).map((l) => {
    const [label, ...why] = l.replace(/^[-*]\s+/, '').split(/\s+\|\s+/);
    const rec = /\(recommended\)/i.test(label);
    return { label: label.replace(/\s*\(recommended\)/i, '').trim(), why: why.join(' | '), rec };
  });
  return `<div class="choices">${q ? `<div class="choices-q">${esc(q)}</div>` : ''}${opts.map((o) => `<button class="choice${o.rec ? ' rec' : ''}" data-choice="${esc(o.label)}">
    <b>${esc(o.label)}${o.rec ? ' <i>recommended</i>' : ''}</b>${o.why ? `<span>${esc(o.why)}</span>` : ''}</button>`).join('')}</div>`;
}

// Copilot's long-term memory (lib/memory.mjs). A ```remember block is a note it suggests:
// "repo: owner/name" (optional), then one note per line. Saved only when you press Save.
let memoryText = '';
const loadMemory = () => getJson('/api/copilot/memory').then((m) => { memoryText = m.text || ''; }).catch(() => {});
loadMemory();
const MEM_SKIP_KEY = 'clearsky.copilot.memorySkipped';
const memSkipped = () => { try { return JSON.parse(localStorage.getItem(MEM_SKIP_KEY) || '[]'); } catch { return []; } };
const noteText = (l) => l.replace(/\s+/g, ' ').trim().replace(/^[-*]\s+/, '');
function parseRemember(body) {
  let repo = null;
  const lines = [];
  for (const raw of body.split('\n')) {
    const m = raw.match(/^\s*repo:\s*(\S+)\s*$/i);
    if (m && !lines.length && !repo) { repo = /^[\w.-]+\/[\w.-]+$/.test(m[1]) ? m[1] : null; continue; }
    const l = noteText(raw);
    if (l) lines.push(l);
  }
  return { repo, lines: lines.slice(0, 10) };
}
const memHas = (l) => memoryText.split('\n').some((x) => noteText(x) === l);
const memKey = ({ repo, lines }) => `${repo || ''}|${lines.join('\n')}`;
function rememberCard(body) {
  const note = parseRemember(body);
  if (!note.lines.length) return '';
  const marks = memSkipped(); // what you did with a card: its key when skipped, "saved:" and its key when saved as edited
  const state = note.lines.every(memHas) || marks.includes(`saved:${memKey(note)}`) ? 'Saved to memory' : marks.includes(memKey(note)) ? 'Skipped' : '';
  return `<div class="remember" data-remember-body="${esc(body)}"><div class="remember-t">${icon('bookmark', 13)} Remember${note.repo ? ` for ${esc(note.repo)}` : ' in every chat'}?</div>
    <ul>${note.lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
    <div class="remember-b">${state ? `<span class="remember-done">${esc(state)}</span>`
      : '<button type="button" class="r-save" data-remember="save">Save</button><button type="button" data-remember="edit">Edit</button><button type="button" data-remember="skip">Skip</button>'}</div></div>`;
}
async function rememberClick(b) {
  const card = b.closest('.remember'), body = card.dataset.rememberBody, note = parseRemember(body);
  const done = (t) => { card.querySelector('.remember-b').innerHTML = `<span class="remember-done">${esc(t)}</span>`; };
  const act = b.dataset.remember;
  const mark = (k) => { try { localStorage.setItem(MEM_SKIP_KEY, JSON.stringify([...memSkipped(), k].slice(-200))); } catch {} };
  if (act === 'skip') { mark(memKey(note)); return done('Skipped'); }
  if (act === 'edit') {
    card.querySelector('ul').outerHTML = `<textarea class="remember-edit" rows="${Math.min(8, note.lines.length + 1)}" aria-label="Notes to remember, one per line">${esc(note.lines.join('\n'))}</textarea>`;
    card.querySelector('.remember-b').innerHTML = '<button type="button" class="r-save" data-remember="save">Save</button><button type="button" data-remember="cancel">Cancel</button>';
    card.querySelector('textarea').focus();
    return;
  }
  if (act === 'cancel') { card.outerHTML = rememberCard(body); return; }
  const edited = card.querySelector('textarea');
  const lines = edited ? edited.value.split('\n').map(noteText).filter(Boolean) : note.lines;
  if (!lines.length) return done('Skipped');
  card.querySelectorAll('button').forEach((x) => { x.disabled = true; });
  try {
    const r = await post('/api/copilot/memory', { lines, repo: note.repo });
    memoryText = r.text ?? memoryText;
    if (edited) { mark(`saved:${memKey(note)}`); edited.outerHTML = `<ul>${lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`; }
    card.querySelector('.remember-err')?.remove();
    done(r.added ? 'Saved to memory' : 'Already in memory');
  } catch (err) {
    card.querySelectorAll('button').forEach((x) => { x.disabled = false; });
    let m = card.querySelector('.remember-err');
    if (!m) { m = document.createElement('div'); m.className = 'remember-err'; card.append(m); }
    m.textContent = err.message;
  }
}

document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-copy-quote]');
  if (!b) return;
  let ok = true;
  try { await navigator.clipboard.writeText(b.parentElement.querySelector('.q-body').dataset.raw); } catch { ok = false; }
  b.innerHTML = icon(ok ? 'check' : 'copy', 13); b.title = ok ? 'Copied' : 'Select and copy';
  setTimeout(() => { b.innerHTML = icon('copy', 13); b.title = 'Copy'; }, 1500);
});

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
// `chat.view` counts what's on screen: a turn or a session being opened checks it's still the
// one shown before it touches the panel, so a chat you left can't pull you back to it.
function detach() {
  chat.view = (chat.view || 0) + 1;
  chat.stop?.();
  chat.stop = chat.halt = null;
  chat.queued = [];
  sendLabel();
}

function newChat() {
  detach();
  cpWide(false);
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
  $('#cp-perm').innerHTML = Object.entries(i.permissions || {}).map(([k, l]) => `<option value="${k}" title="${esc(i.permissionHints?.[k] || '')}">${esc(l)}</option>`).join('');
  pickDefaults();
  $('#cp-skills').innerHTML = (i.skills || []).map((sk) =>
    `<button class="chip" data-skill="${esc(sk.name)}" title="${esc(sk.description)}">${esc(sk.name)}</button>`).join('');
  if (!i.available) addMsg('cp', `<div class="err">${esc(i.error || 'The GitHub Copilot CLI wasn’t found on this machine. Install it, or set COPILOT_BIN in ~/.config/clearsky/.env.')}</div>`);
  chatSub();
}

// A tool step: its first event says when it started, a finished one when it ended.
function toolEvent(segs, e) {
  const t = segs.find((g) => g.type === 'tool' && g.id === e.id);
  if (!t) { segs.push({ ...e, start: e.at }); return; }
  Object.assign(t, Object.fromEntries(Object.entries(e).filter(([, v]) => v != null)));
  if (['completed', 'failed'].includes(e.status)) t.end ||= e.at;
}
// When each line happened (local time), and how long a step took.
const clock = (ms) => (ms ? new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '');
const took = (a, b) => { const s = Math.round((b - a) / 1000); return s < 1 ? '' : s < 90 ? `${s}s` : `${Math.round(s / 60)} min`; };
const stamp = (ms) => (ms ? `<time class="at" datetime="${new Date(ms).toISOString()}">${clock(ms)}</time>` : '');
const sinceNow = (ms) => { const s = Math.max(0, Math.round((Date.now() - ms) / 1000)); return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)} min ago` : `${Math.floor(s / 3600)} h ago`; };
// "Last activity …" under a running answer keeps counting.
setInterval(() => { for (const el of document.querySelectorAll('.idle[data-at]')) el.querySelector('b').textContent = sinceNow(Number(el.dataset.at)); }, 5000);

const RESUME_WARN = /Warning: (\d+) tool call\(s\) had no recorded result at resume/;
const RESUME_WARN_ALL = /Warning: \d+ tool call\(s\) had no recorded result at resume\.(?:[^\n]*?Verify the current state before continuing\.)?/;

// One answer is a list of segments: text, tool steps and approval questions, in order.
function renderAnswer(segs, running = false) {
  // Stopped on an error or a failed step: a nudge sends "Try again" (shown on the last answer only).
  const end = segs.at(-1);
  const stuck = end && (end.type === 'error' || (end.type === 'tool' && end.status === 'failed'));
  // A chat picked up again after a restart: Copilot marks the steps that were running then as
  // failed and warns. That's routine (it checks and reruns them), so it reads as a note.
  const resumed = segs.some((g) => g.type === 'text' && RESUME_WARN.test(g.text));
  return segs.map((g) => {
    if (g.type === 'text' && RESUME_WARN.test(g.text)) {
      const n = Number(g.text.match(RESUME_WARN)[1]) || 1;
      return `<div class="tool s-resumed"><span>${icon('refresh', 13)}</span>Picked up after an interruption: ${n === 1 ? 'a step that was running didn’t finish' : `${n} steps that were running didn’t finish`}, so Copilot checks and runs ${n === 1 ? 'it' : 'them'} again.</div>${md(g.text.replace(RESUME_WARN_ALL, '').trim())}`;
    }
    if (g.type === 'text') return md(g.text);
    if (g.type === 'tool' && resumed && g.status === 'failed' && (!g.title || g.title === 'Tool')) return '';
    if (g.type === 'tool') {
      // A finished step is a quiet check; only failed, stopped or running ones say so in words.
      const done = g.status === 'completed';
      const said = [done ? '' : (g.status || '').replace('_', ' '), g.end && g.start ? took(g.start, g.end) : ''].filter(Boolean).join(' · ');
      return `<div class="tool s-${esc(g.status || 'pending')}">${stamp(g.start || g.at)}<span>${icon('tool', 13)}</span>${esc(g.title || 'Tool')}<i>${done ? '<b>✓</b>' : ''}${esc(said)}</i></div>`;
    }
    if (g.type === 'permission') {
      return `<div class="perm"><div class="perm-t">${stamp(g.at)}${esc(g.title)}</div>${g.detail ? `<code>${esc(g.detail)}</code>` : ''}
        ${g.advice ? `<div class="perm-a a-${g.advice.level === 'fine' ? 'fine' : 'check'}" title="Clearsky's advice, from GitHub's and Jira's facts (not from PR or ticket text). You decide.">${esc(g.advice.text)}</div>` : ''}
        <div class="perm-b">${g.answered ? `<span class="perm-done">${esc(g.answered)}</span>`
          : g.options.map((o) => `<button class="${/^allow/.test(o.kind) ? 'ok' : 'no'}" data-perm="${esc(g.id)}" data-option="${esc(o.id)}" data-name="${esc(o.name)}">${esc(o.name)}</button>`).join('')}</div></div>`;
    }
    if (g.type === 'error') return `<div class="err">${stamp(g.at)}${esc(g.message)}</div>`;
    if (g.type === 'note') return `<div class="tool">${stamp(g.at)}<span>${icon('folder', 13)}</span>${esc(g.text)}</div>`;
    return '';
  }).join('')
    // The whole answer, as Markdown (or as formatted text where the paste takes it).
    + (!running && segs.some((g) => g.type === 'text' && g.text.trim()) ? `<button type="button" class="b-copy ans" data-copy-answer title="Copy the answer" aria-label="Copy the answer">${icon('copy', 13)}</button>` : '')
    + (running && segs.moved ? `<div class="idle" data-at="${segs.moved}">Last activity ${clock(segs.moved)} · <b>${sinceNow(segs.moved)}</b></div>` : '') + (stuck ? `<button class="nudge" data-nudge title="Send Copilot “Try again.”">${icon('refresh', 13)} Nudge</button>` : '');
}

// Reopen a Copilot session (from here, the terminal or an editor) with its conversation so far.
// A folder with the home folder as ~ (Linux, macOS and Windows alike).
function tilde(dir = '') {
  const home = chat.home || (dir.match(/^(\/home\/[^/]+|\/Users\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)/) || [])[1];
  return home && (dir === home || dir.startsWith(home + '/') || dir.startsWith(home + '\\')) ? `~${dir.slice(home.length)}` : dir;
}
async function openSession(id, cwd) {
  detach();
  cpWide(false);
  const view = chat.view;
  chat.session = id; chat.turns = 1; // the list shows it as picked while it loads
  // Nothing of the chat you were on carries over while this one loads (a real session can
  // take seconds): its own name if we know it, and an empty side pane.
  chat.title = recentChats.find((r) => r.id === id)?.title || (cpLinks.live || []).find((x) => x.id === id)?.title || null;
  chat.items = []; chat.cwd = cwd || null;
  chatSub();
  showHistory(false);
  $('#chat-log').innerHTML = '<span class="typing">Opening session</span>';
  try {
    const q = cwd ? `?cwd=${encodeURIComponent(cwd)}` : '';
    const h = await getJson(`/api/copilot/sessions/${encodeURIComponent(id)}${q}`);
    if (chat.view !== view) return; // you picked another chat meanwhile
    chat.session = h.id; chat.cwd = h.cwd; chat.home = h.home; chat.turns = h.messages.filter((m) => m.role === 'me').length || 1;
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
    if (chat.view !== view) return;
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
      <small>${x.updatedAt ? esc(ago(x.updatedAt)) : ''}${x.cwd ? ` · ${esc(folder(x.cwd))}` : ''}${x.limit ? ` · <span class="${x.context / x.limit >= TRIM.compact ? 'full' : ''}" title="How full its context is: ${Math.round(x.context / 1000)}k of ${Math.round(x.limit / 1000)}k tokens">${Math.round(100 * x.context / x.limit)}% full</span>` : ''}</small>${x.working ? '<span class="hbadge work">working</span>' : x.open ? '<span class="hbadge" title="Open in a terminal or editor">open</span>' : ''}${x.here ? '<span class="hbadge">live here</span>' : ''}
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
// Also take a typed reference: ABC-1234, org/repo#12, or a PR or Jira link.
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
  for (const [i, f] of chat.files.entries()) {
    const el = document.createElement('span');
    el.className = 'ref file';
    el.innerHTML = `<span title="${esc(f.pointed ? `${f.shown}: Copilot gets the path and reads it itself` : f.path || 'uploading')}">${f.pointed ? '@' : icon('clip', 12)} ${esc(f.name)}${f.dir ? '/' : ''}${f.path ? '' : ' …'}</span><button type="button" data-unfile="${i}" aria-label="Remove">✕</button>`;
    $('#cp-refs').append(el);
  }
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
// A file or folder on disk for the next message: Copilot gets the path, not the contents.
function addFileRef(f) {
  if (chat.files.some((x) => x.path === f.path) || chat.files.length >= 20) return;
  chat.files.push({ name: f.name, path: f.path, shown: f.shown, dir: f.dir, pointed: true });
  drawRefs();
}
function closeRefPick() { $('#cp-refs .ref-pick:not(.slash)')?.remove(); }
function openRefPick() {
  if ($('#cp-refs .ref-pick:not(.slash)')) return closeRefPick();
  const box = document.createElement('div');
  box.className = 'ref-pick';
  box.innerHTML = '<input placeholder="Find a PR, ticket or file, or paste ABC-1234 / a link / a path" spellcheck="false"><ul></ul>';
  $('#cp-refs').append(box);
  const input = box.querySelector('input'), ul = box.querySelector('ul');
  const all = refCandidates();
  let shown = [], on = 0, files = [], asked = '';
  const pathy = (q) => /^(~|\/|\.\.?\/)/.test(q);
  const draw = () => {
    const q = input.value.trim().toLowerCase();
    shown = pathy(q) ? [] : all.filter((r) => !q || `${refLabel(r)} ${r.repo || ''} ${r.title || ''}`.toLowerCase().includes(q)).slice(0, 40);
    const typed = parseRef(input.value);
    if (typed && !shown.some((r) => refLabel(r) === refLabel(typed))) shown.unshift({ ...typed, title: '', where: 'add' });
    // Files after the PRs and tickets: a path you typed lists that folder, a word finds names.
    shown = [...shown, ...files.map((f) => ({ file: f }))];
    on = Math.min(on, Math.max(shown.length - 1, 0));
    ul.innerHTML = shown.map((r, i) => (r.file
      ? `<li data-i="${i}" class="${i === on ? 'on' : ''}"><code>${r.file.dir ? '▸' : '@'}</code>${esc(r.file.name)}${r.file.dir ? '/' : ''}<small title="${esc(r.file.shown)}">${esc(r.file.shown.replace(/\/[^/]*$/, '') || '/')}</small></li>`
      : `<li data-i="${i}" class="${i === on ? 'on' : ''}"><code>${esc(refLabel(r))}</code>${esc(r.title || '')}<small>${esc(r.where || '')}</small></li>`)).join('')
      || `<li class="none">${q.length < 2 ? 'Type a few letters of a PR, ticket or file name, or a path like ~/dev/' : 'Nothing matches. Type a key like ABC-1234, org/repo#12 or a path.'}</li>`;
  };
  let timer = null;
  const lookFiles = () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2 && !pathy(q)) { files = []; asked = ''; return draw(); }
    timer = setTimeout(async () => {
      asked = q;
      let found = [];
      try { found = (await getJson(`/api/copilot/files?q=${encodeURIComponent(q)}&chat=${encodeURIComponent(chat.session || '')}&cwd=${encodeURIComponent(chat.cwd || '')}`)).files || []; } catch {}
      if (asked !== input.value.trim() || !box.isConnected) return;
      files = found; draw();
    }, 150);
  };
  const pick = (i, keepOpen) => {
    const r = shown[i]; if (!r) return;
    if (r.file) {
      // A folder picked with Tab opens it in the picker, to go further down.
      if (r.file.dir && keepOpen) { input.value = `${r.file.shown}/`; on = 0; lookFiles(); return; }
      addFileRef(r.file);
    } else addRef({ ...r });
    closeRefPick(); $('#chat-text').focus();
  };
  input.addEventListener('input', () => { on = 0; draw(); lookFiles(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { on = Math.min(on + 1, shown.length - 1); draw(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { on = Math.max(on - 1, 0); draw(); e.preventDefault(); }
    else if (e.key === 'Enter') { pick(on); e.preventDefault(); }
    else if (e.key === 'Tab' && shown[on]?.file?.dir) { pick(on, true); e.preventDefault(); }
    else if (e.key === 'Escape') { closeRefPick(); e.stopPropagation(); }
  });
  ul.addEventListener('mousedown', (e) => { const li = e.target.closest('[data-i]'); if (li) { e.preventDefault(); pick(+li.dataset.i); } });
  draw();
  input.focus();
}

async function send(text) {
  if (!text.trim() || chat.stop) return;
  if (chat.files.some((f) => !f.path)) { $('#chat-sub').textContent = 'Still uploading your files…'; return; }
  const refs = chat.refs.map(({ kind, key, repo, number }) => ({ kind, key, repo, number }));
  const attachments = chat.files.filter((f) => !f.pointed).map((f) => f.path);
  const files = chat.files.filter((f) => f.pointed).map((f) => f.path);
  const sentFiles = chat.files.map((f) => f.name);
  addMsg('me', `${refs.length ? `<span class="refs-sent">${icon('clip', 13)} ${chat.refs.map((r) => esc(refLabel(r))).join(', ')}</span>` : ''}${sentFiles.length ? `<span class="refs-sent">${icon('clip', 13)} ${sentFiles.map(esc).join(', ')}</span>` : ''}${esc(text)}`);
  chat.refs = [];
  chat.files = [];
  chat.items = [...new Set([...chat.items, ...refs.map(refKeyOf)])];
  if (!chat.turns && !chat.title) chat.title = text.trim().split('\n')[0].slice(0, 120);
  drawRefs();
  const out = addMsg('cp', '<span class="typing">Thinking</span>');
  const segs = [];
  out.segs = segs;
  const draw = () => { out.innerHTML = renderAnswer(segs, !ended) || '<span class="typing">Thinking</span>'; $('#chat-log').scrollTop = $('#chat-log').scrollHeight; drawCtx(); };
  const apply = (e) => {
    const last = segs.at(-1);
    e.at ||= Date.now(); segs.moved = e.at;
    if (e.type === 'text') { if (last?.type === 'text') last.text += e.text; else segs.push({ type: 'text', text: e.text, at: e.at }); }
    else if (e.type === 'tool') toolEvent(segs, e);
    else if (e.type === 'permission' || e.type === 'error') segs.push(e);
    // Answered in another chat (a GitHub change asks in every sandboxed chat that's working).
    else if (e.type === 'permission-done') { const g = segs.find((x) => x.type === 'permission' && x.id === e.id); if (g && !g.answered) g.answered = 'Answered'; }
    else if (e.type === 'session') { if (here()) { chat.session = e.id; rememberChat(); } rememberMode(e.id, mine.mode); mine.id = e.id; remember(e.id, chat.cwd, mine.title); drawTabs(); }
    else if (e.type === 'commands' && chat.info) chat.info.commands = e.commands;
    // A new chat about a PR or ticket is named after it, not after the skill or first words.
    else if (e.type === 'title') { mine.title = e.title; if (here()) { chat.title = e.title; drawCtx(); } }
    else if (e.type === 'cwd') { if (here()) { chat.cwd = e.cwd; drawCtx(); } segs.push({ type: 'note', text: `Working in ${e.cwd}`, at: e.at }); }
    else if (e.type === 'note') { segs.push({ type: 'note', text: e.text, at: e.at }); if (/^(GitHub|Jira):/.test(e.text)) setTimeout(drawChanges, 300); }
    if (e.type === 'done' || e.type === 'error') { ended = true; setTimeout(drawOutputs, 500); }
  };
  let ended = false;
  const ctrl = new AbortController();
  // This turn's chat; a new one gets Copilot's own id once it starts.
  const mine = { id: chat.session, title: chat.turns ? null : text.trim().split('\n')[0].slice(0, 120), mode: pickerMode() };
  rememberMode(chat.session, mine.mode);
  const view = chat.view;
  const here = () => chat.session === mine.id && chat.view === view;
  let halted = false;
  chat.stop = () => ctrl.abort(); // stop watching (switching chats); the turn goes on
  chat.halt = () => { halted = true; haltTurn(mine.id); };
  sendLabel();
  drawCtx();
  try {
    const res = await fetchWithToken('/api/copilot', { method: 'POST', signal: ctrl.signal,
      body: JSON.stringify({ message: skillPrompt(text), attachments, files, session: chat.session, resume: chat.turns > 0, cwd: chat.cwd, refs, model: cpPrefs.model, effort: cpPrefs.effort, permission: $('#cp-perm').value }) });
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
    ended = true; // however it ended: no "last activity" line on it any more
    // Steps still open when a turn is stopped didn't finish: say so instead of "pending".
    if (halted || segs.some((g) => g.type === 'error')) for (const g of segs) if (g.type === 'tool' && !['completed', 'failed'].includes(g.status)) g.status = 'stopped';
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
  const turn = chat.stop; // only this turn: a message sent meanwhile is a new one, and goes on
  try { await post('/api/copilot/stop', { chat: id }); } catch {}
  setTimeout(() => { if (chat.session === id && chat.stop === turn && turn) turn(); }, 3000);
}

// Back on a chat that is still busy: show its open questions and follow it to the end of the
// turn, then reload it so the whole answer is there.
async function attachLive(id) {
  const out = addMsg('cp', '<span class="typing">Still working</span>');
  const segs = [];
  out.segs = segs;
  const draw = () => { out.innerHTML = renderAnswer(segs, !done) || '<span class="typing">Still working</span>'; $('#chat-log').scrollTop = $('#chat-log').scrollHeight; drawCtx(); };
  const ctrl = new AbortController();
  const view = chat.view;
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
        e.at ||= Date.now(); segs.moved = e.at;
        if (e.type === 'text') { if (last?.type === 'text') last.text += e.text; else segs.push({ type: 'text', text: e.text, at: e.at }); }
        else if (e.type === 'tool') toolEvent(segs, e);
        else if (e.type === 'permission' || e.type === 'error') segs.push(e);
        else if (e.type === 'permission-done') { const g = segs.find((x) => x.type === 'permission' && x.id === e.id); if (g && !g.answered) g.answered = 'Answered'; }
        else if (e.type === 'note') { segs.push({ type: 'note', text: e.text, at: e.at }); if (/^(GitHub|Jira):/.test(e.text)) setTimeout(drawChanges, 300); }
        else if (e.type === 'done') done = true;
      }
      draw();
    }
  } catch { /* switched away */ }
  // Left for another chat: that one owns the panel now (reopening this one here was what
  // pulled you back to a busy chat).
  if (chat.view !== view || chat.session !== id) return;
  done = true;
  draw();
  chat.stop = chat.halt = null;
  sendLabel();
  if (sendQueued()) return;
  if (done) openSession(id, chat.cwd); else chatSub();
}

// Approve or deny a step Copilot asked about (Ask mode).
$('#chat-log').addEventListener('click', async (e) => {
  const rb = e.target.closest('[data-remember]');
  if (rb) { rememberClick(rb); return; }
  const ch = e.target.closest('[data-choice]');
  if (ch && !chat.stop) {
    ch.closest('.choices').querySelectorAll('button').forEach((x) => { x.disabled = true; x.classList.toggle('picked', x === ch); });
    send(ch.dataset.choice);
    return;
  }
  if (e.target.closest('[data-nudge]') && !chat.stop) { send('Try again.'); return; }
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
  // One button that goes Auto → Light → Dark; it shows the one in use.
  const cur = t === 'light' || t === 'dark' ? t : 'auto', b = $('#theme');
  b.dataset.theme = cur;
  b.innerHTML = icon({ auto: 'contrast', light: 'sun', dark: 'moon' }[cur], 15);
  b.title = `Theme: ${{ auto: 'follows the system', light: 'light', dark: 'dark' }[cur]} (click to change)`;
}
$('#theme').onclick = () => setTheme({ auto: 'light', light: 'dark', dark: 'auto' }[$('#theme').dataset.theme || 'auto']);
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
for (const id of ['#cp-model', '#cp-effort', '#cp-perm']) $(id).addEventListener('change', saveCp);
$('#chat-form').onsubmit = (e) => {
  e.preventDefault();
  const t = $('#chat-text').value;
  // While Copilot works, a message waits for the turn to end; an empty box means Stop.
  if (chat.stop && !t.trim()) return chat.halt ? chat.halt() : chat.stop();
  $('#chat-text').value = '';
  if (chat.stop) {
    const el = addMsg('me', `${esc(t)}<span class="queued">Sends when Copilot is done · <button type="button" class="linkish" data-now>Send now</button> · <button type="button" class="linkish" data-unqueue title="Take it back; its text goes back in the box">Cancel</button></span>`);
    el.classList.add('is-queued');
    const q = { text: t, el };
    chat.queued.push(q);
    if (e.submitter?.dataset.now != null || forceNext) sendNow(q);
  } else send(t);
  forceNext = false;
  sendLabel();
};
// Send now (Ctrl+Enter, or the button on a waiting message): stop what Copilot is doing and send
// this next. If Copilot doesn't stop within a few seconds (a step that hangs), its process is
// restarted on the same conversation, as with Restart, and the message goes to that.
let forceNext = false;
function sendNow(q) {
  if (!chat.stop) return;
  chat.queued = [q, ...chat.queued.filter((x) => x !== q)];
  q.el.querySelector('.queued').textContent = 'Sending now: stopping what Copilot is doing';
  const id = chat.session;
  (chat.halt || chat.stop)();
  setTimeout(async () => {
    if (chat.session !== id || !chat.stop || chat.queued[0] !== q) return;
    q.el.querySelector('.queued').textContent = 'Sending now: Copilot didn\'t stop, restarting it on this conversation';
    await post('/api/copilot/close', { chat: id }).catch(() => {});
    chat.stop?.();
  }, 8000);
}
// Cancel a waiting message: it's dropped, and its text goes back in the box to change or send later.
$('#chat-log').addEventListener('click', (e) => {
  if (!e.target.closest('[data-unqueue]')) return;
  const q = chat.queued.find((x) => x.el.contains(e.target));
  if (q) unqueue(q);
});
// (A "Send now" already stopping Copilot carries on stopping; the message just isn't sent.)
function unqueue(q) {
  chat.queued = chat.queued.filter((x) => x !== q);
  q.el.remove();
  const box = $('#chat-text');
  box.value = box.value.trim() ? `${box.value}\n${q.text}` : q.text;
  box.focus();
  sendLabel();
}
// ↑ in an empty box takes the last waiting message back, to change it.
$('#chat-text').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowUp' && !e.target.value && chat.queued.length) { e.preventDefault(); unqueue(chat.queued.at(-1)); }
});
$('#chat-log').addEventListener('click', (e) => {
  if (e.target.closest('[data-now]') == null) return;
  const q = chat.queued.find((x) => x.el.contains(e.target));
  if (q) sendNow(q);
});
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
  const t = { send: 'Send (Enter)', queue: 'Queue: sends when Copilot is done (Enter; Ctrl+Enter stops Copilot and sends now)', stop: 'Stop Copilot' }[st];
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
  { name: 'ref', description: 'Attach a PR, ticket or file', run: () => openRefPick() },
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
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) { e.preventDefault(); forceNext = !!chat.stop; $('#chat-form').requestSubmit(); return; }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#chat-form').requestSubmit(); }
});
$('#cp-skills').addEventListener('click', (e) => {
  const name = e.target.closest('[data-skill]')?.dataset.skill;
  if (!name) return;
  const ta = $('#chat-text');
  ta.value = `/${name} ${ta.value.replace(/^\/[\w-]*\s*/, '')}`.trimEnd() + ' ';
  ta.focus();
});

// Restart: this chat's Copilot stops; the next message starts it again on the same conversation.
$('#cp-restart').onclick = async () => {
  if (chat.stop && !confirm('Copilot is working in this chat. Stop it and restart?')) return;
  const id = chat.session;
  if (chat.stop) chat.stop();
  await post('/api/copilot/close', { chat: id }).catch(() => {});
  addMsg('cp', `<div class="tool"><span>${icon('refresh', 13)}</span>Copilot restarted. Your next message continues this conversation.</div>`);
  drawInfo(true);
};
// Close: stop it and leave the chat; it stays in History.
$('#cp-close').onclick = async () => {
  if (chat.stop && !confirm('Copilot is working in this chat. Stop it and close the chat?')) return;
  const id = chat.session;
  if (chat.stop) chat.stop();
  await post('/api/copilot/close', { chat: id }).catch(() => {});
  recentChats = recentChats.filter((r) => r.id !== id); saveRecent();
  cpLinks.live = (cpLinks.live || []).filter((x) => x.id !== id);
  newChat();
  location.hash = '';
  setTimeout(loadLinks, 1500); // once its Copilot has exited
};

// ---------------------------------------------------------------- the side pane's tabs

// A tab shows when its part has something in it; the one you picked is kept per device.
let cpTab = (() => { try { return localStorage.getItem('clearsky.cp.tab') || 'about'; } catch { return 'about'; } })();
function syncTabs() {
  const panes = [...document.querySelectorAll('.cp-pane')];
  const has = (p) => [...p.children].some((c) => !c.hidden);
  const set = (el, hide) => { if (el.hidden !== hide) el.hidden = hide; }; // only real changes, so the observer below settles
  for (const b of document.querySelectorAll('#cp-tabs [data-pane]')) set(b, !has(panes.find((p) => p.dataset.pane === b.dataset.pane)));
  const shown = [...document.querySelectorAll('#cp-tabs [data-pane]:not([hidden])')].map((b) => b.dataset.pane);
  const cur = shown.includes(cpTab) ? cpTab : shown[0];
  for (const p of panes) set(p, p.dataset.pane !== cur);
  for (const b of document.querySelectorAll('#cp-tabs [data-pane]')) b.setAttribute('aria-selected', String(b.dataset.pane === cur));
  // Outputs says how many there are.
  const n = document.querySelectorAll('#cp-out li').length, ob = $('#cp-tabs [data-pane="out"]');
  const label = `Outputs${n ? ` <b>${n}</b>` : ''}`;
  if (ob.innerHTML !== label) ob.innerHTML = label;
}
$('#cp-tabs').onclick = (e) => {
  const b = e.target.closest('[data-pane]');
  if (!b) return;
  cpTab = b.dataset.pane;
  try { localStorage.setItem('clearsky.cp.tab', cpTab); } catch {}
  syncTabs();
};
let tabsQueued = false;
const tabsWatch = new MutationObserver(() => { if (!tabsQueued) { tabsQueued = true; queueMicrotask(() => { tabsQueued = false; syncTabs(); }); } });
for (const p of document.querySelectorAll('.cp-pane')) tabsWatch.observe(p, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden'] });
syncTabs();

// The side pane in the main column: its tabs take the whole width, and Conversation (or Esc)
// goes back. On a narrow screen, where there is no side pane, Details in the header does the same.
function cpWide(on) {
  const w = $('.cpw');
  if (w.classList.contains('wide') === on) return;
  w.classList.toggle('wide', on);
  const b = $('#cp-wide');
  b.innerHTML = icon(on ? 'collapse' : 'expand', 14);
  b.title = on ? 'Back beside the conversation (Alt+D)' : 'Show in the main column (Alt+D)';
  b.setAttribute('aria-label', on ? 'Back beside the conversation' : 'Show in the main column');
  b.setAttribute('aria-pressed', String(on));
  $('#cp-details').setAttribute('aria-pressed', String(on));
  if (on) $('.cp-side').scrollTop = 0;
  else $('#chat-text').focus({ preventScroll: true });
}
const cpIsWide = () => $('.cpw').classList.contains('wide');
$('#cp-wide').onclick = () => cpWide(!cpIsWide());
$('#cp-conv').onclick = () => cpWide(false);
$('#cp-details').onclick = () => cpWide(!cpIsWide());
document.addEventListener('keydown', (e) => {
  if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyD' && !$('#chat').hidden) { e.preventDefault(); cpWide(!cpIsWide()); }
});

// A "Copy line" button: copies its text (the credits line, say), ready to paste.
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-copy-text]');
  if (!b) return;
  try { await navigator.clipboard.writeText(b.dataset.copyText); b.textContent = 'Copied'; } catch { b.textContent = 'Select and copy'; }
  setTimeout(() => { b.textContent = 'Copy line'; }, 1500);
});

// Copy icons: on a code block (its code), a table (as a table for Sheets, Jira or Docs, with
// tab-separated text for plain pastes) and a whole answer (its Markdown, and formatted).
async function copyRich(html, text) {
  try {
    if (window.ClipboardItem && html) await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([text], { type: 'text/plain' }) })]);
    else await navigator.clipboard.writeText(text);
    return true;
  } catch { try { await navigator.clipboard.writeText(text); return true; } catch { return false; } }
}
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-copy-block], [data-copy-answer]');
  if (!b) return;
  e.preventDefault();
  let ok;
  if (b.dataset.copyAnswer != null) {
    const msg = b.closest('.msg');
    const text = (msg?.segs || []).filter((g) => g.type === 'text').map((g) => g.text).join('\n\n').trim();
    const html = [...(msg?.querySelectorAll(':scope > .txt') || [])].map((x) => x.innerHTML).join('');
    ok = await copyRich(html.replace(/<button[^>]*class="b-copy[^"]*"[^>]*>[\s\S]*?<\/button>/g, ''), text);
  } else {
    const box = b.parentElement, table = box.querySelector('table');
    if (table) {
      const tsv = [...table.rows].map((r) => [...r.cells].map((c) => c.innerText.replace(/\s+/g, ' ').trim()).join('\t')).join('\n');
      ok = await copyRich(table.outerHTML, tsv);
    } else ok = await copyRich(null, box.querySelector('code')?.textContent || '');
  }
  b.innerHTML = icon(ok ? 'check' : 'copy', 13);
  b.title = ok ? 'Copied' : 'Select and copy';
  setTimeout(() => { b.innerHTML = icon('copy', 13); b.title = 'Copy'; }, 1500);
});

// Add a folder to the chat on screen, or take one off (its side panel).
document.addEventListener('submit', async (e) => {
  const f = e.target.closest('[data-folder-form]');
  if (!f) return;
  e.preventDefault();
  const input = f.elements.f, path = input.value.trim();
  if (!path) return input.focus();
  try {
    await post('/api/copilot/folders', { chat: chat.session, add: path });
    input.value = '';
    $('#chat-sub').textContent = `Added ${path}: it applies from your next message.`;
  } catch (err) { input.setCustomValidity(err.message); input.reportValidity(); setTimeout(() => input.setCustomValidity(''), 4000); return; }
  drawInfo(true);
});
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-folder-off]');
  if (!b) return;
  try { await post('/api/copilot/folders', { chat: chat.session, remove: b.dataset.folderOff }); } catch {}
  drawInfo(true);
});
