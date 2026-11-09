// Usage: the AI credits all Copilot chats used (today, this week, this month, all time), by day,
// by week and by chat, and what that costs (GET /api/copilot/usage, lib/credit-usage.mjs).
// The price per credit and your currency are in Settings → Copilot → Credits and cost.

let usageData = null, usageLoading = false, usageAt = 0;

async function loadUsage(force) {
  if (usageLoading) return;
  if (!force && usageData && Date.now() - usageAt < 60_000) return renderUsage();
  usageLoading = true;
  if (!usageData) renderUsage();
  try { usageData = await getJson('/api/copilot/usage'); }
  catch (e) { usageData = { error: e.message }; }
  finally { usageLoading = false; usageAt = Date.now(); }
  renderUsage();
}

const fmtCr = (n) => (n == null ? '–' : n >= 100 ? Math.round(n).toLocaleString() : n >= 10 ? (Math.round(n * 10) / 10).toLocaleString() : (Math.round(n * 100) / 100).toLocaleString());
function money(n, currency) {
  if (n == null) return '';
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 2 }).format(n); }
  catch { return `${currency} ${n.toFixed(2)}`; }
}
// "$1.23 · kr 13.10", or the dollars alone.
function costText(c) {
  if (!c) return '';
  return [money(c.usd, 'USD'), c.local != null && c.currency ? money(c.local, c.currency) : null].filter(Boolean).join(' · ');
}

function usageBars(rows, label, title) {
  const max = Math.max(...rows.map((r) => r.credits), 0);
  return `<div class="ub">${rows.map((r, i) => {
    const h = max ? Math.max(r.credits ? 3 : 0, Math.round(100 * r.credits / max)) : 0;
    const last = i === rows.length - 1;
    return `<div class="ub-c${last ? ' now' : ''}" title="${esc(`${title(r)}: ${fmtCr(r.credits)} credits${r.cost ? ` · ${costText(r.cost)}` : ''}`)}">
      <div class="ub-v">${r.credits ? esc(fmtCr(r.credits)) : ''}</div><div class="ub-t"><i style="height:${h}%"></i></div><div class="ub-l">${esc(label(r, i))}</div></div>`;
  }).join('')}</div>`;
}

function renderUsage() {
  const el = $('#usage');
  if (!el || $('#v-usage').hidden) return;
  const d = usageData;
  if (!d) { el.innerHTML = skeleton(3); return; }
  if (d.error) { el.innerHTML = `<div class="err">${esc(d.error)}</div>`; return; }
  if (!d.calls) { el.innerHTML = '<div class="empty">No credits used yet. Copilot records them in each chat\'s session log, and they show up here after a chat\'s first answer.</div>'; return; }
  const tile = (name, n, c, tip) => `<div class="ut" title="${esc(tip)}"><small>${name}</small><b>${esc(fmtCr(n))}</b><span>${esc(costText(c)) || '&nbsp;'}</span></div>`;
  const day = (s) => new Date(`${s}T12:00:00`);
  const r = d.rates || {};
  const rate = r.currency ? (r.rate ? `1 USD = ${r.rate.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${r.currency}${r.rateFrom === 'live' ? ` (live${r.rateDate ? `, ${r.rateDate}` : ''})` : ''}` : `no rate for ${r.currency} yet`) : '';
  el.innerHTML = `
    <div class="ut-row">
      ${tile('Today', d.today, d.cost.today, 'Since midnight')}
      ${tile('This week', d.week, d.cost.week, 'Since Monday')}
      ${tile('This month', d.month, d.cost.month, 'Since the 1st')}
      ${tile('All time', d.total, d.cost.total, d.since ? `Since ${new Date(d.since).toLocaleDateString()}, over ${d.calls.toLocaleString()} model calls` : '')}
    </div>
    <h2 class="u-h">Daily <small>last ${d.days.length} days</small></h2>
    ${usageBars(d.days, (x) => day(x.date).toLocaleDateString(undefined, { weekday: 'narrow' }), (x) => day(x.date).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }))}
    <h2 class="u-h">Weekly <small>from Monday</small></h2>
    ${usageBars(d.weeks, (x) => day(x.start).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }), (x) => `Week of ${day(x.start).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`)}
    ${d.chats.length ? `<h2 class="u-h">This week's chats</h2><div class="u-list">${d.chats.map((c) => `<a href="#copilot" class="u-row" data-usage-chat="${esc(c.id)}"><span class="u-name">${esc(c.title || c.id)}${c.models.length ? ` <small>${esc(c.models.join(', '))}</small>` : ''}</span><b>${esc(fmtCr(c.credits))}</b><span class="u-cost">${esc(costText(c.cost))}</span></a>`).join('')}</div>` : ''}
    ${d.models.length > 1 ? `<h2 class="u-h">By model <small>all time</small></h2><div class="u-list">${d.models.map((m) => `<div class="u-row"><span class="u-name">${esc(m.model)}</span><b>${esc(fmtCr(m.credits))}</b><span class="u-cost"></span></div>`).join('')}</div>` : ''}
    <div class="b-foot">1 credit = $${esc(String(r.usdPerCredit))}${r.usdPerCreditSet ? '' : ' (default)'}${rate ? ` · ${esc(rate)}` : ''}${d.liveFailed ? ' · couldn\'t look up the live rate' : ''} · <a href="/settings#copilot/cost">Change</a></div>`;
}
$('#usage-refresh').onclick = () => loadUsage(true);
$('#usage').addEventListener('click', (e) => {
  const a = e.target.closest('[data-usage-chat]');
  if (!a) return;
  e.preventDefault();
  openChat(true, true);
  openSession(a.dataset.usageChat);
});
