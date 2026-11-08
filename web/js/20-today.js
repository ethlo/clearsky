// Clearsky page: Today (Now / Next), the calendar and the day as a schedule.
// The server joins web/js/*.js in name order into one script in index.html, so they share one scope.

// ---------------------------------------------------------------- Today

const MUTE_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="8" cy="8.5" r="5.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 5.5v3l2 1.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 2.5 1.8 3.7M13 2.5l1.2 1.2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
const when = (iso) => new Date(iso).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: hourCycle() });
const DONE_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3 8.5l3.2 3L13 4.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
let showLater = false;

// The small menu a mute button opens.
const menu = document.createElement('div');
menu.className = 'menu'; menu.hidden = true; menu.setAttribute('role', 'menu');
document.body.append(menu);
function openMuteMenu(btn) {
  const tomorrow = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
  menu.dataset.key = btn.dataset.mute;
  menu.innerHTML = `<div class="menu-h">Snooze until</div>
    ${[['1h', 'In 1 hour'], ['3h', 'In 3 hours'], ['tomorrow', 'Tomorrow’s stand-up'], ['week', 'In a week']]
      .map(([v, l]) => `<button role="menuitem" data-for="${v}">${l}</button>`).join('')}
    <label class="menu-date">On <input type="date" min="${tomorrow}"></label>`;
  menu.hidden = false;
  const r = btn.getBoundingClientRect();
  menu.style.top = `${r.bottom + window.scrollY + 6}px`;
  menu.style.left = `${Math.max(12, Math.min(r.right + window.scrollX - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 12))}px`;
  menu.querySelector('button').focus();
}
async function mute(key, span) {
  menu.hidden = true;
  try { ({ muted: mutedMap } = await post('/api/mute', { key, for: span })); } catch (e) { $('#status').textContent = `Could not save: ${e.message}`; }
  if (span && location.hash === '#item' && curItem?.k === key) back();
  renderToday();
  loadPlan();
}
menu.addEventListener('click', (e) => {
  const v = e.target.closest('[data-for]')?.dataset.for;
  if (v) return mute(menu.dataset.key, v);
  const rs = e.target.closest('[data-resume]');
  if (rs) { menu.hidden = true; openChat(true, true); return openSession(rs.dataset.resume, rs.dataset.cwd); }
  const sk = e.target.closest('[data-run]');
  if (sk) { menu.hidden = true; startCopilotOn({ ...refFromUrl(menu.dataset.ask), title: menu.dataset.title }, sk.dataset.run); }
  const ho = e.target.closest('[data-handoff]');
  if (ho) { menu.hidden = true; handOff({ ...refFromUrl(menu.dataset.ask), title: menu.dataset.title }, ho.dataset.handoff || null); }
});

// ✦ on a PR or ticket: ask about it, or run one of your skills on it in a new chat.
async function openAskMenu(btn) {
  menu.dataset.key = '';
  menu.dataset.ask = btn.dataset.ask;
  menu.dataset.title = btn.dataset.title;
  const draw = () => {
    const ref = refFromUrl(btn.dataset.ask);
    const skills = chat.info?.skills || [];
    const linked = cpLinks.links[itemKey(btn.dataset.ask)] || [];
    menu.innerHTML = `<div class="menu-h">Copilot on ${esc(refLabel(ref))}</div>
      ${linked.map((x) => `<button role="menuitem" data-resume="${esc(x.id)}" data-cwd="${esc(x.cwd || '')}">↩ Continue: ${esc(x.title.slice(0, 50))}${STATUS_TEXT[x.status] ? ` (${STATUS_TEXT[x.status]})` : ''}</button>`).join('')}
      <button role="menuitem" data-run="">${linked.length ? 'New chat: ask a question…' : 'Ask a question…'}</button>
      ${handoffMenu()}
      ${skills.length ? `<div class="menu-h">Run a skill</div>${skills.map((sk) => `<button role="menuitem" data-run="${esc(sk.name)}" title="${esc(sk.description || '')}">/${esc(sk.name)}</button>`).join('')}`
        : chat.info ? '' : '<div class="menu-h">Loading skills…</div>'}`;
  };
  draw();
  menu.hidden = false;
  const r = btn.getBoundingClientRect();
  menu.style.top = `${r.bottom + window.scrollY + 6}px`;
  menu.style.left = `${Math.max(12, Math.min(r.right + window.scrollX - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 12))}px`;
  menu.querySelector('button').focus();
  if (!chat.info) { await loadCopilotInfo(); if (!menu.hidden && menu.dataset.ask === btn.dataset.ask) draw(); }
}

