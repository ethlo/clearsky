// The chat's whole change in one pane (the chat header's Review), like Claude Code's diff view:
// every file its repo changed since the branch left the default branch, committed or not, and
// new files. Click a line number to comment on that line; the comments go to the chat box as
// one message, to send as is or add to. The server side is changeDiff (lib/app/chat-outputs.mjs).

const review = { data: null, comments: [], open: new Set() };

// One file's part of a unified diff, as rows with the line each one is (new side, else old).
function reviewFile(part, idx) {
  const name = part.path.split('/').pop();
  const rows = [];
  let a = 0, b = 0, started = false;
  for (const line of part.lines) {
    const h = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (h) { a = Number(h[1]); b = Number(h[2]); started = true; rows.push(`<div class="ln hunk"><i></i><i></i><span>${esc(h[3].trim() || '⋯')}</span></div>`); continue; }
    if (!started || !line || /^\\ No newline/.test(line)) continue;
    const k = line[0], body = line.slice(1), hl = hlLines(highlight(body, name))[0] || ' ';
    const row = (cls, oldN, newN, side, n) => `<div class="ln ${cls}" data-rf="${idx}" data-rl="${n}" data-rs="${side}"><i data-rc title="Comment on this line">${oldN ?? ''}</i><i data-rc title="Comment on this line">${newN ?? ''}</i><span>${hl}</span></div>${notesAt(idx, side, n)}`;
    if (k === '+') { rows.push(row('add', null, b, 'new', b)); b++; }
    else if (k === '-') { rows.push(row('del', a, null, 'old', a)); a++; }
    else { rows.push(row('', a, b, 'new', b)); a++; b++; }
  }
  return rows.join('');
}
function notesAt(f, side, n) {
  return review.comments.map((c, i) => [c, i]).filter(([c]) => c.f === f && c.side === side && c.line === n)
    .map(([c, i]) => `<div class="rv-note"><span>${esc(c.text)}</span><button type="button" data-rv-del="${i}" title="Remove this comment" aria-label="Remove">✕</button></div>`).join('');
}
// The diff split per file.
function splitDiff(diff) {
  const parts = [];
  for (const line of diff.split('\n')) {
    const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (m) { parts.push({ path: m[2], lines: [] }); continue; }
    parts.at(-1)?.lines.push(line);
  }
  return parts;
}
function drawReview() {
  const d = review.data, body = $('#rv-body');
  if (!d) return;
  const parts = splitDiff(d.diff || ''), stat = new Map((d.files || []).map((f) => [f.path, f]));
  review.parts = parts;
  const add = (d.files || []).reduce((n, f) => n + f.add, 0), del = (d.files || []).reduce((n, f) => n + f.del, 0);
  $('#rv-name').textContent = parts.length ? `${parts.length} file${parts.length === 1 ? '' : 's'} changed` : 'No changes';
  $('#rv-sub').textContent = parts.length ? `+${add} −${del} · against ${d.base}${d.cut ? ' · cut: too long to show all' : ''}` : '';
  body.innerHTML = !parts.length ? `<p class="rv-empty">${d.unsafe ? 'This repo’s git settings run programs of their own, so Clearsky doesn’t run git there while the chat’s sandbox is down.' : `Nothing differs from ${esc(d.base || 'the default branch')} in ${esc(tilde(d.root || d.cwd || ''))}.`}</p>`
    : parts.map((p, i) => {
      const s = stat.get(p.path) || {};
      const shut = !review.open.has(p.path) && parts.length > 6 && i > 0;
      return `<section class="rv-file${shut ? ' shut' : ''}" data-rv-file="${esc(p.path)}"><header data-rv-toggle><b>${esc(p.path)}</b>${s.new ? '<span class="rv-new">new</span>' : ''}<small><em class="a">+${s.add ?? ''}</em> <em class="d">−${s.del ?? ''}</em></small>${review.comments.some((c) => c.f === i) ? `<span class="rv-n">${review.comments.filter((c) => c.f === i).length}</span>` : ''}</header>
        ${shut ? '' : `<div class="code diff">${s.binary ? '<p class="rv-empty">A binary file.</p>' : reviewFile(p, i)}</div>`}</section>`;
    }).join('');
  const n = review.comments.length;
  $('#rv-send').disabled = !n;
  $('#rv-send').textContent = n ? `Put ${n} comment${n === 1 ? '' : 's'} in the chat box` : 'Click a line number to comment';
}
async function openReview() {
  if (!chat.session || !chat.turns) { $('#chat-sub').textContent = 'Nothing to review yet: send a message first.'; return; }
  $('#review').hidden = false;
  $('#rv-body').innerHTML = '<span class="typing">Loading</span>';
  $('#rv-name').textContent = 'Review'; $('#rv-sub').textContent = '';
  try {
    review.data = await getJson(`/api/copilot/change?chat=${encodeURIComponent(chat.session)}&cwd=${encodeURIComponent(chat.cwd || '')}`);
    if (review.data.cwd !== review.cwd) { review.comments = []; review.open = new Set(); review.cwd = review.data.cwd; }
    drawReview();
  } catch (e) { $('#rv-body').innerHTML = `<div class="err">${esc(e.message)}</div>`; }
}
const closeReview = () => { $('#review').hidden = true; };
$('#chat-review').onclick = openReview;
$('#rv-close').onclick = closeReview;
$('#rv-reload').onclick = openReview;
$('#review').addEventListener('click', (e) => {
  if (e.target.id === 'review') return closeReview();
  const t = e.target.closest('[data-rv-toggle]');
  if (t) { const p = t.closest('[data-rv-file]').dataset.rvFile; const sec = t.closest('.rv-file'); if (sec.classList.contains('shut')) review.open.add(p); else { review.open.delete(p); sec.classList.add('shut'); sec.querySelector('.code')?.remove(); return; } drawReview(); return; }
  const del = e.target.closest('[data-rv-del]');
  if (del) { review.comments.splice(Number(del.dataset.rvDel), 1); drawReview(); return; }
  const g = e.target.closest('[data-rc]');
  if (g) {
    const row = g.closest('.ln');
    $('#review .rv-edit')?.remove();
    const ed = document.createElement('div');
    ed.className = 'rv-edit';
    ed.innerHTML = `<textarea rows="2" data-talk spellcheck="true" placeholder="Your comment on this line" aria-label="Comment"></textarea><div><button type="button" class="ok" data-rv-save>Comment</button><button type="button" data-rv-cancel>Cancel</button></div>`;
    ed.dataset.f = row.dataset.rf; ed.dataset.l = row.dataset.rl; ed.dataset.s = row.dataset.rs; ed.dataset.code = row.querySelector('span').textContent;
    row.after(ed);
    ed.querySelector('textarea').focus();
    return;
  }
  if (e.target.closest('[data-rv-cancel]')) { e.target.closest('.rv-edit').remove(); return; }
  if (e.target.closest('[data-rv-save]')) saveReviewNote(e.target.closest('.rv-edit'));
});
$('#review').addEventListener('keydown', (e) => {
  const ed = e.target.closest('.rv-edit');
  if (ed && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveReviewNote(ed); }
  else if (ed && e.key === 'Escape') { e.stopPropagation(); ed.remove(); }
  else if (e.key === 'Escape') { e.stopPropagation(); closeReview(); }
});
function saveReviewNote(ed) {
  const text = ed.querySelector('textarea').value.trim();
  if (!text) { ed.remove(); return; }
  review.comments.push({ f: Number(ed.dataset.f), line: Number(ed.dataset.l), side: ed.dataset.s, code: ed.dataset.code.trim().slice(0, 120), text });
  drawReview();
}
// The comments as one message, in the order of the files and lines.
function reviewMessage() {
  const list = [...review.comments].sort((x, y) => x.f - y.f || x.line - y.line);
  return `Review comments on your change (against ${review.data.base}):\n\n${list.map((c) => `${review.parts[c.f]?.path} line ${c.line}${c.side === 'old' ? ' (a removed line)' : ''}${c.code ? ` (\`${c.code.replace(/`/g, "'")}\`)` : ''}:\n${c.text}`).join('\n\n')}`;
}
$('#rv-send').onclick = () => {
  if (!review.comments.length) return;
  const ta = $('#chat-text');
  ta.value = `${ta.value.trim() ? `${ta.value.trim()}\n\n` : ''}${reviewMessage()}`;
  review.comments = [];
  closeReview();
  ta.focus();
  ta.dispatchEvent(new Event('input'));
};
