// Clearsky page: state, loading, what's new, hidden items and the building blocks every view uses.
// The server joins web/js/*.js in name order into one script in index.html, so they share one scope.

const REFRESH_MS = 5 * 60 * 1000;
let SOURCES = ['github', 'jira', 'jiraMentions', 'slack', 'calendar'];
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// One icon set (24-unit line icons, drawn in the text colour): icon('inbox').
const ICONS = {
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  standup: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  review: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  pr: '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7M6 9v12"/>',
  at: '<circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"/>',
  ticket: '<path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2z"/><path d="M13 5v2M13 17v2M13 11v2"/>',
  settings: '<path d="M20 7h-9M14 17H4"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/>',
  home: '<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/>',
  source: '<path d="m12 2 10 5-10 5L2 7z"/><path d="m2 17 10 5 10-5M2 12l10 5 10-5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  clip: '<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
  folder: '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z"/>',
  tool: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
  wait: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  spark: '<path d="M12 3l1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2z"/>',
  back: '<path d="M19 12H5M12 19l-7-7 7-7"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>',
};
const icon = (name, size = 16) => `<svg class="i" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
document.querySelectorAll('[data-i]').forEach((el) => { el.innerHTML = icon(el.dataset.i, Number(el.dataset.size) || 16); });
// 45 min, 1 h, 2 h 15 min
const dur = (min) => (min < 60 ? `${min} min` : `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ''}`);
// 24-hour clock unless Settings says 12.
const hourCycle = () => (state.plan?.prefs?.hour12 ? 'h12' : 'h23');
const hm = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: hourCycle() });

function ago(iso) {
  if (!iso) return '';
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

// ---------------------------------------------------------------- state

const state = { plan: null };
let pending = 0;
function busy(delta) {
  pending += delta;
  $('#dot').classList.toggle('busy', pending > 0);
  if (pending > 0) $('#status').textContent = 'Updating…';
  else $('#status').textContent = `Updated ${hm(new Date())}`;
}

async function getJson(url) {
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

// Each source loads on its own and re-renders as soon as it arrives.
const loading = new Set();
function loadSource(name, force) {
  loading.add(name); busy(1); renderToday();
  return getJson(`/api/source/${name}${force ? '?refresh=1' : ''}`)
    .then((d) => { state[name] = d; if (name === 'jira') loadBranches(); })
    .catch((e) => { state[name] = { error: e.message, fetchedAt: new Date().toISOString() }; })
    .finally(() => { loading.delete(name); busy(-1); renderToday(); drawFresh(); });
}

// "↻ updated 3m ago" next to the page title; click to refresh everything.
function drawFresh() {
  const times = SOURCES.map((n) => state[n]?.fetchedAt).filter(Boolean).sort();
  const spinning = SOURCES.some((n) => loading.has(n));
  for (const b of document.querySelectorAll('[data-fresh]')) {
    b.classList.toggle('spin', spinning);
    b.innerHTML = `${REFRESH_ICON}<span>${spinning ? 'Refreshing…' : times.length ? `updated ${esc(ago(times[0]))}` : ''}</span>`;
  }
}
setInterval(drawFresh, 30_000);
document.addEventListener('click', (e) => { if (e.target.closest('[data-fresh]')) { previews.clear(); loadAll(true); drawFresh(); } });

// The plan is built from every source; the server reuses what it already has cached.
function loadPlan() {
  loading.add('plan'); busy(1);
  return getJson('/api/plan').then((d) => { state.plan = d; })
    .catch((e) => { state.plan = { error: e.message }; })
    .finally(() => { loading.delete('plan'); busy(-1); renderToday(); });
}

function loadAll(force) {
  for (const name of SOURCES) loadSource(name, force);
  setTimeout(loadPlan, 50);
}

// ---------------------------------------------------------------- Copilot sessions per item

// Which Copilot sessions are about each PR or ticket, and which are busy or waiting on you,
// whether they run here, in a terminal or in an editor.
let cpLinks = { links: {}, live: [] };
const STATUS_TEXT = { working: 'working', 'needs-you': 'needs your OK', waiting: 'waiting for you', closed: '' };
function itemKey(url) {
  const r = refFromUrl(url);
  return r && refKeyOf(r);
}
function chip(x) {
  const st = STATUS_TEXT[x.status] || '';
  return `<button class="cp-chip s-${esc(x.status || 'closed')}" data-sid="${esc(x.id)}" data-cwd="${esc(x.cwd || '')}"
    title="Copilot session${st ? `, ${st}` : ''}, ${esc(ago(x.updatedAt))}. Click to open it."><i></i><span>${esc(x.title)}</span>${st ? `<b>· ${st}</b>` : ''}</button>`;
}
function sessionChips(url) {
  const list = cpLinks.links[itemKey(url || '')];
  return list?.length ? `<div class="cps">${list.slice(0, 2).map(chip).join('')}</div>` : '';
}
async function loadLinks() {
  try { cpLinks = await getJson('/api/copilot/links'); } catch { return; }
  renderToday();
  drawCtx();
}
document.addEventListener('click', (e) => {
  const c = e.target.closest('.cp-chip');
  if (!c) return;
  e.preventDefault();
  openChat(true, true);
  openSession(c.dataset.sid, c.dataset.cwd);
});

// ---------------------------------------------------------------- what's new

// The server checks every few minutes and remembers when each thing that needs you first
// showed up. Anything newer than your last look gets a dot and counts in the tab title.
let attention = { items: [], byKey: new Map(), lastPoll: null, notifier: null };
const LOOK_KEY = 'clearsky.lastLook', NOTIFIED_KEY = 'clearsky.notifiedUpTo';
let lastLook = Date.now();
try { lastLook = Number(localStorage.getItem(LOOK_KEY)) || Date.now(); } catch {}
function isNew(key, stamp) {
  const it = attention.byKey.get(key);
  // `at` is when it last turned up with something new, which is all a dot needs.
  return !!(it?.at && Date.parse(it.at) > lastLook);
}
function looked() {
  lastLook = Date.now();
  try { localStorage.setItem(LOOK_KEY, String(lastLook)); } catch {}
}
// Leaving the page counts as having looked; what arrives while you're away gets a dot.
document.addEventListener('visibilitychange', () => { if (document.hidden) looked(); else { renderToday(); title(); } });
window.addEventListener('pagehide', looked);
function title() {
  const n = attention.items.filter((it) => it.at && Date.parse(it.at) > lastLook).length;
  document.title = n ? `(${n}) Clearsky` : 'Clearsky';
}
async function pollAttention() {
  let a;
  try { a = await getJson('/api/attention'); } catch { return; }
  const polled = attention.lastPoll && a.lastPoll !== attention.lastPoll;
  attention = { ...a, byKey: new Map(a.items.map((it) => [it.key, it])) };
  notifyButton();
  browserNotify();
  title();
  // The server fetched new data: show it.
  if (polled) loadAll(false); else renderToday();
}
// Without notify-send on the machine, the open page shows the notifications instead.
function browserNotify() {
  if (attention.notifier !== 'browser' || !('Notification' in window) || Notification.permission !== 'granted') return;
  let upTo = Date.now();
  try { upTo = Number(localStorage.getItem(NOTIFIED_KEY)) || Date.now(); } catch {}
  const fresh = attention.items.filter((it) => it.at && Date.parse(it.at) > upTo && !dismissed[it.key]);
  for (const it of fresh.slice(0, 4)) {
    const n = new Notification(it.title, { body: it.body || '', tag: it.key });
    n.onclick = () => { window.open(it.url, '_blank', 'noopener'); n.close(); };
  }
  try { localStorage.setItem(NOTIFIED_KEY, String(Math.max(upTo, ...attention.items.map((it) => Date.parse(it.at) || 0)))); } catch {}
}
const BELL = icon('bell', 15);
function notifyButton() {
  const b = $('#notify'), n = attention.notifier;
  if (!n) return;
  b.innerHTML = BELL;
  const browserOff = n === 'browser' && 'Notification' in window && Notification.permission !== 'granted';
  // The bell only shows when there's something to do (let this browser notify you); the state
  // is on Notifications in the menu.
  b.hidden = !browserOff || Notification.permission === 'denied';
  b.classList.toggle('on', n === 'desktop' || (n === 'browser' && !browserOff));
  const nav = document.querySelector('[data-nav="notifications"]');
  b.title = n === 'desktop' ? 'Desktop notifications are on (workdays, working hours). Set CLEARSKY_NOTIFY=off to stop them.'
    : n === 'off' ? 'Notifications are off (CLEARSKY_NOTIFY=off)'
      : browserOff ? 'Click to get notified in this browser when something needs you' : 'Browser notifications are on while this page is open';
  if (nav) nav.title = b.title;
}
$('#notify').onclick = async () => {
  if (attention.notifier === 'browser' && 'Notification' in window && Notification.permission === 'default') await Notification.requestPermission();
  notifyButton();
};

// One panel's refresh button: reload just its sources, then the plan that depends on them.
function refreshPanel(names) {
  Promise.all(names.map((n) => loadSource(n, true))).then(loadPlan);
}

// ---------------------------------------------------------------- hidden items

// Dismissed items live in ~/.config/clearsky/state.json as { key: stamp }, so the plan and
// every browser see them. An item comes back as soon as its stamp changes (new activity).
let dismissed = {};
let csrf = document.querySelector('meta[name=csrf]').content;
// After the server restarts with a new token, pick it up from the page and try again once.
async function fetchWithToken(url, opts) {
  const go = () => fetch(url, { ...opts, headers: { 'Content-Type': 'application/json', ...opts.headers, 'X-Clearsky-Token': csrf } });
  let res = await go();
  if (res.status === 403) {
    const fresh = (await (await fetch('/')).text()).match(/name="csrf" content="(\w+)"/)?.[1];
    if (fresh && fresh !== csrf) { csrf = fresh; res = await go(); }
  }
  return res;
}
const isHidden = (x) => Object.hasOwn(dismissed, x.dismissKey || x.url) && dismissed[x.dismissKey || x.url] === String(x.stamp ?? '');
// Snoozed until a set time, whatever happens on them (from the snooze menu): { key: until }.
let mutedMap = {};
const vis = (list) => (list || []).filter((x) => !isHidden(x) && !snoozedUntil(x.dismissKey || x.url));

// The sources with dismissed items taken out; the panels render from this.
let V = {}, hiddenCount = 0;
function view() {
  const keep = (src, ...lists) => {
    if (!src || src.error) return src;
    const out = { ...src };
    for (const l of lists) { out[l] = vis(src[l]); hiddenCount += (src[l] || []).length - out[l].length; }
    return out;
  };
  hiddenCount = 0;
  V = { g: keep(state.github, 'reviewRequested', 'myPrs', 'mentions', 'assigned'), j: keep(state.jira, 'assigned'),
    jm: keep(state.jiraMentions, 'tickets'), sl: keep(state.slack, 'mentions') };
}

async function post(url, body) {
  const res = await fetchWithToken(url, { method: 'POST', body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

async function dismiss(body) {
  try { ({ dismissed } = await post('/api/dismiss', body)); } catch (e) { $('#status').textContent = `Could not save: ${e.message}`; }
  renderToday();
  loadPlan();
}

// ---------------------------------------------------------------- building blocks

const skeleton = (n = 3) => Array.from({ length: n }, () => '<div class="sk-row"><div class="sk"></div><div class="sk"></div></div>').join('');

function refAttrs({ issue, pr }) {
  if (issue) return ` data-issue="${esc(issue)}"`;
  if (pr) return ` data-pr="${esc(pr)}"`;
  return '';
}

// A PR or Jira ticket from its link, to hand to Copilot.
// A PR, a GitHub issue ('gh') or a Jira ticket ('issue'), and the key sessions are linked by.
const refKeyOf = (r) => (r.kind === 'issue' ? `issue:${r.key}` : `${r.kind}:${r.repo}#${r.number}`);
function refFromUrl(url = '') {
  let m = url.match(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/);
  if (m) return { kind: 'pr', repo: m[1], number: Number(m[2]) };
  m = url.match(/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)/);
  if (m) return { kind: 'gh', repo: m[1], number: Number(m[2]) };
  m = url.match(/\/browse\/([A-Z][A-Z0-9_]+-\d+)/);
  return m ? { kind: 'issue', key: m[1] } : null;
}
function askButton(url, title) {
  return refFromUrl(url) ? `<button class="ask" data-ask="${esc(url)}" data-title="${esc(title)}" title="Copilot: ask about this or run a skill on it" aria-label="Copilot on this" aria-haspopup="menu">✦</button>` : '';
}

