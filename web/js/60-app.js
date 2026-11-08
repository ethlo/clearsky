// Clearsky page: wiring, views and the reader. Runs last.
// The server joins web/js/*.js in name order into one script in index.html, so they share one scope.

// ---------------------------------------------------------------- wiring

document.addEventListener('click', (e) => {
  const ask = e.target.closest('[data-ask]');
  if (ask) { e.stopPropagation(); return menu.hidden || menu.dataset.ask !== ask.dataset.ask ? openAskMenu(ask) : (menu.hidden = true); }
  const key = e.target.closest('.hide')?.dataset.key;
  if (key) { const b = e.target.closest('.hide'); dismissed[key] = b.dataset.stamp; dismiss({ key, stamp: b.dataset.stamp }); return; }
  const more = e.target.closest('.more')?.dataset.more;
  if (more) { expanded.add(more); renderToday(); }
});

// ---------------------------------------------------------------- views

// One view at a time fills the work area. Lists are #inbox, #reviews, #prs, #mentions and
// #tickets; #item is one thing in full; #copilot is the chat; #calendar, #standup, #src-<name>,
// #links and #links-personal.
let current = 'inbox', returnTo = 'inbox', openChatSkip = false;
function route() {
  let h = location.hash.slice(1) || 'inbox';
  // Old links: the Personal tab is now each personal source's own page.
  if (h === 'personal') {
    const p = extraSources.find((x) => x.area === 'personal');
    h = p ? `src-${p.name}` : 'inbox';
    history.replaceState(null, '', `#${h}`);
  }
  if (h === 'item' && !curItem) { h = 'inbox'; history.replaceState(null, '', '#inbox'); }
  if (h.startsWith('src-') && !extraSources.some((x) => `src-${x.name}` === h)) h = extraSources.length ? 'inbox' : h;
  if (h !== 'item' && h !== 'copilot') returnTo = h;
  current = h;
  const list = h in LIST_VIEWS;
  $('#v-list').hidden = !list;
  $('#v-item').hidden = h !== 'item';
  $('#v-calendar').hidden = h !== 'calendar';
  $('#v-standup').hidden = h !== 'standup';
  $('#v-src').hidden = !h.startsWith('src-');
  $('#v-notes').hidden = h !== 'notifications';
  $('#v-changes').hidden = h !== 'changes';
  $('#v-handoffs').hidden = h !== 'handoffs';
  $('#v-builds').hidden = h !== 'builds';
  $('#v-servers').hidden = h !== 'servers';
  $('#v-map').hidden = h !== 'map';
  $('#v-links').hidden = h !== 'links' && h !== 'links-personal';
  $('#chat').hidden = h !== 'copilot';
  for (const a of document.querySelectorAll('[data-nav]')) a.classList.toggle('on', a.dataset.nav === (h === 'item' ? returnTo : h));
  menu_(false);
  hideCard();
  hideEvent(true);
  if (list) { listView = h; $('#list-title').textContent = LIST_VIEWS[h]; renderList(); $('#list').focus({ preventScroll: true }); }
  if (h === 'calendar') renderCalendar();
  if (h === 'notifications') renderNotes();
  if (h === 'changes') renderChanges();
  if (h === 'handoffs') loadHandoffs();
  if (h === 'builds') loadBuilds(false);
  if (h === 'servers') loadServers();
  if (h === 'map') renderMap();
  if (h === 'links' || h === 'links-personal') renderLinks(h === 'links' ? 'work' : 'personal');
  if (h === 'standup' && !standupData) { renderStandup(); loadStandup(false); }
  if (h.startsWith('src-')) { $('#src-body').innerHTML = ''; renderExtra(); }
  if (h === 'copilot') { showChat(openChatSkip); openChatSkip = false; }
  drawTabs();
  drawFresh();
}
window.addEventListener('hashchange', route);
function back() { location.hash = `#${returnTo || 'inbox'}`; }
document.addEventListener('click', (e) => { if (e.target.closest('[data-back]')) back(); });

// Esc goes back to the list (or from a filtered list to the inbox), unless something smaller
// is open: a menu, a popover, a picker. Those close first.
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.ctrlKey || e.metaKey || e.altKey) return;
  if (!menu.hidden || evPop?.isConnected || hc.classList.contains('on') || document.querySelector('#cp-refs .ref-pick')) return;
  if ($('#side').classList.contains('open')) { menu_(false); return; }
  if (!$('#chat-hist').hidden) { showHistory(false); e.preventDefault(); return; }
  const t = e.target;
  if (t.closest?.('input, select') || (t.id === 'chat-text' && t.value)) return;
  if (current === 'inbox') { document.querySelectorAll('#list .r.sel').forEach((x) => x.classList.remove('sel')); selK = null; return; }
  e.preventDefault();
  location.hash = current in LIST_VIEWS ? '#inbox' : `#${returnTo || 'inbox'}`;
}, true);

