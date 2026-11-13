// VMs: every chat's VM for Docker builds (GET /api/vms, lib/vm-queue.mjs, lib/vm.mjs). How many
// may run at once and how many chats wait in line for one; per running VM its CPU and memory and
// the containers in it; and what chats run in their sandboxes on this machine itself (a build
// there takes this machine's CPU, not a VM's). The menu shows how many wait, and its icon turns green, orange or red with
// the busiest VM's load (none while no VM runs). Open, it looks again every 3 seconds; closed,
// every 15 seconds, for the menu.

let vmsData = null, vmsLoading = false;

async function loadVms(quick = false) {
  if (vmsLoading) return;
  vmsLoading = true;
  if (!vmsData && !quick) $('#vms').innerHTML = skeleton(3);
  try { vmsData = await getJson('/api/vms'); } catch (e) { if (!quick) vmsData = { error: e.message, vms: [] }; }
  finally { vmsLoading = false; }
  renderVms(quick);
}

const gbOf = (mb) => `${(mb / 1024).toFixed(1)} GB`;
const mins = (iso) => { const m = Math.round((Date.now() - Date.parse(iso)) / 6e4); return m < 1 ? '<1 min' : m < 90 ? `${m} min` : `${Math.round(m / 60)} h`; };
// A bar from 0 to 100, amber from 70 and red from 90.
const meter = (pct, label, title) => {
  const p = pct == null ? null : Math.max(0, Math.min(100, pct));
  return `<div class="vms-meter${p == null ? ' none' : p >= 90 ? ' hot' : p >= 70 ? ' warm' : ''}" title="${esc(title)}"><span>${esc(label)}</span><div><i style="width:${p ?? 0}%"></i></div></div>`;
};

