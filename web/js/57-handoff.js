// Clearsky page: hand-offs. ✦ on a PR or ticket → Hand off, and Copilot works on it by itself,
// one at a time, in the sandbox, now or from your next meeting (lib/handoff.mjs on the server).
// The Hand-offs page shows where each is, with its chat and the draft PR it ended with.
// The server joins web/js/*.js in name order into one script in index.html, so they share one scope.

let handoffData = { handoffs: [], sandbox: true };
const HO_TEXT = { queued: ['Waiting', 'gray'], working: ['Working', 'green'], 'needs-you': ['Needs your OK', 'amber'], done: ['Done', 'green'], blocked: ['Needs you', 'amber'],
  failed: ['Didn’t start', 'red'], stopped: ['Stopped', 'amber'], cancelled: ['Cancelled', 'gray'] };

// The ✦ menu's part: now, or at your next meeting today (you're away anyway).
function handoffMenu() {
  const next = state.plan?.plan?.next;
  const at = next && Date.parse(next.start) > Date.now() && sameDay(next.start) ? next.start : null;
  return `<div class="menu-h">Hand off to Copilot</div>
    <button role="menuitem" data-handoff="" title="Copilot works on it by itself in the sandbox, and ends with a draft PR or a note">Work on it now, by itself</button>
    ${at ? `<button role="menuitem" data-handoff="${esc(at)}">From my next meeting (${esc(hm(at))})</button>` : ''}`;
}

async function handOff(ref, after) {
  if (!ref?.kind) return;
  try {
    const r = await post('/api/handoffs', { action: 'add', ref, after });
    handoffData.handoffs = r.handoffs;
    $('#status').textContent = r.already ? `${r.handoff.label} is handed off already` : after ? `Handed off ${r.handoff.label}: starts at ${hm(after)}` : `Handed off ${r.handoff.label}`;
    drawHandoffs();
  } catch (e) { $('#status').textContent = `Could not hand off: ${e.message}`; }
}

async function loadHandoffs() {
  try { handoffData = await getJson('/api/handoffs'); } catch { return; }
  drawHandoffs();
}

function drawHandoffs() {
  const list = [...(handoffData.handoffs || [])].reverse();
  const open = list.filter((h) => ['queued', 'working', 'needs-you'].includes(h.status));
  const hot = list.filter((h) => h.status === 'needs-you' || h.status === 'blocked').length;
  const n = $('#n-handoffs');
  if (n) { n.textContent = open.length || hot || ''; n.classList.toggle('hot', !!hot); }
  const el = $('#handoffs');
  if (!el || $('#v-handoffs').hidden) return;
  $('#ho-sub').textContent = open.length ? `${open.length} open, one at a time` : '';
  const warn = handoffData.sandbox ? '' : '<div class="err">Hand-offs run only in the sandbox, and it isn’t installed here. See <a href="/welcome">the set-up check</a>.</div>';
  if (!list.length) {
    el.innerHTML = `${warn}<div class="empty">Nothing handed off yet. On a PR or ticket, click ✦ and pick <b>Work on it now, by itself</b>, or <b>From my next meeting</b>. Copilot works in the sandbox, runs the tests and a review, and opens a draft PR, which then waits under Your PRs as not read by you. It never merges, approves or deletes anything.</div>`;
    return;
  }
  el.innerHTML = warn + list.map((h) => {
    const [txt, tone] = HO_TEXT[h.status] || [h.status, 'gray'];
    const when = h.status === 'queued' && h.after ? `starts ${hm(h.after)}` : h.endedAt ? `ended ${ago(h.endedAt)}` : h.startedAt ? `started ${ago(h.startedAt)}` : `added ${ago(h.addedAt)}`;
    const key = h.ref.kind === 'issue' ? `issue:${h.ref.key}` : `${h.ref.kind}:${h.ref.repo}#${h.ref.number}`;
    const acts = [
      h.session && `<button class="icon-btn small" data-ho-chat="${esc(h.session)}" data-cwd="${esc(h.cwd || '')}">Open chat</button>`,
      h.pr && `<a class="icon-btn small primary" href="${esc(h.pr)}" data-open-key="${esc(itemKey(h.pr) || '')}">Draft PR</a>`,
      h.status === 'queued' && h.after && `<button class="icon-btn small" data-ho="start" data-id="${esc(h.id)}">Start now</button>`,
      h.status === 'queued' && `<button class="icon-btn small" data-ho="cancel" data-id="${esc(h.id)}">Cancel</button>`,
      ['failed', 'stopped', 'blocked', 'cancelled'].includes(h.status) && `<button class="icon-btn small" data-ho="retry" data-id="${esc(h.id)}">Try again</button>`,
      !['working', 'needs-you'].includes(h.status) && `<button class="icon-btn small only" data-ho="forget" data-id="${esc(h.id)}" title="Remove from this list" aria-label="Remove">✕</button>`,
    ].filter(Boolean).join('');
    return `<div class="ho-r"><div class="ho-m"><div class="ho-t"><a href="#" data-open-key="${esc(key)}">${esc(h.label)}</a> ${esc(h.ref.title || '')}</div>
      <div class="ho-s"><span class="lbl ${tone}"><i></i>${esc(txt)}</span> ${esc(when)}${h.note ? ` · ${esc(h.note)}` : ''}</div></div><div class="ho-a">${acts}</div></div>`;
  }).join('');
}

document.addEventListener('click', async (e) => {
  const c = e.target.closest('[data-ho-chat]');
  if (c) { openChat(true, true); openSession(c.dataset.hoChat, c.dataset.cwd); return; }
  const b = e.target.closest('[data-ho]');
  if (!b) return;
  try { handoffData.handoffs = (await post('/api/handoffs', { action: b.dataset.ho, id: b.dataset.id })).handoffs; drawHandoffs(); }
  catch (err) { $('#status').textContent = err.message; }
});

loadHandoffs();
// Fresh while something runs or this page is open; otherwise once a minute for the count.
setInterval(() => {
  if (document.hidden) return;
  const busy = (handoffData.handoffs || []).some((h) => ['queued', 'working', 'needs-you'].includes(h.status));
  if (busy || !$('#v-handoffs').hidden) loadHandoffs();
}, 15_000);
setInterval(() => { if (!document.hidden) loadHandoffs(); }, 60_000);
