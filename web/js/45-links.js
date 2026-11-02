// ---------------------------------------------------------------- links

// Your favourites (lib/links.mjs), in groups: #links shows the Work groups, #links-personal the
// Personal ones. Edit renames, moves and removes in place; Add link, a dropped link or Import
// bookmarks add. Every change is saved at once to ~/.config/clearsky/links.json.
let linksDoc = null, linksArea = 'work', linksEditing = false;

async function loadLinks() {
  try { linksDoc = await getJson('/api/links'); } catch { linksDoc ??= { groups: [] }; }
  personalSide();
  return linksDoc;
}
// The Personal heading shows when there's anything personal: a source, or links.
function personalSide() {
  const has = !!linksDoc?.groups.some((g) => g.area === 'personal' && g.links.length);
  const nav = $('#nav-links-personal');
  if (nav) nav.hidden = !has;
  $('#side-personal-h').hidden = !(has || extraSources.some((x) => x.area === 'personal'));
}
async function saveLinksDoc() {
  try { linksDoc = await post('/api/links', linksDoc); } catch (e) { $('#status').textContent = `Could not save the links: ${e.message}`; }
  personalSide();
  drawLinks();
}

async function renderLinks(area) {
  linksArea = area;
  $('#links-title').textContent = area === 'personal' ? 'Personal links' : 'Links';
  if (!linksDoc) { $('#links').innerHTML = skeleton(3); await loadLinks(); }
  drawLinks();
}

const linkHost = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
// A small square with the link's first letter, in its site's colour; no favicon is fetched,
// so opening this page tells no site what's in your links.
function linkBadge(u, title = '') {
  const h = linkHost(u);
  let n = 0;
  for (const c of h) n = (n * 31 + c.charCodeAt(0)) >>> 0;
  return `<span class="lk-badge" style="--h:${n % 360}">${esc((title.match(/[\p{L}\p{N}]/u)?.[0] || h[0] || '?').toUpperCase())}</span>`;
}