// A new chat about one item; with a skill, it starts right away.
function startCopilotOn(ref, skill) {
  if (!chat.session || chat.turns || chat.stop) newChat();
  chat.refs = [];
  addRef(ref);
  openChat(true, true);
  if (skill) send(`/${skill}`);
}
menu.addEventListener('change', (e) => { if (e.target.type === 'date' && e.target.value) mute(menu.dataset.key, e.target.value); });
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-mute]');
  if (btn) { e.stopPropagation(); return menu.hidden || menu.dataset.key !== btn.dataset.mute ? openMuteMenu(btn) : (menu.hidden = true); }
  if (!e.target.closest('.menu')) menu.hidden = true;
  const un = e.target.closest('[data-unmute]')?.dataset.unmute;
  if (un) mute(un, null);
  const done = e.target.closest('[data-done]');
  if (done) { dismissed[done.dataset.done] = done.dataset.stamp; dismiss({ key: done.dataset.done, stamp: done.dataset.stamp, done: true }); }
  const undone = e.target.closest('[data-undone]')?.dataset.undone;
  if (undone) { delete dismissed[undone]; dismiss({ key: undone, stamp: null }); }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') menu.hidden = true; });

// What you're doing now, in a line: in the header of every list, and in full on the calendar.
const sameDay = (iso, d = new Date()) => new Date(iso).toDateString() === d.toDateString();
function nowLine() {
  const d = state.plan;
  if (!d?.plan) return '';
  const p = d.plan;
  if (p.now) return `<b>In ${esc(p.now.title)}</b> until ${hm(p.now.end)}`;
  if (p.afterHours) return 'Outside working hours';
  if (p.next && sameDay(p.next.start)) return `<b>Free until ${hm(p.next.start)}</b> · then ${esc(p.next.title)}`;
  return p.calendar ? '<b>Free</b> for the rest of the day' : '';
}
function renderNow() {
  const line = nowLine();
  for (const b of document.querySelectorAll('#nowline, [data-nowline]')) { b.innerHTML = line; b.hidden = !line; }
  const d = state.plan, su = d?.nextStandup && (Date.parse(d.nextStandup) - Date.now()) / 6e4;
  $('#su-alert').innerHTML = su !== undefined && su <= 30 && su > -15
    ? `<a class="standup-alert" href="#standup">Stand-up ${su > 0 ? `in ${Math.ceil(su)} min` : 'now'} · your summary is ready</a>` : '';
}
document.addEventListener('click', (e) => { if (e.target.closest('#nowline, [data-nowline]')) location.hash = '#calendar'; });

// ---------------------------------------------------------------- calendar