function row({ url, stamp, dismissKey, title, meta, badge, tone, quote, issue, pr, detail, src, key }) {
  return `<li class="row">
    ${isNew(dismissKey || url, stamp) ? '<span class="new-dot" title="New since you last looked" aria-label="New"></span>' : ''}
    ${badge ? `<span class="badge b-${tone || 'gray'}">${esc(badge)}</span>` : ''}
    <div class="main">
      <a class="title" href="${esc(url)}" target="_blank" rel="noopener"${refAttrs({ issue, pr })}${detail && src && key ? ` data-read="${esc(src)}" data-key="${esc(key)}"` : ''}>${esc(title)}</a>
      ${meta ? `<div class="meta">${esc(meta)}</div>` : ''}
      ${quote ? `<div class="quote">${esc(quote)}</div>` : ''}
      ${sessionChips(url)}
    </div>
    ${askButton(url, title)}
    <button class="hide" title="Dismiss until something new happens" aria-label="Dismiss" data-key="${esc(dismissKey || url)}" data-stamp="${esc(stamp ?? '')}">✕</button>
  </li>`;
}

const expanded = new Set();
function rows(id, items, render, limit = 8) {
  const html = items.map(render).filter(Boolean);
  if (!html.length) return '<div class="empty">Nothing here.</div>';
  const shown = expanded.has(id) ? html : html.slice(0, limit);
  const rest = html.length - shown.length;
  return `<ul class="rows">${shown.join('')}</ul>${rest > 0 ? `<button class="more" data-more="${id}">Show ${rest} more</button>` : ''}`;
}

