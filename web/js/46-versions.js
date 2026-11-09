// Versions: how far a fix version of a starred Jira project is (GET /api/jira/starred,
// /api/jira/versions, /api/jira/version). Pick a project and a version; see its tickets by
// status, filtered by status, assignee, type and priority. Star projects with ☆ Projects
// (POST /api/jira/star) or in Settings → Plugins → Jira. All of it goes through acli.

const VER_KEY = 'cs.versions';
const verPrefs = (() => { try { return JSON.parse(localStorage.getItem(VER_KEY)) || {}; } catch { return {}; } })();
const saveVerPrefs = () => { try { localStorage.setItem(VER_KEY, JSON.stringify(verPrefs)); } catch { /* private window */ } };
verPrefs.versionOf ||= {};
const ver = { starred: null, site: null, versions: new Map(), data: null, loading: false, error: null, picker: false, projects: null, projectsError: null,
  filter: { statuses: [], assignee: '', type: '', priority: '', text: '', hideDone: false } };
const PRIO_ORDER = ['Highest', 'Blocker', 'Critical', 'High', 'Major', 'Medium', 'Low', 'Minor', 'Lowest', 'Trivial'];
const CAT_LABEL = { new: 'To do', indeterminate: 'In progress', done: 'Done' };

async function loadVersions(force) {
  try {
    const s = await getJson('/api/jira/starred');
    ver.starred = s.starred; ver.site = s.site;
  } catch (e) { ver.starred = []; ver.error = e.message; }
  if (!ver.starred.length) { ver.picker = true; renderVersions(); if (!ver.projects) loadVerProjects(); return; }
  if (!ver.starred.some((p) => p.key === verPrefs.project)) verPrefs.project = ver.starred[0].key;
  renderVersions();
  await loadVerVersions(verPrefs.project, force);
  if (!ver.projects && ver.starred.some((p) => !p.name)) loadVerProjects(); // for the projects' names
}

async function loadVerVersions(key, force) {
  if (force || !ver.versions.has(key)) {
    ver.versions.set(key, null);
    renderVersions();
    try { ver.versions.set(key, (await getJson(`/api/jira/versions?project=${encodeURIComponent(key)}${force ? '&refresh' : ''}`)).versions); }
    catch (e) { ver.versions.set(key, { error: e.message }); }
  }
  const list = ver.versions.get(key);
  if (key !== verPrefs.project || !Array.isArray(list)) return renderVersions();
  // The version you looked at last in this project, or the next one to be released.
  if (!list.some((v) => v.name === verPrefs.versionOf[key])) verPrefs.versionOf[key] = (list.find((v) => !v.released) || list[0])?.name;
  saveVerPrefs();
  await loadVerIssues(force);
}

async function loadVerIssues(force) {
  const key = verPrefs.project, version = verPrefs.versionOf[key];
  if (!version) { ver.data = null; return renderVersions(); }
  if (!force && ver.data?.project === key && ver.data?.version === version && !ver.data.error) return renderVersions();
  ver.loading = true; ver.data = { project: key, version, pending: true };
  renderVersions();
  try { ver.data = await getJson(`/api/jira/version?project=${encodeURIComponent(key)}&version=${encodeURIComponent(version)}${force ? '&refresh' : ''}`); }
  catch (e) { ver.data = { project: key, version, error: e.message }; }
  finally { ver.loading = false; }
  if (ver.data.project === verPrefs.project && ver.data.version === verPrefs.versionOf[verPrefs.project]) renderVersions();
}

async function loadVerProjects(force) {
  ver.projectsError = null;
  try {
    const d = await getJson(`/api/jira/projects${force ? '?refresh' : ''}`);
    ver.projects = d.projects;
    const names = new Map(d.projects.map((p) => [p.key, p.name]));
    for (const p of ver.starred || []) p.name ||= names.get(p.key) || null;
  } catch (e) { ver.projectsError = e.message; }
  renderVersions();
}

async function starProject(key, on) {
  try {
    const { starred } = await post('/api/jira/star', { key, starred: on });
    const names = new Map([...(ver.projects || []), ...(ver.starred || [])].map((p) => [p.key, p.name]));
    ver.starred = starred.map((k) => ({ key: k, name: names.get(k) || null }));
    if (on && !ver.starred.some((p) => p.key === verPrefs.project)) verPrefs.project = key;
    if (!ver.starred.some((p) => p.key === verPrefs.project)) verPrefs.project = ver.starred[0]?.key;
    saveVerPrefs();
    renderVersions();
    if (verPrefs.project) loadVerVersions(verPrefs.project);
  } catch (e) { ver.projectsError = e.message; renderVersions(); }
}