// Today and tomorrow as agendas, under the day schedule. A click on a meeting shows its details.
const openEvents = new Set();
function agendaRow(e, now) {
  const s = Date.parse(e.start), en = Date.parse(e.end), id = `${e.start}|${e.title}`;
  const cls = ['ag', e.fyi && 'fyi', en <= now && 'past', s <= now && now < en && 'on'].filter(Boolean).join(' ');
  const w = [dur(Math.round((en - s) / 6e4)), e.location, e.calendar].filter(Boolean).map(esc).join(' · ')
    + (e.url ? ` · <a class="join" href="${esc(e.url)}" target="_blank" rel="noopener">Join</a>` : '')
    + (e.fyi ? " · doesn't take your time" : '');
  const row = (k, v) => (v ? `<dt>${k}</dt><dd>${v}</dd>` : '');
  const more = openEvents.has(id) ? `<div class="more"><dl>${row('Organizer', esc(e.organizer || ''))}${row('People', e.attendees ? String(e.attendees) : '')}</dl>${esc(e.description || '')}</div>` : '';
  return `<div class="${cls}" data-agenda="${esc(id)}"><time>${hm(e.start)}</time><span class="t">${esc(e.title)}</span><span class="w">${w}</span>${more}</div>`;
}
function renderCalendar() {
  const el = $('#cal'), d = state.plan;
  if (!d) { el.innerHTML = `<div class="sk" style="width:40%;height:18px"></div>${skeleton(4)}`; return; }
  if (d.error) { el.innerHTML = `<div class="err">${esc(d.error)}</div>`; return; }
  const p = d.plan, now = Date.now(), join = (e) => (e?.url ? ` · <a class="join" href="${esc(e.url)}" target="_blank" rel="noopener">Join</a>` : '');
  let line, sub = '';
  if (p.now) {
    line = `In ${esc(p.now.title)} until ${hm(p.now.end)}`;
    sub = `Then free for ${dur(p.freeMinutes)}${p.next ? `, before ${esc(p.next.title)} at ${hm(p.next.start)}` : ''}${join(p.now)}`;
  } else if (p.afterHours) {
    line = 'Outside working hours';
  } else {
    const today = p.next && sameDay(p.next.start);
    line = today ? `Free until ${hm(p.next.start)}` : 'Free for the rest of the day';
    sub = today ? `${dur(p.freeMinutes)}, then ${esc(p.next.title)}${join(p.next)}`
      : p.next ? `No more meetings today. Next: ${esc(p.next.title)}, ${when(p.next.start)}.`
      : p.calendar ? 'No more meetings today.' : '<a href="/settings">Connect your calendar in Settings</a> to plan around meetings.';
  }
  $('#cal-sub').textContent = new Date().toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
  const cal = state.calendar || {};
  const calErr = cal.error ? `<div class="err" style="margin:12px 0">Calendar: ${esc(cal.error)}</div>`
    : cal.errors ? `<div style="margin-top:12px;font-size:12px;color:var(--muted)">Calendar (${esc(cal.source)}) loaded; skipped ${Object.entries(cal.errors).map(([n, m]) => `${esc(n)}: ${esc(m)}`).join('; ')}</div>` : '';
  // Today, with a line for where you are now.
  const evs = p.day?.events || [];
  let nowShown = false;
  const today = evs.map((e) => {
    let pre = '';
    if (!nowShown && Date.parse(e.start) > now && !p.now && !p.afterHours) {
      nowShown = true;
      pre = `<div class="ag nowrow"><time>${hm(new Date())}</time><span class="t">Now${p.freeMinutes ? ` · free for ${dur(p.freeMinutes)}` : ''}</span></div>`;
    }
    return pre + agendaRow(e, now);
  }).join('') || '<div class="empty" style="padding-left:8px">No meetings today.</div>';
  // Tomorrow, from the calendar itself (the plan only covers today), without hidden calendars.
  const hidden = new Set((p.calendars || []).filter((c) => c.hidden).map((c) => c.name));
  const t0 = new Date(); t0.setHours(24, 0, 0, 0);
  const tomorrow = (cal.events || []).filter((e) => !e.allDay && !hidden.has(e.calendar) && sameDay(e.start, t0));
  const allDay = (cal.events || []).filter((e) => e.allDay && !hidden.has(e.calendar) && sameDay(e.start, t0));
  el.innerHTML = `<div class="now-big">${line}</div><div class="now-sub">${sub}</div>${calErr}${dayHtml(p)}
    <div class="cal-cols">
      <div><h3>Today</h3>${today}</div>
      <div><h3>${esc(t0.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' }))}</h3>
        ${allDay.length ? `<div class="ag"><time>All day</time><span class="t">${allDay.map((e) => esc(e.title)).join(' · ')}</span></div>` : ''}
        ${tomorrow.map((e) => agendaRow(e, now)).join('') || '<div class="empty" style="padding-left:8px">No meetings.</div>'}</div>
    </div>`;
  const sc = el.querySelector('.day-scroll'), nl = el.querySelector('.day-now');
  if (sc && nl && sc.scrollWidth > sc.clientWidth) sc.scrollLeft = nl.offsetLeft - sc.clientWidth / 3;
}
document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-agenda]');
  if (!a || e.target.closest('a')) return;
  const id = a.dataset.agenda;
  if (!openEvents.delete(id)) openEvents.add(id);
  renderCalendar();
});

// ---------------------------------------------------------------- today as a schedule

const CAL_COLORS = ['var(--accent)', 'var(--green)', 'var(--violet)', 'var(--amber)', 'var(--red)', 'var(--muted)'];
let dayEvents = [];
function calColor(p, name) {
  const names = (p.calendars || []).map((c) => c.name);
  const ordered = [...new Set([...(p.day?.events || []).filter((e) => e.work).map((e) => e.calendar), ...names])];
  const i = ordered.indexOf(name);
  return CAL_COLORS[(i < 0 ? ordered.length : i) % CAL_COLORS.length];
}