function renderVms(quick) {
  const d = vmsData;
  const n = $('#n-vms');
  if (n) { n.textContent = d?.waiting ? String(d.waiting) : ''; n.title = d?.waiting ? `${d.waiting} chat${d.waiting === 1 ? '' : 's'} waiting for a VM` : ''; }
  // The menu item's colour: how hard the busiest running VM works (lib/vm.mjs vmsLoad).
  const nav = $('[data-nav="vms"]'), L = d?.load;
  if (nav) {
    nav.classList.remove('load-ok', 'load-warm', 'load-hot');
    if (L) nav.classList.add(`load-${L.level}`);
    nav.title = L ? `VMs: ${d.running} running${d.waiting ? `, ${d.waiting} waiting` : ''}. Busiest: ${L.pct != null ? `${L.pct}% ${L.what}` : 'starting'}${L.title ? ` (${L.title})` : ''}`
      : 'Copilot\'s VMs for builds with Docker: what runs in them and who waits for one';
  }
  if (quick || $('#v-vms').hidden || !d) return;
  const el = $('#vms');
  if (d.error) { el.innerHTML = `<div class="err">${esc(d.error)}</div>`; return; }
  $('#vms-sub').textContent = `${d.running} of ${d.limit} running${d.waiting ? ` · ${d.waiting} waiting` : ''}`;
  const run = d.vms.filter((v) => v.place !== 'waiting'), wait = d.vms.filter((v) => v.place === 'waiting');
  const cpuUsed = run.reduce((a, v) => a + (v.system?.cpuPct != null ? (v.system.cpuPct / 100) * v.vcpus : 0), 0);
  const memUsed = run.reduce((a, v) => a + (v.system?.memUsedMb || 0), 0);
  const sb = d.sandboxes || [], sbCores = sb.reduce((a, x) => a + (x.cpuPct || 0) / 100, 0);
  const memGiven = run.reduce((a, v) => a + (v.system?.memTotalMb || v.memMb || 0), 0);
  const tiles = `<div class="vms-tiles">
    <div class="vms-tile"><b>${d.running}<small> / ${d.limit}</small></b><span>running</span></div>
    <div class="vms-tile${d.waiting ? ' warn' : ''}"><b>${d.waiting}</b><span>waiting in line</span></div>
    <div class="vms-tile" title="CPU the running VMs use now, in cores, of this machine's ${d.host?.cpus ?? '?'}"><b>${cpuUsed.toFixed(1)}<small> / ${d.host?.cpus ?? '?'} cores</small></b><span>CPU in VMs</span></div>
    <div class="vms-tile" title="Memory used in the running VMs; they were given ${gbOf(memGiven)} of this machine's ${d.host ? gbOf(d.host.memMb) : '?'}"><b>${gbOf(memUsed)}<small> / ${d.host ? gbOf(d.host.memMb) : '?'}</small></b><span>memory in VMs</span></div>
    <div class="vms-tile${sbCores >= 2 ? ' warn' : ''}" title="CPU chats' sandboxes use on this machine itself, in cores: builds and tests run there instead of in a VM"><b>${sbCores.toFixed(1)}<small> / ${d.host?.cpus ?? '?'} cores</small></b><span>CPU in sandboxes</span></div></div>`;
  const ctrRow = (c) => {
    const on = c.state === 'running';
    const ports = (c.ports || '').replace(/0\.0\.0\.0:|\[::\]:/g, '').split(', ').filter((x, i, a) => x && a.indexOf(x) === i).join(', ');
    return `<tr class="c-${esc(c.state)}"><td><span class="vms-dot"></span><b>${esc(c.name)}</b></td><td class="vms-img">${esc(c.image)}</td>
      <td class="vms-num">${on && c.cpu ? esc(c.cpu) : ''}</td><td class="vms-num">${on && c.mem ? esc(c.mem.split(' / ')[0]) : ''}</td>
      <td class="vms-st">${esc(c.status || c.state)}${ports ? `<small>${esc(ports)}</small>` : ''}</td></tr>`;
  };
  const card = (v) => {
    const s = v.system, on = v.state === 'running';
    const memPct = s?.memTotalMb ? (s.memUsedMb / s.memTotalMb) * 100 : null;
    const st = v.state === 'starting' ? 'starting' : on ? (v.busy ? 'busy' : 'idle') : v.state;
    const live = v.containers.filter((c) => c.state === 'running').length;
    return `<section class="vms-card">
      <header><span class="vm-st s-${on ? 'running' : esc(v.state)}"><i></i>${esc({ busy: 'Building', idle: 'Idle', starting: 'Starting', off: 'Stopped' }[st] || st)}</span>
        <a href="#copilot" class="vms-chat" data-chat="${esc(v.chat)}" title="Open this chat">${esc(v.title || 'Untitled chat')}</a>
        <button class="chip" data-vm-stop="${esc(v.chat)}" type="button" title="Stop this chat's VM; its next vm command starts a fresh one">Stop</button></header>
      <div class="vms-sub"><span class="vms-cwd">${icon('folder', 12)} ${esc(v.cwd)}</span> · ${v.vcpus} vCPUs · ${gbOf(v.memMb)}${v.startedAt ? ` · up ${mins(v.startedAt)}` : ''} · ${v.commands} run${v.commands === 1 ? '' : 's'}${v.diskBytes ? ` · disk ${gbOf(v.diskBytes / 1048576)}` : ''}</div>
      <div class="vms-meters">${meter(s?.cpuPct, `CPU ${s?.cpuPct != null ? `${s.cpuPct}%` : '…'}`, `Of the VM's ${v.vcpus} vCPUs, since the last look`)}
        ${meter(memPct, `Memory ${s ? `${gbOf(s.memUsedMb)} of ${gbOf(s.memTotalMb)}` : '…'}`, 'Used in the VM, as its free -m says')}</div>
      ${v.containers.length ? `<table class="vms-ctrs"><thead><tr><th>Container <span class="muted">${live} running</span></th><th>Image</th><th class="vms-num">CPU</th><th class="vms-num">Memory</th><th>State</th></tr></thead>
        <tbody>${v.containers.map(ctrRow).join('')}</tbody></table>` : `<div class="vm-empty">${on ? 'No containers' : 'Not up yet'}</div>`}
    </section>`;
  };
  const waitRow = (v) => `<li><span class="vms-pos">${v.position}</span><a href="#copilot" class="vms-chat" data-chat="${esc(v.chat)}" title="Open this chat">${esc(v.title || 'Untitled chat')}</a>
    <span class="vms-where">${esc(v.cwd)}</span><span class="muted">waiting ${mins(v.since)}</span>
    <button class="chip" data-vm-stop="${esc(v.chat)}" type="button" title="Take it out of the line: its waiting vm command stops">Leave line</button></li>`;
  // Chats' sandboxes on this machine: the busy ones (a quarter of a core or more) by name.
  const busy = sb.filter((x) => (x.cpuPct || 0) >= 25);
  const sbRow = (x) => `<li><span class="vms-pos" title="Cores in use">${((x.cpuPct || 0) / 100).toFixed(1)}</span><a href="#copilot" class="vms-chat" data-chat="${esc(x.chat)}" title="Open this chat">${esc(x.title || 'Untitled chat')}</a>
    <span class="vms-where">${x.top ? `${esc(x.top.name)} ${x.top.cpuPct}%` : ''}${x.jobs ? ` · ${x.jobs} background job${x.jobs === 1 ? '' : 's'}` : ''}</span><span class="muted">${gbOf(x.memMb)}</span></li>`;
  const sbPart = sb.length ? `<h2 class="vms-h" style="margin-top:24px">On this machine, in chats' sandboxes <span class="muted">${busy.length ? `${busy.length} busy` : 'all quiet'}</span></h2>
    ${busy.length ? `<ol class="vms-line">${busy.map(sbRow).join('')}</ol>` : ''}
    <div class="b-foot">${d.builds === 'vm' ? 'Chats are told to run builds and tests in their VM; a busy sandbox here is one that didn\'t.' : 'Chats run builds and tests in their sandbox, on this machine at low priority, and use a VM only for Docker.'} Change it in <a href="/settings#copilot">Settings → Copilot → Run builds in</a>.</div>` : '';
  // The VMs' Docker Hub image cache: how full, the images in it, and a Purge.
  const ic = d.imageCache, gbB = (b) => `${(b / 1024 ** 3).toFixed(1)} GB`;
  const icPart = ic ? `<h2 class="vms-h" style="margin-top:24px">Image cache <span class="muted">${ic.images} image${ic.images === 1 ? '' : 's'} · ${ic.layers} layer${ic.layers === 1 ? '' : 's'}</span></h2>
    <div class="vms-cache">${meter(ic.capBytes ? (ic.bytes / ic.capBytes) * 100 : null, `${gbB(ic.bytes)} of ${gbB(ic.capBytes)}`, 'Over the cap, the layers used longest ago go first')}
      <button class="chip" data-cache-purge type="button" ${ic.layers || ic.images ? '' : 'disabled'} title="Empty the cache: the next pull of each image downloads it again">Purge</button></div>
    ${ic.recent?.length ? `<div class="vms-images">${ic.recent.map((x) => `<span class="vms-image" title="Last pulled ${esc(mins(x.used))} ago">${esc(x.name)}</span>`).join('')}</div>` : ''}
    <div class="b-foot">VMs pull Docker Hub images through it, so a layer an earlier VM pulled comes from this machine. Size cap: <a href="/settings#copilot">Settings → Copilot → Image cache</a>.</div>` : '';
  el.innerHTML = `${tiles}
    ${wait.length ? `<h2 class="vms-h">Waiting in line <span class="muted">${wait.length}</span></h2><ol class="vms-line">${wait.map(waitRow).join('')}</ol>` : ''}
    <h2 class="vms-h">Running <span class="muted">${run.length}</span></h2>
    ${run.length ? run.map(card).join('') : `<div class="empty">${d.support?.ok === false ? `VMs can't run on this machine: ${esc(d.support.why || 'unknown reason')}` : 'No VM runs now. A chat starts one with its first vm command.'}</div>`}
    <div class="b-foot">${d.limit} VM${d.limit === 1 ? '' : 's'} at the same time: <a href="/settings#copilot">Settings → Copilot</a></div>
    ${icPart}
    ${sbPart}`;
}

$('#vms-refresh').onclick = () => loadVms();
$('#vms').addEventListener('click', async (e) => {
  const purge = e.target.closest('[data-cache-purge]');
  if (purge) {
    const ic = vmsData?.imageCache;
    if (!confirm(`Empty the image cache (${ic ? `${ic.images} images, ${(ic.bytes / 1024 ** 3).toFixed(1)} GB` : 'all of it'})? Each image is downloaded again on its next pull.`)) return;
    purge.disabled = true;
    const r = await post('/api/vms/image-cache/purge', {}).catch(() => null);
    if (r?.imageCache && vmsData) vmsData.imageCache = r.imageCache;
    return loadVms();
  }
  const stop = e.target.closest('[data-vm-stop]');
  if (stop) { stop.disabled = true; await post('/api/vm/stop', { chat: stop.dataset.vmStop }).catch(() => {}); return loadVms(); }
  const a = e.target.closest('[data-chat]');
  if (a) { e.preventDefault(); openChat(true, true); openSession(a.dataset.chat); }
});
setInterval(() => { if (document.hidden) return; if (!$('#v-vms').hidden) loadVms(); }, 3000);
setInterval(() => { if (!document.hidden && $('#v-vms').hidden) loadVms(true); }, 15_000);
loadVms(true);
