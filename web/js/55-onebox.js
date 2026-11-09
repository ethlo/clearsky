// Clearsky page: one box (Ctrl/Cmd-K) to find anything and do anything.
// The server joins web/js/*.js in name order into one script in index.html, so they share one scope.
//
// The index is what the page already has, built when the box opens: PRs, tickets, mentions,
// Copilot chats, links, today's and tomorrow's meetings, personal sources' items, servers,
// the pages, Settings' tabs, your skills and a few commands. Nothing extra is fetched to search.
// A key or link it doesn't know (an old ticket, someone's PR) still opens: that item is looked
// up when you pick it, the same way hover cards do.

const OB_KIND = { work: 'Work', chat: 'Copilot', link: 'Link', meeting: 'Meeting', page: 'Go to', setting: 'Settings', skill: 'Skill', cmd: 'Do', server: 'Server', open: 'Open', personal: 'Personal' };
// Higher first when scores tie: what you most likely want.
const OB_RANK = { open: 9, work: 8, chat: 7, page: 6, skill: 5, cmd: 5, link: 4, meeting: 4, personal: 3, server: 3, setting: 2 };

function oneboxIndex() {
  const out = [];
  const add = (kind, title, sub, run, extra = '') => out.push({ kind, title: String(title || ''), sub: String(sub || ''), run, hay: `${title} ${sub} ${extra}`.toLowerCase() });
  // Work: everything in the lists, done and snoozed too (they're still yours to find).
  for (const it of inboxItems()) add('work', it.title, [it.ref, it.src, it.done ? 'done' : it.snoozed ? 'snoozed' : ''].filter(Boolean).join(' · '), () => openItem(it), `${it.issue || ''} ${it.pr || ''} ${it.data?.branch || ''}`);
  // Copilot chats: the live ones and the ones you used lately.
  const seen = new Set();
  for (const s of sessionItems()) { seen.add(s.sid); add('chat', s.title, [s.ref, s.label?.[0]].filter(Boolean).join(' · '), () => openItem(s)); }
  for (const t of (typeof chatTabs === 'function' ? chatTabs() : [])) if (!seen.has(t.id)) add('chat', t.title, 'Copilot chat', () => { openChat(true, true); openSession(t.id, t.cwd); });
  // Links, both sides.
  for (const g of linksDoc?.groups || []) for (const l of g.links) add('link', l.title, `${g.name} · ${linkHost(l.url)}`, () => window.open(l.url, '_blank', 'noopener'), l.url);
  // Meetings today and tomorrow.
  const t1 = new Date(); t1.setDate(t1.getDate() + 1);
  for (const e of state.calendar?.events || []) {
    if (!sameDay(e.start) && !sameDay(e.start, t1)) continue;
    add('meeting', e.title, `${sameDay(e.start) ? 'Today' : 'Tomorrow'}${e.allDay ? '' : ` ${hm(e.start)}`}${e.location ? ` · ${e.location}` : ''}`, () => { location.hash = '#calendar'; });
  }
  // Personal sources (school and the like): their page.
  for (const x of extraSources.filter((s) => s.area === 'personal')) for (const i of state[x.name]?.items || []) add('personal', i.title, x.panel.title, () => { location.hash = `#src-${x.name}`; }, i.from || '');
  // Servers, once their page has loaded them: the ssh command goes to the clipboard.
  for (const h of serversData?.hosts || []) add('server', h.name, [h.host, h.jump && `via ${h.jump}`].filter(Boolean).join(' · '), () => copyText(`ssh ${h.name}`, `Copied: ssh ${h.name}`));
  // Pages in the menu, and Settings' tabs.
  for (const a of document.querySelectorAll('#nav a[data-nav], #side-personal a[data-nav]')) if (!a.hidden) add('page', a.querySelector('.lab')?.textContent, '', () => { location.hash = a.getAttribute('href') || '#'; });
  for (const [name, slug, words] of [['General', 'general', 'stand-up workday clock team pack demo'], ['GitHub', 'plugins/github', 'organizations token plugin'], ['Jira', 'plugins/jira', 'atlassian acli plugin'],
    ['Calendar', 'plugins/calendar', 'ical gnome google plugin'], ['Plugins', 'plugins', 'add sources modules'], ['Copilot', 'copilot', 'sandbox model folders doors'], ['VPN', 'vpn', 'grafana'],
    ...extraSources.map((x) => [x.label || x.panel?.title || x.name, `plugins/${x.name}`, `${x.name} plugin`])]) {
    add('setting', `Settings: ${name}`, '', () => { location.href = `/settings#${slug}`; }, words);
  }
  // Skills: a new chat that runs it.
  for (const sk of chat.info?.skills || []) add('skill', `/${sk.name}`, sk.description || 'Run in a new chat', () => { newChat(); openChat(true, true); send(`/${sk.name}`); }, sk.name);
  add('cmd', 'New Copilot chat', 'Alt+N', () => { newChat(); openChat(true, true); $('#chat-text').focus(); }, 'ask copilot');
  add('cmd', 'Refresh everything', '', () => $('#refresh').click(), 'reload update');
  add('cmd', 'Copy the stand-up for Slack', '', async () => { if (!standupData) await loadStandup(false); copyText(standupData?.text || '', 'Stand-up copied'); }, 'standup');
  add('cmd', 'Switch theme', 'light, dark or auto', () => $('#theme').click(), 'dark light mode');
  return out;
}

