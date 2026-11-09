// AI credits across all Copilot chats: totals for today, this week, this month and all time, a
// day-by-day and week-by-week split, and what that costs in dollars and your own currency.
//
// Credits come from each session's log (~/.copilot/session-state/<id>/events.jsonl): one
// session.usage_record per model call, with copilotUsage.totalNanoAiu (billionths of a credit)
// and the time of the call. Only those numbers are read, never what the chat said.
//
// Cost: credits × dollars per credit (Settings → Copilot, COPILOT_CREDIT_USD, default 0.01),
// then × your rate for one dollar (CLEARSKY_CURRENCY, CLEARSKY_FX_RATE). CLEARSKY_FX_LIVE=on looks
// the rate up once a day from a free public service (no token), and falls back to your rate.

import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

export const CREDIT_USD_DEFAULT = 0.01;
export const FX_URL = 'https://api.frankfurter.dev/v1/latest';

// One call each: { at (ms), credits, model }. Calls without credits are left out; a call
// without a time gets `fallbackAt` (the log's own time).
export function creditRecords(text, fallbackAt = null) {
  const seen = new Set(), out = [];
  for (const line of text.split('\n')) {
    if (!line.includes('"session.usage_record"')) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const u = e.data?.usage;
    const nano = u?.copilotUsage?.totalNanoAiu;
    if (typeof nano !== 'number' || !(nano > 0)) continue;
    const id = u.accounting?.usageId;
    if (id) { if (seen.has(id)) continue; seen.add(id); }
    const at = Date.parse(e.timestamp) || fallbackAt;
    if (at == null) continue;
    out.push({ at, credits: nano / 1e9, model: u.modelDisplayName || u.model || e.data.model || null });
  }
  return out;
}

const cache = new Map();
// Every session's records, read again only when its log changed.
export function allCreditRecords(home) {
  const root = join(home, 'session-state');
  let ids = [];
  try { ids = readdirSync(root).filter((x) => /^[\w-]{8,64}$/.test(x)); } catch { return []; }
  const out = [];
  for (const id of ids) {
    const file = join(root, id, 'events.jsonl');
    let st;
    try { st = statSync(file); } catch { continue; }
    let hit = cache.get(file);
    if (!hit || hit.mtimeMs !== st.mtimeMs || hit.size !== st.size) {
      let records = [];
      try { records = creditRecords(readFileSync(file, 'utf8'), st.mtimeMs); } catch { /* unreadable: none */ }
      hit = { mtimeMs: st.mtimeMs, size: st.size, records };
      cache.set(file, hit);
    }
    for (const r of hit.records) out.push({ ...r, chat: id });
  }
  return out;
}

// Local dates: "2026-11-09", and the Monday a week starts on.
const pad = (n) => String(n).padStart(2, '0');
export const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const startOfDay = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const addDays = (t, n) => { const d = new Date(t); d.setDate(d.getDate() + n); return d.getTime(); };
export const startOfWeek = (t) => { const s = startOfDay(t); return addDays(s, -((new Date(s).getDay() + 6) % 7)); };
const startOfMonth = (t) => { const d = new Date(startOfDay(t)); d.setDate(1); return d.getTime(); };

const round = (n) => Math.round(n * 1000) / 1000;