// A strip from the first thing in the day (or 08:00) to the end of the workday (or the last
// event), with meetings as blocks, overlaps on separate lanes, the free slot and a now line.
function dayHtml(p) {
  const day = p.day;
  if (!day || (!p.calendar && !day.events.length)) return '';
  const now = Date.now(), base = new Date(); base.setHours(0, 0, 0, 0);
  const at = (h) => +base + h * 36e5;
  const evs = day.events.map((e, i) => ({ ...e, i, s: Date.parse(e.start), e: Date.parse(e.end) }));
  let from = Math.min(at(8), ...evs.map((e) => e.s)), to = Math.max(Date.parse(day.workdayEnd) || at(17), ...evs.map((e) => e.e), at(12));
  from = Math.max(+base, Math.floor((from - +base) / 36e5) * 36e5 + +base);
  to = Math.min(at(24), Math.ceil((to - +base) / 36e5) * 36e5 + +base);
  const span = to - from, pct = (t) => `${((Math.min(Math.max(t, from), to) - from) / span) * 100}%`;
  const hours = Math.round(span / 36e5);
  // Lanes: each event takes the first lane free at its start.
  const ends = [];
  for (const e of evs) {
    let lane = ends.findIndex((end) => end <= e.s);
    if (lane < 0) { lane = ends.length; ends.push(0); }
    ends[lane] = e.e; e.lane = lane;
  }
  const lanes = Math.max(1, ends.length);
  dayEvents = evs;
  const ticks = Array.from({ length: hours + 1 }, (_, h) => from + h * 36e5)
    .filter((t, i) => hours <= 12 || i % 2 === 0)
    .map((t) => `<span style="left:${pct(t)}">${new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: hourCycle() === 'h12' ? undefined : '2-digit', hourCycle: hourCycle() })}</span>`).join('');
  const free = !p.afterHours && p.freeMinutes > 0 && Date.parse(p.freeUntil) > from
    ? `<div class="day-free" style="left:${pct(Date.parse(p.freeFrom))};width:calc(${pct(Date.parse(p.freeUntil))} - ${pct(Date.parse(p.freeFrom))})" title="Free: ${hm(p.freeFrom)}–${hm(p.freeUntil)}"></div>` : '';
  const off = Date.parse(day.workdayEnd) < to ? `<div class="day-off" style="left:${pct(Date.parse(day.workdayEnd))};right:0" title="After your workday"></div>` : '';
  const blocks = evs.map((e) => {
    const short = e.e - e.s < 20 * 6e4;
    const cls = ['ev', e.fyi && 'fyi', e.e <= now && 'past', e.s <= now && now < e.e && 'on', short && 'short'].filter(Boolean).join(' ');
    return `<button class="${cls}" data-ev="${e.i}" style="--c:${calColor(p, e.calendar)};left:${pct(e.s)};width:max(6px, calc(${pct(e.e)} - ${pct(e.s)} - 2px));top:${e.lane * 28 + 2}px"
      aria-label="${esc(`${hm(e.start)}–${hm(e.end)} ${e.title}`)}">${short ? '' : esc(e.title)}</button>`;
  }).join('');
  const nowLine = now > from && now < to ? `<div class="day-now" style="left:${pct(now)}" title="Now, ${hm(new Date())}"></div>` : '';
  const allDay = day.allDay.length ? `<span class="allday">All day: ${day.allDay.map((e) => esc(e.title)).join(' · ')}</span>` : '';
  const cals = (p.calendars || []).length > 1 || (p.calendars || []).some((c) => c.hidden)
    ? (p.calendars || []).map((c) => `<button class="cal-tog${c.hidden ? ' off' : ''}" data-cal="${esc(c.name)}" style="--c:${calColor(p, c.name)}"
        title="${c.hidden ? 'Hidden: click to show' : 'Click to hide'} (hidden calendars don't take your time either)" aria-pressed="${!c.hidden}"><i></i>${esc(c.name)}</button>`).join('') : '';
  const empty = !evs.length ? '<span>No meetings today.</span>' : '';
  return `<div class="day"><div class="day-scroll"><div class="day-axis" style="--hour-w:calc(100% / ${hours})">
      <div class="day-hours">${ticks}</div>
      <div class="day-lanes" style="height:${lanes * 28 + 4}px">${free}${off}${blocks}${nowLine}</div>
    </div></div>
    <div class="day-foot">${empty}${allDay}${cals}</div></div>`;
}

