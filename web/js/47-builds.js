// Builds: each repo's main branch, whether it builds, and the newest artifact and release it
// made (GET /api/builds, lib/builds.mjs). The menu counts the failing ones.

let buildsData = null, buildsLoading = false;
const BUILD_STATE = { passing: ['Passing', 'green'], failing: ['Failing', 'red'], running: ['Building', 'amber'], none: ['No checks', null] };

async function loadBuilds(force) {
  if (buildsLoading) return;
  if (!force && buildsData && Date.now() - Date.parse(buildsData.checkedAt) < 2 * 6e4) return renderBuilds();
  buildsLoading = true;
  if (!buildsData) renderBuilds();
  try { buildsData = await getJson(`/api/builds${force ? '?refresh' : ''}`); }
  catch (e) { buildsData = { error: e.message, repos: [], checkedAt: new Date().toISOString() }; }
  finally { buildsLoading = false; }
  renderBuilds();
}

function renderBuilds() {
  const failing = (buildsData?.repos || []).filter((r) => r.state === 'failing').length;
  const n = $('#n-builds');
  if (n) { n.textContent = failing || ''; n.classList.toggle('hot', !!failing); n.classList.toggle('red', !!failing); }
  const el = $('#builds');
  if (!el || $('#v-builds').hidden) return;
  if (!buildsData) { el.innerHTML = skeleton(4); return; }
  if (buildsData.error) { el.innerHTML = `<div class="err">${esc(buildsData.error)}</div>`; return; }
  if (!buildsData.repos.length) { el.innerHTML = '<div class="empty">No repos yet. Name them in <a href="/settings#github">Settings → GitHub</a>, or they come from your PRs and reviews.</div>'; return; }
  const link = (url, text) => (url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${text}</a>` : text);
  el.innerHTML = `<div class="builds">${buildsData.repos.map((r) => {
    if (r.error) return `<div class="build"><span class="dot"></span><div class="b-main"><b>${esc(r.repo)}</b><div class="b-sub">${esc(r.error)}</div></div></div>`;
    const [label, tone] = BUILD_STATE[r.state] || BUILD_STATE.none;
    const c = r.commit;
    return `<div class="build s-${esc(r.state)}">
      <span class="dot${tone ? ` ${tone}` : ''}" title="${esc(label)}"></span>
      <div class="b-main">
        <div><b>${link(r.url, esc(r.repo))}</b> <span class="b-branch">${esc(r.branch || '')}</span> <span class="lbl${tone ? ` ${tone}` : ''}">${tone ? '<i></i>' : ''}${esc(label)}</span>
          ${r.check && r.state !== 'passing' ? `<span class="b-check">${link(r.check.url, esc(r.check.name))}</span>` : ''}</div>
        ${c ? `<div class="b-sub">${link(c.url, `<code>${esc(c.sha)}</code>`)} ${esc(c.title)}${c.by ? ` · ${esc(c.by)}` : ''} · ${esc(ago(c.at))}</div>` : ''}
      </div>
      <div class="b-out">
        ${r.artifact ? `<div title="The newest Actions artifact built from ${esc(r.branch || 'the main branch')}">${icon('build', 13)} ${link(r.artifact.url, esc(r.artifact.name))} <span class="b-meta">${esc(ago(r.artifact.at))}${r.artifact.size ? ` · ${bytes(r.artifact.size)}` : ''}${r.artifact.sha && c?.sha && r.artifact.sha !== c.sha ? ` · from ${esc(r.artifact.sha)}` : ''}</span></div>` : '<div class="b-meta">No artifact from this branch</div>'}
        ${r.release ? `<div title="The latest release">${link(r.release.url, esc(r.release.tag))} <span class="b-meta">${esc(ago(r.release.at))}</span></div>` : r.tag ? `<div class="b-meta" title="The newest tag (no releases)">tag ${esc(r.tag)}</div>` : ''}
      </div></div>`;
  }).join('')}</div><div class="b-foot">Checked ${esc(ago(buildsData.checkedAt))}${buildsData.named ? '' : ' · repos from your PRs and reviews; pick them in <a href="/settings#github">Settings → GitHub</a>'}</div>`;
}
$('#builds-refresh').onclick = () => loadBuilds(true);
// The menu's count of failing builds: a first look shortly after start, then every 10 minutes.
setTimeout(() => loadBuilds(false), 8000);
setInterval(() => { if (!document.hidden) loadBuilds(false); }, 10 * 6e4);