// Totals and splits. `days` is the last `dayCount` days (oldest first, today last), `weeks` the
// last `weekCount` weeks from Monday, `chats` the chats that used the most this week.
export function creditTotals(records, now = Date.now(), { dayCount = 14, weekCount = 8, chatCount = 8 } = {}) {
  const today = startOfDay(now), week = startOfWeek(now), month = startOfMonth(now);
  const sum = { total: 0, today: 0, week: 0, month: 0 };
  const byDay = new Map(), byWeek = new Map(), byChat = new Map(), byModel = new Map();
  let first = null;
  for (const r of records) {
    sum.total += r.credits;
    if (r.at >= today) sum.today += r.credits;
    if (r.at >= week) {
      sum.week += r.credits;
      const c = byChat.get(r.chat) || { id: r.chat, credits: 0, models: new Set() };
      c.credits += r.credits;
      if (r.model) c.models.add(r.model);
      byChat.set(r.chat, c);
    }
    if (r.at >= month) sum.month += r.credits;
    const d = dayKey(r.at), w = dayKey(startOfWeek(r.at));
    byDay.set(d, (byDay.get(d) || 0) + r.credits);
    byWeek.set(w, (byWeek.get(w) || 0) + r.credits);
    if (r.model) byModel.set(r.model, (byModel.get(r.model) || 0) + r.credits);
    if (first == null || r.at < first) first = r.at;
  }
  const days = [];
  for (let i = dayCount - 1; i >= 0; i--) { const k = dayKey(addDays(today, -i)); days.push({ date: k, credits: round(byDay.get(k) || 0) }); }
  const weeks = [];
  for (let i = weekCount - 1; i >= 0; i--) { const k = dayKey(addDays(week, -7 * i)); weeks.push({ start: k, credits: round(byWeek.get(k) || 0) }); }
  const chats = [...byChat.values()].sort((a, b) => b.credits - a.credits).slice(0, chatCount)
    .map((c) => ({ id: c.id, credits: round(c.credits), models: [...c.models] }));
  const models = [...byModel].sort((a, b) => b[1] - a[1]).map(([model, credits]) => ({ model, credits: round(credits) }));
  return { total: round(sum.total), today: round(sum.today), week: round(sum.week), month: round(sum.month), since: first, calls: records.length, days, weeks, chats, models };
}

const num = (v) => { const n = Number(String(v ?? '').trim().replace(',', '.')); return Number.isFinite(n) && n > 0 ? n : null; };
// What a credit costs, from the settings (and a looked-up rate, if any).
export function costRates(env = process.env, live = null) {
  const usdPerCredit = num(env.COPILOT_CREDIT_USD) ?? CREDIT_USD_DEFAULT;
  const currency = /^[A-Z]{3}$/.test(String(env.CLEARSKY_CURRENCY || '').trim().toUpperCase()) ? String(env.CLEARSKY_CURRENCY).trim().toUpperCase() : null;
  const own = num(env.CLEARSKY_FX_RATE);
  const useLive = env.CLEARSKY_FX_LIVE === 'on' && currency && currency !== 'USD' && live?.currency === currency && live.rate;
  const rate = currency === 'USD' ? 1 : useLive ? live.rate : own;
  return {
    usdPerCredit, usdPerCreditSet: num(env.COPILOT_CREDIT_USD) != null,
    currency: currency && currency !== 'USD' ? currency : null,
    rate: currency && currency !== 'USD' ? rate : null,
    rateFrom: currency && currency !== 'USD' && rate ? (useLive ? 'live' : 'yours') : null,
    rateDate: useLive ? live.date || null : null,
    live: env.CLEARSKY_FX_LIVE === 'on',
  };
}
export function costOf(credits, rates) {
  if (credits == null) return null;
  const usd = credits * rates.usdPerCredit;
  return { usd: Math.round(usd * 100) / 100, local: rates.currency && rates.rate ? Math.round(usd * rates.rate * 100) / 100 : null, currency: rates.currency };
}

// The day's dollar rate for `currency`, from the public ECB rates at frankfurter.dev (no
// account or token), kept in `file` for 12 hours. Never throws: no rate is null.
export async function liveRate(currency, file, { fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  if (!/^[A-Z]{3}$/.test(currency || '') || currency === 'USD') return null;
  let kept = null;
  try { kept = JSON.parse(readFileSync(file, 'utf8')); } catch { /* none yet */ }
  if (kept?.currency === currency && kept.rate && now - kept.checkedAt < 12 * 36e5) return kept;
  try {
    const res = await fetchImpl(`${FX_URL}?base=USD&symbols=${currency}`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    const rate = Number(body?.rates?.[currency]);
    if (!(rate > 0)) throw new Error('no rate');
    const got = { currency, rate, date: body.date || null, checkedAt: now };
    try { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(got)); } catch { /* kept in memory only */ }
    return got;
  } catch {
    return kept?.currency === currency && kept.rate ? kept : null; // an older rate beats none
  }
}
