// Phone push: when a chat has waited for your OK for a while (you're away from the desk), a
// push through ntfy (https://ntfy.sh, or your own ntfy server) to the ntfy app on your phone.
// Settings → General → Phone push: PUSH_URL is the topic's address (secret: anyone who knows
// it can read the topic), PUSH_TOKEN an optional ntfy access token, PUSH_DETAIL how much it says.
// "short" (the default) says only that something waits, with no repo, ticket or chat names, so
// nothing about your work leaves the machine; "full" adds the chat's name and what it asks.

export const DEFAULT_AFTER_SECONDS = 60;

export function pushConfig(env = process.env) {
  const url = String(env.PUSH_URL || '').trim();
  if (!url) return null;
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname))) return null;
  const after = Number(env.PUSH_AFTER_SECONDS);
  return { url: u.toString(), token: env.PUSH_TOKEN || null, full: env.PUSH_DETAIL === 'full', afterMs: (Number.isFinite(after) && after >= 0 ? after : DEFAULT_AFTER_SECONDS) * 1000 };
}

// What a push says: `waits` is every card waiting now ({ chat: its name, title: what it asks }).
export function pushMessage(waits, { full = false } = {}) {
  const n = waits.length;
  const title = n === 1 ? 'Clearsky: a chat needs your OK' : `Clearsky: ${n} things need your OK`;
  if (!full) return { title, body: n === 1 ? 'An agent chat is waiting for your OK.' : `${n} agent steps are waiting for your OK.` };
  const lines = waits.slice(0, 5).map((w) => `${w.chat ? `${w.chat}: ` : ''}${w.title}`.replace(/\s+/g, ' ').slice(0, 160));
  return { title, body: lines.join('\n') + (n > 5 ? `\n…and ${n - 5} more` : '') };
}

// Header values must be plain ASCII for fetch; ntfy shows them as they are.
const ascii = (s) => String(s).replace(/[^\x20-\x7e]/g, '').slice(0, 120);

export async function sendPush(cfg, { title, body }, { fetchFn = fetch } = {}) {
  const res = await fetchFn(cfg.url, { method: 'POST', body,
    headers: { Title: ascii(title), Tags: 'hourglass', Priority: 'high', ...(cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}) },
    signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`ntfy answered ${res.status}${res.status === 401 || res.status === 403 ? ': check the access token' : ''}`);
  return true;
}

// Which waiting cards to push now: those waiting at least `afterMs` that weren't pushed yet.
// `seen` maps card id → when it was first seen; `pushed` is the ids already pushed. Both are
// pruned of cards that no longer wait. Returns { due, waits } (waits: every card waiting now).
export function duePush(cards, { seen, pushed, afterMs, now = Date.now() }) {
  const ids = new Set(cards.map((c) => c.id));
  for (const id of [...seen.keys()]) if (!ids.has(id)) seen.delete(id);
  for (const id of [...pushed]) if (!ids.has(id)) pushed.delete(id);
  for (const c of cards) if (!seen.has(c.id)) seen.set(c.id, now);
  const due = cards.filter((c) => !pushed.has(c.id) && now - seen.get(c.id) >= afterMs);
  return { due, waits: cards };
}