function drawLinks() {
  const el = $('#links');
  if (!linksDoc) return;
  const q = $('#links-filter').value.trim().toLowerCase();
  const groups = linksDoc.groups.map((g, gi) => ({ ...g, gi })).filter((g) => g.area === linksArea);
  $('#links-edit').textContent = linksEditing ? 'Done' : 'Edit';
  $('#links-edit').hidden = !groups.length;
  $('#links-groups').innerHTML = groups.map((g) => `<option value="${esc(g.name)}">`).join('');
  if (!groups.length) {
    el.innerHTML = `<div class="empty">No ${linksArea === 'personal' ? 'personal ' : ''}links yet. <b>Add link</b>, drop a link from your browser here, or <b>Import bookmarks</b> from an HTML export of your browser's bookmarks.${linksArea === 'work' ? ' A group can be moved to Personal in Edit.' : ''}</div>`;
    return;
  }
  if (linksEditing) { el.innerHTML = groups.map(editGroup).join(''); return; }
  const shown = groups.map((g) => ({ ...g, links: g.links.filter((l) => !q || `${l.title} ${l.url} ${g.name}`.toLowerCase().includes(q)) })).filter((g) => g.links.length);
  el.innerHTML = shown.length ? shown.map((g) => `<section class="lk-group"><h2>${esc(g.name)}<small>${g.links.length}</small></h2><ul>${g.links.map((l) => `<li><a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer" title="${esc(l.url)}">${linkBadge(l.url, l.title)}<span class="lk-t">${esc(l.title)}<small>${esc(linkHost(l.url))}</small></span></a></li>`).join('')}</ul></section>`).join('')
    : '<div class="empty">No links match.</div>';
}

function editGroup(g) {
  const gi = g.gi;
  return `<section class="lk-group editing" data-g="${gi}">
    <h2><input value="${esc(g.name)}" data-gname aria-label="Group name">
      <select data-garea aria-label="Side"><option value="work"${g.area === 'work' ? ' selected' : ''}>Work</option><option value="personal"${g.area === 'personal' ? ' selected' : ''}>Personal</option></select>
      <button type="button" class="icon-btn small" data-gmove="-1" title="Move the group up" aria-label="Move the group up">↑</button><button type="button" class="icon-btn small" data-gmove="1" title="Move the group down" aria-label="Move the group down">↓</button>
      <button type="button" class="icon-btn small" data-gdel title="Remove the group and its links">Remove group</button></h2>
    <ul>${g.links.map((l, li) => `<li data-l="${li}"><input value="${esc(l.title)}" data-ltitle aria-label="Name"><input value="${esc(l.url)}" data-lurl type="url" aria-label="Address">
      <button type="button" class="icon-btn small" data-lmove="-1" aria-label="Up">↑</button><button type="button" class="icon-btn small" data-lmove="1" aria-label="Down">↓</button><button type="button" class="icon-btn small" data-ldel aria-label="Remove">✕</button></li>`).join('')}</ul></section>`;
}

// Adds a link to a group of this side, made if it isn't there.
function addLink({ url, title, group }) {
  const name = (group || '').trim() || linksDoc.groups.find((g) => g.area === linksArea)?.name || 'Links';
  let g = linksDoc.groups.find((x) => x.area === linksArea && x.name === name);
  if (!g) linksDoc.groups.push(g = { name, area: linksArea, links: [] });
  g.links.push({ url: url.trim(), title: (title || '').trim() });
}

function showLinkForm(url = '', title = '') {
  const form = $('#links-form'), f = form.elements;
  form.hidden = false;
  f.url.value = url; f.label.value = title;
  (url ? f.label : f.url).focus();
}
$('#links-add').addEventListener('click', () => showLinkForm());
$('#links-cancel').addEventListener('click', () => { $('#links-form').hidden = true; });
$('#links-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const form = e.target, f = form.elements;
  if (!/^https?:\/\//i.test(f.url.value.trim())) { f.url.setCustomValidity('An http or https address'); f.url.reportValidity(); return; }
  addLink({ url: f.url.value, title: f.label.value, group: f.group.value });
  form.hidden = true; form.reset();
  saveLinksDoc();
});
$('#links-form').elements.url.addEventListener('input', (e) => e.target.setCustomValidity(''));
$('#links-edit').addEventListener('click', () => { linksEditing = !linksEditing; drawLinks(); });
$('#links-filter').addEventListener('input', drawLinks);

// Editing: names and addresses save when you leave the field; buttons save at once.
$('#links').addEventListener('change', (e) => {
  const gEl = e.target.closest('[data-g]');
  if (!gEl) return;
  const g = linksDoc.groups[+gEl.dataset.g];
  if (e.target.matches('[data-gname]')) g.name = e.target.value;
  else if (e.target.matches('[data-garea]')) g.area = e.target.value;
  else {
    const l = g.links[+e.target.closest('[data-l]').dataset.l];
    if (e.target.matches('[data-ltitle]')) l.title = e.target.value;
    if (e.target.matches('[data-lurl]')) {
      if (!/^https?:\/\//i.test(e.target.value.trim())) { e.target.value = l.url; return; }
      l.url = e.target.value.trim();
    }
  }
  saveLinksDoc();
});
$('#links').addEventListener('click', (e) => {
  const b = e.target.closest('button'), gEl = e.target.closest('[data-g]');
  if (!b || !gEl) return;
  const gs = linksDoc.groups, gi = +gEl.dataset.g, g = gs[gi];
  const swap = (list, i, j) => { if (j >= 0 && j < list.length) [list[i], list[j]] = [list[j], list[i]]; };
  if (b.matches('[data-gdel]')) {
    if (g.links.length && !confirm(`Remove “${g.name}” and its ${g.links.length} link${g.links.length > 1 ? 's' : ''}?`)) return;
    gs.splice(gi, 1);
  } else if (b.matches('[data-gmove]')) {
    // Up or down among this side's groups.
    const same = gs.map((x, i) => i).filter((i) => gs[i].area === g.area), at = same.indexOf(gi);
    const to = same[at + +b.dataset.gmove];
    if (to == null) return;
    swap(gs, gi, to);
  } else {
    const li = +e.target.closest('[data-l]').dataset.l;
    if (b.matches('[data-ldel]')) g.links.splice(li, 1);
    else if (b.matches('[data-lmove]')) swap(g.links, li, li + +b.dataset.lmove);
  }
  saveLinksDoc();
});

// A link dragged from the browser (address bar, a page, a tab) onto the page.
$('#v-links').addEventListener('dragover', (e) => { if ([...e.dataTransfer.types].some((t) => t === 'text/uri-list' || t === 'text/plain')) e.preventDefault(); });
$('#v-links').addEventListener('drop', (e) => {
  const url = (e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain')).split('\n').find((x) => /^https?:\/\//i.test(x.trim()));
  if (!url) return;
  e.preventDefault();
  // Browsers put the page title in text/html's link text, when there is one.
  const title = new DOMParser().parseFromString(e.dataTransfer.getData('text/html') || '', 'text/html').querySelector('a')?.textContent.trim() || '';
  showLinkForm(url.trim(), title);
});

// Bookmarks from a browser's export (an HTML file): each folder becomes a group on this side.
$('#links-import').addEventListener('click', () => $('#links-file').click());
$('#links-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (file.size > 8 * 1024 * 1024) { $('#status').textContent = 'That bookmarks file is too big (8 MB at most).'; return; }
  try {
    const r = await post('/api/links/import', { html: await file.text(), area: linksArea });
    linksDoc = { groups: r.groups };
    $('#status').textContent = `Imported ${r.imported} link${r.imported === 1 ? '' : 's'}.`;
  } catch (err) { $('#status').textContent = `Could not import: ${err.message}`; }
  personalSide();
  drawLinks();
});

loadLinks();
