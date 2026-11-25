// Clearsky page: scheduled chats. A message Clearsky sends to a new sandboxed chat at set times
// ("weekdays 08:30: check CI on my PRs"), like Claude Code's scheduled tasks (lib/schedules.mjs).
// Each run is an ordinary chat: what leaves the sandbox still waits for your OK.

let schedData = { schedules: [], running: [], sandbox: true };
let schedEdit = null; // the schedule being changed ('new' for a new one)
const SC_TEXT = { working: ['Running', 'green'], 'needs-you': ['Needs your OK', 'amber'], done: ['Done', 'green'], failed: ['Didn’t run', 'red'], missed: ['Missed', 'gray'], stopped: ['Stopped', 'amber'] };

async function loadSchedules() {
  try { schedData = await getJson('/api/schedules'); } catch { return; }
  drawSchedules();
}
const whenAt = (iso) => { const d = new Date(iso); return sameDay(iso) ? hm(iso) : `${d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })} ${hm(iso)}`; };

function schedForm(s) {
  const v = s || { name: '', whenText: 'weekdays 08:30', cwd: '', prompt: '' };
  return `<form class="sc-form" data-sc-form="${esc(s?.id || 'new')}">
    <label>Name<input name="name" required maxlength="80" value="${esc(v.name)}" placeholder="Morning CI check"></label>
    <label>When<input name="when" required value="${esc(v.whenText)}" placeholder="weekdays 08:30"><small>weekdays 08:30 · daily 7:00 · mon,thu 16:15 · every 2h</small></label>
    <label>Folder<input name="cwd" value="${esc(v.cwd || '')}" placeholder="${esc(chat.cwd || '~/dev/your-repo')} (optional)"><small>Where the chat works; empty: your first folder.</small></label>
    <label class="wide">What the chat should do<textarea name="prompt" required rows="4" data-talk spellcheck="true" placeholder="Check CI on my open PRs. For each failing one, find the cause and say what you'd change. Don't push anything.">${esc(v.prompt)}</textarea></label>
    <div class="sc-fb"><button type="submit" class="icon-btn small primary">${s ? 'Save' : 'Add schedule'}</button><button type="button" class="icon-btn small" data-sc-cancel>Cancel</button><span class="sc-err"></span></div></form>`;
}

function drawSchedules() {
  const el = $('#schedules');
  if (!el || $('#v-schedules').hidden) return;
  const list = schedData.schedules || [];
  $('#sc-sub').textContent = list.length ? `${list.filter((s) => !s.paused).length} on` : '';
  const warn = schedData.sandbox ? '' : '<div class="err">Scheduled chats run only in the sandbox, and it isn’t installed here. See <a href="/welcome">the set-up check</a>.</div>';
  const rows = list.map((s) => {
    if (schedEdit === s.id) return `<div class="sc-r">${schedForm(s)}</div>`;
    const last = s.runs?.[0];
    const [txt, tone] = last ? SC_TEXT[last.status] || [last.status, 'gray'] : [];
    const running = (schedData.running || []).includes(s.id);
    return `<div class="sc-r${s.paused ? ' paused' : ''}"><div class="ho-m"><div class="ho-t">${esc(s.name)} <span class="sc-when">${icon('clock', 12)}${esc(s.whenText)}</span></div>
      <div class="ho-s">${s.paused ? 'Paused' : s.next ? `Next ${esc(whenAt(s.next))}` : ''}${s.cwd ? ` · ${esc(tilde(s.cwd))}` : ''}
        ${last ? ` · Last <span class="lbl ${tone}"><i></i>${esc(txt)}</span> ${esc(ago(last.at))}` : ''}</div>
      ${last?.note ? `<div class="sc-note">${esc(last.note)}</div>` : ''}</div>
      <div class="ho-a">${last?.session ? `<button class="icon-btn small" data-ho-chat="${esc(last.session)}" data-cwd="${esc(last.cwd || s.cwd || '')}">Open chat</button>` : ''}
        <button class="icon-btn small" data-sc="run" data-id="${esc(s.id)}"${running ? ' disabled' : ''}>${running ? 'Running…' : 'Run now'}</button>
        <button class="icon-btn small" data-sc="${s.paused ? 'resume' : 'pause'}" data-id="${esc(s.id)}">${s.paused ? 'Resume' : 'Pause'}</button>
        <button class="icon-btn small" data-sc-edit="${esc(s.id)}">Edit</button>
        <button class="icon-btn small only" data-sc="remove" data-id="${esc(s.id)}" title="Remove this schedule" aria-label="Remove">✕</button></div></div>`;
  }).join('');
  el.innerHTML = warn + (schedEdit === 'new' ? `<div class="sc-r">${schedForm(null)}</div>` : '')
    + (list.length ? rows : schedEdit === 'new' ? '' : `<div class="empty">No scheduled chats yet. A schedule sends a message to a new chat in the sandbox at the times you pick: a morning check of CI on your PRs, a weekly look for dependency updates, a sweep of flaky tests. Each run shows up in Work and History like any chat, and anything that leaves the sandbox waits for your OK.</div>`);
}

$('#sc-new').onclick = () => { schedEdit = 'new'; drawSchedules(); $('#schedules [name=name]')?.focus(); };
document.addEventListener('click', async (e) => {
  if (e.target.closest('[data-sc-cancel]')) { schedEdit = null; drawSchedules(); return; }
  const ed = e.target.closest('[data-sc-edit]');
  if (ed) { schedEdit = ed.dataset.scEdit; drawSchedules(); return; }
  const b = e.target.closest('[data-sc]');
  if (!b) return;
  b.disabled = true;
  try {
    const r = await post('/api/schedules', { action: b.dataset.sc, id: b.dataset.id });
    if (b.dataset.sc === 'run') { $('#status').textContent = 'Started: its chat shows up in Work in a moment'; setTimeout(loadSchedules, 1500); }
    else { schedData.schedules = r.schedules; drawSchedules(); }
  } catch (err) { $('#status').textContent = err.message; b.disabled = false; }
});
document.addEventListener('submit', async (e) => {
  const f = e.target.closest('[data-sc-form]');
  if (!f) return;
  e.preventDefault();
  const id = f.dataset.scForm, d = Object.fromEntries(new FormData(f));
  try {
    const r = await post('/api/schedules', { action: id === 'new' ? 'add' : 'edit', id, schedule: { name: d.name, when: d.when, cwd: d.cwd ? untildeHome(d.cwd) : '', prompt: d.prompt } });
    schedEdit = null; schedData.schedules = r.schedules; drawSchedules();
  } catch (err) { f.querySelector('.sc-err').textContent = err.message; }
});
// "~/dev/x" as typed: the server wants the full path.
function untildeHome(p) { return p.startsWith('~/') && chat.home ? `${chat.home}${p.slice(1)}` : p; }
setInterval(() => { if (!document.hidden && !$('#v-schedules').hidden && !schedEdit) loadSchedules(); }, 15_000);