const verDate = (d) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: new Date(`${d}T12:00:00`).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
function verWhen(v) {
  if (!v.releaseDate) return v.released ? 'Released' : 'No release date';
  const days = Math.round((Date.parse(`${v.releaseDate}T12:00:00`) - Date.now()) / 864e5);
  if (v.released) return `Released ${verDate(v.releaseDate)}`;
  if (days < 0) return `Overdue, was due ${verDate(v.releaseDate)}`;
  return `Releases ${verDate(v.releaseDate)}${days === 0 ? ' (today)' : days === 1 ? ' (tomorrow)' : ` (in ${days} days)`}`;
}

function verFiltered(issues) {
  const f = ver.filter, q = f.text.trim().toLowerCase();
  return issues.filter((i) => (!f.statuses.length || f.statuses.includes(i.status))
    && (!f.assignee || (f.assignee === '-' ? !i.assignee : i.assignee === f.assignee))
    && (!f.type || i.type === f.type) && (!f.priority || i.priority === f.priority)
    && (!f.hideDone || i.statusCategory !== 'done')
    && (!q || `${i.key} ${i.summary}`.toLowerCase().includes(q)));
}

const verSelect = (id, label, all, opts, value) => `<label class="ver-f"><span>${esc(label)}</span><select id="${id}">
  <option value="">${esc(all)}</option>${opts.map(([v, l]) => `<option value="${esc(v)}"${v === value ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;
const uniq = (xs) => [...new Set(xs.filter(Boolean))];

function verPickerHtml() {
  const starred = new Set((ver.starred || []).map((p) => p.key));
  const q = ($('#ver-pick-q')?.value || '').trim().toLowerCase();
  const list = ver.projects ? ver.projects.filter((p) => !q || `${p.key} ${p.name}`.toLowerCase().includes(q)) : null;
  return `<div class="ver-pick" id="ver-pick">
    <div class="ver-pick-h"><b>Star the projects you follow</b><input type="search" id="ver-pick-q" placeholder="Find a project" aria-label="Find a project" value="${esc(q)}">
      <button type="button" class="icon-btn small" id="ver-pick-done">${starred.size ? 'Done' : 'Close'}</button></div>
    ${ver.projectsError ? `<div class="err">${esc(ver.projectsError)}</div>` : ''}
    ${!list ? (ver.projectsError ? '' : skeleton(3)) : !list.length ? '<div class="empty">No project matches.</div>'
      : `<ul class="ver-pick-l">${list.map((p) => `<li><button type="button" class="ver-star${starred.has(p.key) ? ' on' : ''}" data-star="${esc(p.key)}" aria-pressed="${starred.has(p.key)}" title="${starred.has(p.key) ? 'Unstar' : 'Star'}">${starred.has(p.key) ? '★' : '☆'}</button>
        <span class="ver-pk">${esc(p.key)}</span><span class="ver-pn">${esc(p.name)}</span></li>`).join('')}</ul>`}</div>`;
}

function renderVersions() {
  const el = $('#versions');
  if (!el || $('#v-versions').hidden) return;
  const pickBtn = $('#ver-projects');
  if (pickBtn) pickBtn.setAttribute('aria-expanded', String(ver.picker));
  if (!ver.starred) { el.innerHTML = skeleton(3); return; }
  const picker = ver.picker ? verPickerHtml() : '';
  if (!ver.starred.length) {
    el.innerHTML = `${ver.error ? `<div class="err">${esc(ver.error)}</div>` : ''}<div class="empty">Star a Jira project or two, then pick one of its versions to see how far it is.</div>${picker}`;
    return;
  }
  const key = verPrefs.project, list = ver.versions.get(key);
  const versions = Array.isArray(list) ? list : [];
  const cur = versions.find((v) => v.name === verPrefs.versionOf[key]);
  const open = versions.filter((v) => !v.released), done = versions.filter((v) => v.released);
  const vopt = (v) => `<option value="${esc(v.name)}"${v.name === cur?.name ? ' selected' : ''}>${esc(v.name)}${v.releaseDate ? ` · ${esc(verDate(v.releaseDate))}` : ''}</option>`;
  const bar = `<div class="ver-bar">
    <label class="ver-f"><span>Project</span><select id="ver-project">${ver.starred.map((p) => `<option value="${esc(p.key)}"${p.key === key ? ' selected' : ''}>${esc(p.name ? `${p.name} (${p.key})` : p.key)}</option>`).join('')}</select></label>
    <label class="ver-f"><span>Version</span><select id="ver-version"${versions.length ? '' : ' disabled'}>${!list ? '<option>Loading…</option>' : !versions.length ? '<option>No versions</option>'
      : `${open.length ? `<optgroup label="Unreleased">${open.map(vopt).join('')}</optgroup>` : ''}${done.length ? `<optgroup label="Released">${done.map(vopt).join('')}</optgroup>` : ''}`}</select></label>
    ${cur ? `<span class="ver-when${!cur.released && cur.releaseDate && Date.parse(`${cur.releaseDate}T23:59:59`) < Date.now() ? ' late' : ''}">${esc(verWhen(cur))}</span>` : ''}</div>`;
  let body = '';
  const d = ver.data;
  if (list?.error) body = `<div class="err">${esc(list.error)}</div>`;
  else if (!list || d?.pending) body = skeleton(5);
  else if (!versions.length) body = `<div class="empty">${esc(key)} has no fix versions yet.</div>`;
  else if (d?.error) body = `<div class="err">${esc(d.error)}</div>`;
  else if (d && d.project === key && d.version === cur?.name) body = verBody(d, cur);
  el.innerHTML = `${picker}${bar}${body}`;
}

function verBody(d, v) {
  const s = d.summary, f = ver.filter;
  if (!s.total) return `<div class="empty">No tickets in ${esc(d.version)} yet.</div>`;
  const pct = (n) => (s.total ? Math.round((100 * n) / s.total) : 0);
  const tile = (label, n, cls, tip) => `<div class="ut ver-t ${cls}" title="${esc(tip)}"><small>${label}</small><b>${n}</b><span>${pct(n)}%</span></div>`;
  // Rows in the order of the status chips (to do, in progress, done), then by priority.
  const at = new Map(s.statuses.map((x, i) => [x.name, i]));
  const shown = verFiltered(d.issues).sort((a, b) => at.get(a.status) - at.get(b.status) || (PRIO_ORDER.indexOf(a.priority) + 1 || 99) - (PRIO_ORDER.indexOf(b.priority) + 1 || 99)
    || a.key.localeCompare(b.key, undefined, { numeric: true }));
  const people = uniq(d.issues.map((i) => i.assignee)).sort();
  const anyFilter = f.statuses.length || f.assignee || f.type || f.priority || f.text || f.hideDone;
  const jql = `project = "${d.project}" AND fixVersion = "${d.version.replace(/["\\]/g, '\\$&')}"`;
  const site = ver.site || '';
  return `<div class="ut-row ver-tiles">
      ${tile('Tickets', s.total, '', `All tickets with fix version ${d.version}`)}
      ${tile('To do', s.new, 'c-new', 'Not started')}
      ${tile('In progress', s.indeterminate, 'c-indeterminate', 'Started, in review or in test')}
      ${tile('Done', s.done, 'c-done', 'Finished')}</div>
    <div class="ver-prog" role="img" aria-label="${pct(s.done)}% done, ${pct(s.indeterminate)}% in progress">${['done', 'indeterminate', 'new'].map((c) => (s[c] ? `<i class="c-${c}" style="width:${(100 * s[c]) / s.total}%" title="${CAT_LABEL[c]}: ${s[c]}"></i>` : '')).join('')}</div>
    <div class="ver-st" role="group" aria-label="Status">${s.statuses.map((x) => `<button type="button" class="ver-chip c-${esc(x.category)}${f.statuses.includes(x.name) ? ' on' : ''}" data-ver-status="${esc(x.name)}" aria-pressed="${f.statuses.includes(x.name)}">${esc(x.name)} <b>${x.count}</b></button>`).join('')}</div>
    <div class="ver-filters">
      ${verSelect('ver-assignee', 'Assignee', 'Anyone', [...people.map((p) => [p, p]), ...(d.issues.some((i) => !i.assignee) ? [['-', 'Unassigned']] : [])], f.assignee)}
      ${verSelect('ver-type', 'Type', 'All types', uniq(d.issues.map((i) => i.type)).sort().map((t) => [t, t]), f.type)}
      ${verSelect('ver-priority', 'Priority', 'Any priority', uniq(d.issues.map((i) => i.priority)).sort((a, b) => (PRIO_ORDER.indexOf(a) + 1 || 99) - (PRIO_ORDER.indexOf(b) + 1 || 99)).map((p) => [p, p]), f.priority)}
      <label class="ver-f ver-q"><span>Find</span><input type="search" id="ver-text" placeholder="Key or summary" value="${esc(f.text)}"></label>
      <label class="ver-hide"><input type="checkbox" id="ver-hide-done"${f.hideDone ? ' checked' : ''}> Hide done</label>
      ${anyFilter ? '<button type="button" class="chip" id="ver-clear">Clear filters</button>' : ''}</div>
    <div class="ver-tw"><table class="ver-tbl"><thead><tr><th>Key</th><th>Summary</th><th class="ver-ty">Type</th><th class="ver-pr">Priority</th><th>Assignee</th><th>Status</th></tr></thead><tbody>
      ${shown.map((i) => `<tr><td class="ver-k"><a href="${esc(i.url || '#')}" target="_blank" rel="noopener" data-issue="${esc(i.key)}">${esc(i.key)}</a></td>
        <td class="ver-s">${esc(i.summary)}</td><td class="ver-ty">${esc(i.type || '')}</td><td class="ver-pr">${esc(i.priority || '')}</td>
        <td class="ver-a${i.assignee ? '' : ' none'}">${esc(i.assignee || 'Unassigned')}</td><td><span class="ver-pill c-${esc(i.statusCategory || 'new')}">${esc(i.status)}</span></td></tr>`).join('')
        || '<tr><td colspan="6" class="empty">No ticket matches these filters.</td></tr>'}</tbody></table></div>
    <div class="b-foot">${shown.length === d.issues.length ? `${d.issues.length} tickets` : `${shown.length} of ${d.issues.length} tickets`}${d.truncated ? ' (only the first 500)' : ''}
      · checked ${esc(ago(d.checkedAt))}${site ? ` · <a href="${esc(`${site}/issues/?jql=${encodeURIComponent(jql)}`)}" target="_blank" rel="noopener">Open in Jira</a>` : ''}</div>`;
}

$('#ver-refresh').onclick = () => { ver.versions.delete(verPrefs.project); loadVersions(true); };
$('#ver-projects').onclick = () => { ver.picker = !ver.picker; renderVersions(); if (ver.picker && !ver.projects) loadVerProjects(); if (ver.picker) $('#ver-pick-q')?.focus(); };
$('#versions').addEventListener('change', (e) => {
  const t = e.target, f = ver.filter;
  if (t.id === 'ver-project') { verPrefs.project = t.value; saveVerPrefs(); f.statuses = []; renderVersions(); loadVerVersions(t.value); }
  else if (t.id === 'ver-version') { verPrefs.versionOf[verPrefs.project] = t.value; saveVerPrefs(); f.statuses = []; loadVerIssues(false); }
  else if (t.id === 'ver-assignee') { f.assignee = t.value; renderVersions(); }
  else if (t.id === 'ver-type') { f.type = t.value; renderVersions(); }
  else if (t.id === 'ver-priority') { f.priority = t.value; renderVersions(); }
  else if (t.id === 'ver-hide-done') { f.hideDone = t.checked; renderVersions(); }
});
$('#versions').addEventListener('input', (e) => {
  const t = e.target;
  // Redraw, then put the caret back where it was.
  const again = (id) => { const at = t.selectionStart; renderVersions(); const n = $(`#${id}`); if (n) { n.focus(); n.setSelectionRange(at, at); } };
  if (t.id === 'ver-text') { ver.filter.text = t.value; again('ver-text'); }
  else if (t.id === 'ver-pick-q') again('ver-pick-q');
});
$('#versions').addEventListener('click', (e) => {
  const st = e.target.closest('[data-ver-status]'), star = e.target.closest('[data-star]');
  if (st) {
    const f = ver.filter, n = st.dataset.verStatus;
    f.statuses = f.statuses.includes(n) ? f.statuses.filter((x) => x !== n) : [...f.statuses, n];
    renderVersions();
  } else if (star) starProject(star.dataset.star, !star.classList.contains('on'));
  else if (e.target.closest('#ver-clear')) { ver.filter = { statuses: [], assignee: '', type: '', priority: '', text: '', hideDone: false }; renderVersions(); }
  else if (e.target.closest('#ver-pick-done')) { ver.picker = false; renderVersions(); }
});
