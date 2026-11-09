// The watchdog: a chat that stops before its task is done gets a nudge to go on, a few times at
// most (Settings → Copilot → Nudges). Chats stop early for reasons of their own: the turn hit
// a limit, Copilot ended with an error, it said "Next I'll run the tests" and ended the turn,
// or the turn hangs with nothing running. It never nudges a chat that asks you something,
// waits on your OK, has a background job running (lib/jobs.mjs: the job wakes it), or that you
// stopped. What you send starts the count again.

export const NUDGES_DEFAULT = 3, NUDGE_MINUTES_DEFAULT = 2, STUCK_MINUTES_DEFAULT = 15;
const int = (v, lo, hi, d) => { const s = String(v ?? '').trim(); const n = Math.floor(Number(s)); return s && Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : d; };
export function watchdogSettings(env = process.env) {
  return {
    nudges: int(env.COPILOT_NUDGES, 0, 10, NUDGES_DEFAULT), // 0: off
    minutes: int(env.COPILOT_NUDGE_MINUTES, 1, 60, NUDGE_MINUTES_DEFAULT), // quiet this long after the turn, then nudge
    stuckMinutes: int(env.COPILOT_STUCK_MINUTES, 5, 120, STUCK_MINUTES_DEFAULT), // a turn with nothing running and no word this long
  };
}

// Promises of more work at the end of an answer ("Next I'll…", "Let me…", "Now running…").
const GOING_ON = /\b(I'll|I will|I'm going to|I am going to|let me|let's|next,? I|now I|I'll now|I need to|I still need to|then I|going to|continuing|proceeding|waiting for)\b/i;
// …unless it says it's done or hands over to you.
const DONE = /\b(done|finished|complete[d]?|all set|that's it|nothing (left|else|more)|ready for (your )?review|let me know|up to you|your call|if you('d)? like|want me to|shall I|should I)\b/i;

// Why the turn looks unfinished, or null when it looks done (or waits on you).
// stopReason: ACP's (end_turn, max_tokens, max_turn_requests, refusal, cancelled).
export function unfinished({ stopReason, error = null, text = '', stuck = false, stopped = false }) {
  if (stopped) return null; // you pressed Stop
  if (stuck) return 'stuck';
  if (error) return 'error';
  if (stopReason === 'max_tokens') return 'cut-off';
  if (stopReason === 'max_turn_requests') return 'turn-limit';
  if (stopReason && stopReason !== 'end_turn') return null; // refused, or cancelled by someone
  const t = String(text || '').trim();
  if (!t) return 'silent'; // steps, then not a word: it didn't get to the end
  if (/```choices\b/.test(t) || /```remember\b/.test(t)) return null; // asks you
  const last = t.split(/\n\s*\n/).filter((p) => p.trim()).pop().trim();
  if (/\?\s*\**\s*$/.test(last)) return null; // a question for you
  if (DONE.test(last)) return null;
  if (/[:…]\s*$/.test(last) || /\.\.\.\s*$/.test(last)) return 'mid-step';
  if (GOING_ON.test(last)) return 'said-more';
  return null;
}

export const REASONS = {
  stuck: 'the turn had no word and nothing running for a long time, so Clearsky stopped it',
  error: 'the turn ended with an error',
  'cut-off': 'the answer was cut off at its length limit',
  'turn-limit': 'the turn hit its step limit',
  silent: 'the turn ended without an answer',
  'mid-step': 'the answer stopped mid-step',
  'said-more': 'the answer said there was more to do',
};

// What the chat gets. AUTO_MARK starts every message Clearsky sends on its own, so the chat
// panel shows it as Clearsky's, not yours.
export const AUTO_MARK = '[Clearsky] ';
export const nudgeText = (reason, n, max) => `${AUTO_MARK}You stopped, but the task doesn't look finished (${REASONS[reason] || reason}). `
  + 'Carry on from where you left off. If it is finished, or you need me to decide something, say that in one line instead. '
  + `(Nudge ${n} of ${max}.)`;

// Per chat: how many nudges since your last message, and when the next one is due.
export class Watchdog {
  constructor({ settings = () => watchdogSettings(), now = Date.now } = {}) {
    this.settings = settings;
    this.now = now;
    this.chats = new Map(); // id → { nudges, due, reason, paused, last }
  }

  #get(id) { let s = this.chats.get(id); if (!s) { s = { nudges: 0, due: null, reason: null, paused: false, last: null }; this.chats.set(id, s); } return s; }

  // You wrote in the chat: a new task, so a fresh count.
  userMessage(id) { const s = this.#get(id); s.nudges = 0; s.due = null; s.reason = null; }

  // A turn ended. Returns the reason it'll be nudged for, or null.
  turnEnded(id, turn) {
    const s = this.#get(id), cfg = this.settings();
    s.due = null; s.reason = null;
    const reason = unfinished(turn);
    if (!reason || !cfg.nudges || s.paused) return null;
    if (s.nudges >= cfg.nudges) { s.reason = reason; s.gaveUp = true; return null; }
    s.reason = reason;
    s.gaveUp = false;
    // A stuck turn was stopped by the watchdog itself: go on at once.
    s.due = this.now() + (reason === 'stuck' ? 5000 : cfg.minutes * 6e4);
    return reason;
  }

  // The chat is busy again, or you're answering it: nothing due.
  cancel(id) { const s = this.chats.get(id); if (s) { s.due = null; } }

  pause(id, paused) { const s = this.#get(id); s.paused = !!paused; if (paused) s.due = null; }

  forget(id) { this.chats.delete(id); }

  // Chats due for a nudge now. `can(id)` says whether one may go now (not busy, nobody asked,
  // no job running); if not, the nudge waits for the turn after.
  due(can = () => true) {
    const out = [];
    for (const [id, s] of this.chats) {
      if (!s.due || s.due > this.now() || s.paused) continue;
      s.due = null;
      if (!can(id)) continue;
      s.nudges++;
      s.last = new Date(this.now()).toISOString();
      out.push({ id, reason: s.reason, n: s.nudges, max: this.settings().nudges });
    }
    return out;
  }

  // For the chat's side panel.
  view(id) {
    const cfg = this.settings(), s = this.chats.get(id) || { nudges: 0, due: null, reason: null, paused: false, last: null };
    return { on: cfg.nudges > 0, max: cfg.nudges, minutes: cfg.minutes, nudges: s.nudges, paused: !!s.paused, gaveUp: !!s.gaveUp,
      due: s.due ? new Date(s.due).toISOString() : null, reason: s.reason ? REASONS[s.reason] || s.reason : null, last: s.last };
  }
}