// Details on hover (or focus); a click keeps them open so links work.
let evPop = null, evPinned = null, evHideTimer = 0;
function showEvent(btn, pin) {
  const e = dayEvents[Number(btn.dataset.ev)];
  if (!e) return;
  clearTimeout(evHideTimer);
  evPop ||= Object.assign(document.createElement('div'), { className: 'ev-pop', role: 'dialog' });
  const row = (k, v) => (v ? `<dt>${k}</dt><dd>${v}</dd>` : '');
  evPop.innerHTML = `<h4>${esc(e.title)}</h4>
    <div class="when">${hm(e.start)}–${hm(e.end)} · ${dur(Math.round((Date.parse(e.end) - Date.parse(e.start)) / 6e4))}</div>
    <dl>${row('Calendar', esc(e.calendar || ''))}${row('Where', esc(e.location || ''))}${row('Organizer', esc(e.organizer || ''))}
      ${row('People', e.attendees ? String(e.attendees) : '')}${row('Join', e.url ? `<a class="join" href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.url.replace(/^https?:\/\//, '').slice(0, 40))}</a>` : '')}</dl>
    ${e.description ? `<div class="desc">${esc(e.description)}</div>` : ''}
    ${e.read ? `<div class="acts-row"><button class="icon-btn" data-read-src="${esc(e.read.src)}" data-read-key="${esc(e.read.key)}">Open the message</button></div>` : ''}
    ${e.read ? '<div class="note">From a weekly plan, read by Clearsky: shown, but doesn\'t take your time.</div>'
      : e.fyi ? '<div class="note">On a shared calendar, added by someone else: shown, but doesn\'t take your time.</div>' : ''}`;
  document.body.append(evPop);
  const r = btn.getBoundingClientRect(), w = evPop.offsetWidth, h = evPop.offsetHeight;
  const left = Math.min(Math.max(16, r.left), innerWidth - w - 16);
  const top = r.bottom + 6 + h > innerHeight - 8 ? Math.max(8, r.top - h - 6) : r.bottom + 6;
  Object.assign(evPop.style, { left: `${left}px`, top: `${top}px` });
  document.querySelectorAll('.ev.pinned').forEach((b) => b.classList.remove('pinned'));
  evPinned = pin ? btn : null;
  if (pin) btn.classList.add('pinned');
}
function hideEvent(force) {
  if (evPinned && !force) return;
  evPinned?.classList.remove('pinned'); evPinned = null;
  evPop?.remove();
}
document.addEventListener('mouseover', (e) => {
  const b = e.target.closest?.('.ev');
  if (b && !evPinned) showEvent(b, false);
  else if (e.target.closest?.('.ev-pop')) clearTimeout(evHideTimer);
});
document.addEventListener('mouseout', (e) => {
  if (!e.target.closest?.('.ev, .ev-pop') || evPinned) return;
  if (e.relatedTarget?.closest?.('.ev-pop, .ev')) return;
  evHideTimer = setTimeout(() => hideEvent(false), 150);
});
document.addEventListener('focusin', (e) => { const b = e.target.closest?.('.ev'); if (b && !evPinned) showEvent(b, false); });
document.addEventListener('click', async (e) => {
  const b = e.target.closest('.ev');
  if (b) { if (evPinned === b) hideEvent(true); else showEvent(b, true); return; }
  const r = e.target.closest('[data-read-key]');
  if (r) { hideEvent(true); openReader(r.dataset.readSrc, r.dataset.readKey); return; }
  if (!e.target.closest('.ev-pop')) hideEvent(true);
  const t = e.target.closest('.cal-tog');
  if (!t) return;
  t.disabled = true;
  try {
    await post('/api/calendar/hidden', { name: t.dataset.cal, hidden: !t.classList.contains('off') });
    await loadPlan();
  } catch (err) { $('#status').textContent = `Could not save: ${err.message}`; }
  t.disabled = false;
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && evPop?.isConnected) hideEvent(true); });