// A ticket key, owner/repo#12 or a GitHub or Jira link: open it even when it's not in your lists.
function oneboxDirect(q) {
  const s = q.trim();
  let k = null;
  if (/^[A-Z][A-Z0-9_]+-\d+$/i.test(s)) k = `issue:${s.toUpperCase()}`;
  else if (/^[\w.-]+\/[\w.-]+#\d+$/.test(s)) k = `pr:${s}`;
  else { const r = refFromUrl(s); if (r) k = refKeyOf(r); }
  if (k) {
    const label = k.replace(/^(issue|pr|gh):/, '');
    return { kind: 'open', title: `Open ${label}`, sub: 'even if it isn’t in your lists', run: () => openItem(itemForKey(k) || itemForKey(k.replace(/^pr:/, 'gh:'))), hay: '' };
  }
  if (/^https?:\/\/\S+$/.test(s)) return { kind: 'open', title: `Open ${s}`, sub: 'in a new tab', run: () => window.open(s, '_blank', 'noopener'), hay: '' };
  return null;
}

// Every word has to match; matches at the start of the title and of words count most.
function oneboxScore(x, words) {
  let score = 0;
  const title = x.title.toLowerCase();
  for (const w of words) {
    const at = x.hay.indexOf(w);
    if (at < 0) return -1;
    score += title.startsWith(w) ? 6 : title.includes(` ${w}`) || title.includes(w) ? 4 : 1;
  }
  return score + (OB_RANK[x.kind] || 0) / 10;
}

function copyText(text, note) {
  navigator.clipboard.writeText(text).then(() => { $('#status').textContent = note; }, () => { $('#status').textContent = 'Couldn’t copy'; });
}

let obIndex = [], obHits = [], obSel = 0;
const ob = document.createElement('div');
ob.className = 'ob-scrim';
ob.hidden = true;
ob.innerHTML = `<div class="ob" role="dialog" aria-label="Find anything"><input id="ob-q" type="search" placeholder="Find a PR, ticket, chat, link, meeting, page or skill… or paste a key or link" spellcheck="false" autocomplete="off" aria-label="Find anything">
  <div class="ob-list" id="ob-list" role="listbox"></div><div class="ob-foot"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>↵</kbd> open</span><span><kbd>Esc</kbd> close</span></div></div>`;
document.body.append(ob);

function oneboxDraw() {
  const q = $('#ob-q').value, words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const direct = oneboxDirect(q);
  const hits = words.length ? obIndex.map((x) => [x, oneboxScore(x, words)]).filter(([, s]) => s >= 0).sort((a, b) => b[1] - a[1]).map(([x]) => x)
    : obIndex.filter((x) => x.kind === 'work' && !/done|snoozed/.test(x.sub)).slice(0, 6).concat(obIndex.filter((x) => x.kind === 'chat').slice(0, 3), obIndex.filter((x) => x.kind === 'cmd'));
  obHits = [...(direct ? [direct] : []), ...hits].slice(0, 30);
  obSel = Math.min(obSel, Math.max(0, obHits.length - 1));
  $('#ob-list').innerHTML = obHits.length ? obHits.map((x, i) => `<button type="button" class="ob-r${i === obSel ? ' sel' : ''}" data-ob="${i}" role="option" aria-selected="${i === obSel}">
      <span class="ob-k">${esc(OB_KIND[x.kind] || '')}</span><span class="ob-t">${esc(x.title)}</span><span class="ob-s">${esc(x.sub)}</span></button>`).join('')
    : `<div class="ob-none">Nothing matches “${esc(q)}”.</div>`;
  $('#ob-list .sel')?.scrollIntoView({ block: 'nearest' });
}
function oneboxOpen() {
  obIndex = oneboxIndex();
  obSel = 0;
  ob.hidden = false;
  $('#ob-q').value = '';
  oneboxDraw();
  $('#ob-q').focus();
  // Skills and servers fill in if they weren't loaded yet.
  if (!chat.info) loadCopilotInfo().then(() => { if (!ob.hidden) { obIndex = oneboxIndex(); oneboxDraw(); } }).catch(() => {});
  if (!serversData) getJson('/api/servers').then((d) => { serversData = d; if (!ob.hidden) { obIndex = oneboxIndex(); oneboxDraw(); } }).catch(() => {});
}
function oneboxClose() { ob.hidden = true; }
function oneboxRun(i) {
  const x = obHits[i];
  if (!x) return;
  oneboxClose();
  x.run();
}
$('#ob-q').addEventListener('input', () => { obSel = 0; oneboxDraw(); });
$('#ob-q').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { obSel = Math.min(obSel + 1, obHits.length - 1); oneboxDraw(); e.preventDefault(); }
  else if (e.key === 'ArrowUp') { obSel = Math.max(obSel - 1, 0); oneboxDraw(); e.preventDefault(); }
  else if (e.key === 'Enter') { e.preventDefault(); oneboxRun(obSel); }
  else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); oneboxClose(); }
});
ob.addEventListener('click', (e) => {
  const r = e.target.closest('[data-ob]');
  if (r) return oneboxRun(Number(r.dataset.ob));
  if (e.target === ob) oneboxClose();
});
// Ctrl+K (Cmd+K on a Mac) from anywhere, even while typing.
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    if (ob.hidden) oneboxOpen(); else oneboxClose();
  }
}, true);

// A way in for the mouse: "Find" at the top of the menu.
{
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'ob-open';
  b.innerHTML = `<svg class="i" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><span>Find anything</span><kbd>${mac ? '⌘' : 'Ctrl'} K</kbd>`;
  b.onclick = oneboxOpen;
  $('#nav').before(b);
}
