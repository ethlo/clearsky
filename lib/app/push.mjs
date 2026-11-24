// Phone push (lib/push.mjs): every 15 seconds, look at the cards chats wait on, and push the
// ones that have waited long enough. One push per card; a card asked in several chats (a GitHub
// change) counts once.
import { pushConfig, pushMessage, sendPush, duePush } from '../push.mjs';
import { logEvent } from '../event-log.mjs';
import { stateFile } from './config.mjs';
import * as localState from '../state.mjs';
import { acpChats } from './chat-env.mjs';

const seen = new Map(), pushed = new Set();
export const push = { timer: null, last: null, error: null };

export function waitingCards() {
  const names = localState.sessionNames(stateFile), titles = localState.sessionTitles(stateFile);
  const out = new Map();
  for (const [id, c] of acpChats) for (const [pid, ev] of c.pending || []) {
    if (!c.waiting?.has(pid) || out.has(pid)) continue;
    out.set(pid, { id: pid, chat: names[id] || titles[id] || null, title: ev.title || 'a step' });
  }
  return [...out.values()];
}

export async function pushCheck({ now = Date.now(), send = sendPush } = {}) {
  const cfg = pushConfig();
  if (!cfg) { seen.clear(); pushed.clear(); return null; }
  const { due, waits } = duePush(waitingCards(), { seen, pushed, afterMs: cfg.afterMs, now });
  if (!due.length) return null;
  for (const c of due) pushed.add(c.id);
  try {
    await send(cfg, pushMessage(waits, cfg));
    push.last = new Date(now).toISOString(); push.error = null;
    logEvent(`phone push: ${due.length} waiting`);
  } catch (e) { push.error = e.message; logEvent(`phone push failed: ${e.message}`); }
  return due.length;
}

export function startPush() {
  push.timer = setInterval(() => { pushCheck().catch(() => {}); }, 15_000);
  push.timer.unref();
}

// Settings → Test: a push now, saying it's a test.
export async function pushTest() {
  const cfg = pushConfig();
  if (!cfg) throw new Error('Set the ntfy topic address first (https://…).');
  await sendPush(cfg, { title: 'Clearsky: test', body: 'Phone push works. You get one when a chat waits for your OK.' });
  return { ok: true };
}