// On a small screen the menu folds away behind ☰.
function menu_(open) {
  $('#side').classList.toggle('open', open);
  $('#scrim').hidden = !open;
  $('#menu-btn').setAttribute('aria-expanded', String(open));
}
$('#menu-btn').onclick = () => menu_(!$('#side').classList.contains('open'));
$('#scrim').onclick = () => menu_(false);

$('#copy').onclick = async () => {
  const btn = $('#copy');
  try { await navigator.clipboard.writeText(standupData?.text || ''); btn.textContent = 'Copied ✓'; }
  catch { btn.textContent = 'Copy failed'; }
  setTimeout(() => { btn.textContent = 'Copy for Slack'; }, 1500);
};
$('#refresh').onclick = () => { previews.clear(); ctxTickets.clear(); readCache.clear(); if (location.hash === '#standup') loadStandup(true); else loadAll(true); };
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-refresh]');
  if (!btn) return;
  if (e.shiftKey) loadAll(true); else refreshPanel(PANEL_SOURCES[btn.dataset.refresh]);
});
for (const b of document.querySelectorAll('#refresh, [data-refresh="plan"]')) b.innerHTML = REFRESH_ICON;

try { localStorage.removeItem('clearsky.hidden'); } catch {} // from the browser-only version
renderToday();
getJson('/api/sources').then((r) => {
  addSourcePanels(r.sources || []);
  for (const x of r.sources || []) { SOURCES.push(x.name); loadSource(x.name, false); }
}).catch(() => {});
getJson('/api/dismissed').then((d) => { dismissed = d.dismissed || {}; mutedMap = d.muted || {}; renderToday(); }).catch(() => {});
loadAll(false);
route();
setInterval(() => loadAll(false), REFRESH_MS);
pollAttention();
setInterval(pollAttention, 60_000);
loadLinks();
setInterval(loadLinks, 30_000);

// ---------------------------------------------------------------- reader

