// Servers: your SSH hosts from ~/.ssh/config (GET /api/servers, lib/ssh-hosts.mjs), grouped by
// the start of their name, with the jump host each goes through. Clicking one copies its ssh
// command; Clearsky never connects.

let serversData = null;

async function loadServers() {
  if (!serversData) $('#servers').innerHTML = skeleton(4);
  try { serversData = await getJson('/api/servers'); } catch (e) { serversData = { error: e.message, hosts: [] }; }
  renderServers();
}

function renderServers() {
  const el = $('#servers');
  if (!serversData) return;
  if (serversData.error) { el.innerHTML = `<div class="err">${esc(serversData.error)}</div>`; return; }
  const all = serversData.hosts;
  if (!all.length) {
    el.innerHTML = `<div class="empty">No servers in ${serversData.file ? esc(serversData.file) : '~/.ssh/config'} yet. Add a <code>Host</code> entry for each, with names like <code>acme-test-db</code>; the start of the name groups them.</div>`;
    return;
  }
  const q = ($('#srv-filter').value || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  const hay = (h) => [h.name, h.host, h.user, h.jump, h.note, h.group].filter(Boolean).join(' ').toLowerCase();
  const hosts = all.filter((h) => q.every((w) => hay(h).includes(w)));
  const groups = new Map();
  for (const h of hosts) { if (!groups.has(h.group)) groups.set(h.group, []); groups.get(h.group).push(h); }
  const row = (h) => {
    const where = h.host ? `${h.user ? `${esc(h.user)}@` : ''}${esc(h.host)}${h.port ? `:${esc(h.port)}` : ''}` : h.user ? `${esc(h.user)}@` : '';
    const how = [h.isJump ? '<span class="lbl">jump server</span>' : '', h.jump ? `via <b>${esc(h.jump)}</b>` : h.proxyCommand ? 'via a proxy command' : '',
      h.forwards ? `${h.forwards} port forward${h.forwards > 1 ? 's' : ''}` : ''].filter(Boolean).join(' · ');
    return `<button type="button" class="srv" data-ssh="${esc(h.name)}" title="Copy: ssh ${esc(h.name)}">
      <span class="srv-name">${esc(h.name)}</span>
      <span class="srv-where">${where}</span>
      <span class="srv-how">${how}${h.note ? `<span class="srv-note">${esc(h.note)}</span>` : ''}</span>
      <span class="srv-copy">${icon('copy', 13)}</span></button>`;
  };
  el.innerHTML = hosts.length
    ? [...groups].map(([g, list]) => `<section class="srv-group"><h2>${esc(g)} <span class="muted">${list.length}</span></h2><div class="srv-list">${list.map(row).join('')}</div></section>`).join('')
      + `<div class="b-foot">From ${esc(serversData.file || '~/.ssh/config')}</div>`
    : '<div class="empty">No server matches.</div>';
}

$('#srv-filter').addEventListener('input', renderServers);
$('#srv-refresh').onclick = () => loadServers();
$('#servers').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-ssh]');
  if (!b) return;
  const cmd = `ssh ${b.dataset.ssh}`;
  const tip = b.querySelector('.srv-copy');
  try { await navigator.clipboard.writeText(cmd); tip.textContent = 'Copied'; } catch { tip.textContent = cmd; }
  setTimeout(() => { tip.innerHTML = icon('copy', 13); }, 1500);
});