// Which sources feed each panel, for its refresh button.
const PANEL_SOURCES = { plan: ['calendar'], 'c-review': ['github'], 'c-prs': ['github'], 'c-waiting': ['github'],
  'c-mentions': ['github', 'jiraMentions', 'slack'], 'c-left': ['jira', 'github'] };
const REFRESH_ICON = icon('refresh', 14);

function refreshButton(id) {
  const names = PANEL_SOURCES[id];
  if (!names) return '';
  const spinning = names.some((n) => loading.has(n)) || (id === 'plan' && loading.has('plan'));
  const times = names.map((n) => state[n]?.fetchedAt).filter(Boolean);
  const oldest = times.length ? times.sort()[0] : null;
  const tip = spinning ? 'Refreshing…' : `Refresh${oldest ? ` · updated ${ago(oldest)}` : ''} (Shift-click: everything)`;
  return `<button class="rf${spinning ? ' spin' : ''}" data-refresh="${id}" title="${tip}" aria-label="${tip}">${REFRESH_ICON}</button>`;
}

function card(el, title, count, body) {
  // A "needs you" panel with nothing in it steps back.
  el.classList.toggle('clear', count === 0 && !el.closest('.quiet'));
  el.innerHTML = `<div class="card-h"><h2>${esc(title)}</h2>${count != null ? `<span class="count">${count}</span>` : ''}${refreshButton(el.id)}</div>
    <div class="card-b">${body}</div>`;
}

const toneOf = { bad: 'red', warn: 'amber', good: 'green', wait: 'blue', neutral: 'gray' };
const prRef = (p) => `${p.repo}#${p.number}`;