const bytes = (n) => (n == null ? '' : n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} kB` : `${(n / 1048576).toFixed(1)} MB`);
// Plain text from the source, with its web addresses made clickable.
const linkText = (t) => esc(t).replace(/https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)]/g, (u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);

// Read marks for sources that can't be told (school): kept by Clearsky, per item, until
// something new arrives on it. Opening an item marks it read.
const sourceItem = (src, key) => (state[src]?.items || []).find((i) => i.key === key);
async function markRead(src, items, read) {
  try {
    await post('/api/read', { marks: items.map((i) => ({ key: `${src}:${i.key}`, at: read ? i.at : null })) });
    for (const i of items) if (i.unreadAtSource) Object.assign(i, { unread: !read, readHere: read });
  } catch (e) { $('#status').textContent = `Could not save: ${e.message}`; }
  renderToday();
  if (curItem?.reader && items.length === 1) drawReadToggle(src, items[0].key);
}
function drawReadToggle(src, key) {
  const el = $('#read-toggle'), i = sourceItem(src, key);
  if (!el) return;
  el.innerHTML = i?.unreadAtSource ? `<button class="icon-btn" data-mark="${esc(src)}" data-key="${esc(key)}" data-to="${i.unread ? 'read' : 'unread'}">${i.unread ? 'Mark read' : 'Mark unread'}</button>` : '';
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-mark]');
  if (b) { const i = sourceItem(b.dataset.mark, b.dataset.key); if (i) markRead(b.dataset.mark, [i], b.dataset.to === 'read'); return; }
  const all = e.target.closest('button[data-mark-all]');
  if (all) {
    const src = all.dataset.markAll, grp = all.dataset.group;
    markRead(src, (state[src]?.items || []).filter((i) => i.unread && (!grp || i.group === grp)), true);
  }
});

// One message as a card: who and when, then its text and files.
function msgCard(m, file, title, cls = '') {
  return `<div class="msg-r${m.mine ? ' mine' : ''}${cls}">
    <div class="who"><b>${esc(m.from || '')}</b>${m.at ? ` · ${esc(new Date(m.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short', hourCycle: hourCycle() }))}` : ''}</div>
    ${m.title && m.title !== title ? `<div class="sub">${esc(m.title)}</div>` : ''}
    <div class="txt">${linkText(m.text || '')}</div>
    ${m.attachments?.length ? `<div class="files">${m.attachments.map((a) => a.id
      ? `<a href="${file(a)}" target="_blank" rel="noopener">${icon('clip', 13)} ${esc(a.name)} <span class="size">${bytes(a.bytes)}</span></a>`
      : `<span title="Open it in the portal">${icon('clip', 13)} ${esc(a.name)}</span>`).join('')}</div>` : ''}
  </div>`;
}
// A thread: the newest message first, open; the earlier ones folded under it, newest first,
// each its own card. A group chat (a class's parents) can hold weeks of messages.
function thread(messages, file, title) {
  if (!messages.length) return '<div class="empty" style="padding-left:0">Nothing to show.</div>';
  const newest = [...messages].reverse();
  const [latest, ...earlier] = newest;
  return msgCard(latest, file, title, ' latest') + (earlier.length ? `<details class="earlier"><summary>Earlier in this conversation (${earlier.length})</summary>
    ${earlier.map((m) => msgCard(m, file, title)).join('')}</details>` : '');
}

// A source's item read in full, such as a school message, in the work area.
// Items read in full, kept for this page so going back and forth is instant. Not fetched ahead
// on hover: a source may count a read as "seen" at its end. Refresh forgets them.
const readCache = new Map();
function readDetail(src, key) {
  const k = `${src}:${key}`;
  if (!readCache.has(k)) {
    readCache.set(k, getJson(`/api/source/${encodeURIComponent(src)}/detail?key=${encodeURIComponent(key)}`).catch((e) => { readCache.delete(k); throw e; }));
    if (readCache.size > 100) readCache.delete(readCache.keys().next().value);
  }
  return readCache.get(k);
}
async function openReader(src, key, url) {
  curItem = { reader: true, k: `${src}:${key}`, title: 'Loading…' };
  const it = curItem, el = $('#item');
  const x = extraSources.find((s) => s.name === src);
  $('#it-crumb').textContent = x?.panel.title || '';
  location.hash = '#item';
  const open = (u) => `<div class="acts-row">${u ? `<a class="icon-btn primary" href="${esc(u)}" target="_blank" rel="noopener">Open in portal ↗</a>` : ''}<span id="read-toggle"></span></div>`;
  el.innerHTML = `<h2>Loading…</h2>${skeleton(3)}`;
  try {
    const d = await readDetail(src, key);
    if (curItem !== it) return;
    setTimeout(() => { if (curItem === it) { const i = sourceItem(src, key); if (i?.unread) markRead(src, [i], true); else drawReadToggle(src, key); } });
    const file = (a) => `/api/source/${encodeURIComponent(src)}/attachment?key=${encodeURIComponent(key)}&id=${encodeURIComponent(a.id)}`;
    el.innerHTML = `<h2>${esc(d.title || 'Message')}</h2><div class="why">${esc([d.child, d.meta].filter(Boolean).join(' · '))}</div>${open(d.url || url)}
      ${thread(d.messages || [], file, d.title)}`;
  } catch (e) {
    if (curItem !== it) return;
    el.innerHTML = `<h2>Couldn’t open this</h2>${open(url)}<div class="err" style="margin:0">${esc(e.message)}${/log in/i.test(e.message) ? ' <a href="/settings#extra">Log in again in Settings</a>' : ''}</div>`;
  }
}

document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-read]');
  // Ctrl/Cmd-click still opens the source's own page.
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  e.preventDefault();
  openReader(a.dataset.read, a.dataset.key, a.getAttribute('href'));
});

// In its own window (`clearsky app`), Clearsky opens where and as big as you left it, and never
// bigger than the screen. The browser's own memory of the size is unreliable: a running browser
// ignores --window-size, and it may remember a size from another screen. A normal tab skips this.
if (APP_WINDOW) {
  const KEY = 'clearsky.window';
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch {}
  const fit = (w, h) => [Math.min(w, screen.availWidth), Math.min(h, screen.availHeight)];
  const [w, h] = saved ? fit(saved.w, saved.h) : fit(outerWidth, outerHeight);
  try {
    if (w !== outerWidth || h !== outerHeight) resizeTo(w, h);
    if (saved && saved.x + w <= (screen.availLeft || 0) + screen.availWidth + 50 && saved.y + h <= (screen.availTop || 0) + screen.availHeight + 50) moveTo(saved.x, saved.y);
    else if (!saved && (w < outerWidth || h < outerHeight)) moveTo(screen.availLeft || 0, screen.availTop || 0);
  } catch {}
  let t;
  const keep = () => { clearTimeout(t); t = setTimeout(() => { try { localStorage.setItem(KEY, JSON.stringify({ w: outerWidth, h: outerHeight, x: screenX, y: screenY })); } catch {} }, 500); };
  addEventListener('resize', keep);
  addEventListener('beforeunload', () => { try { localStorage.setItem(KEY, JSON.stringify({ w: outerWidth, h: outerHeight, x: screenX, y: screenY })); } catch {} });
}
