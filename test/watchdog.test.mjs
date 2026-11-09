import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unfinished, Watchdog, watchdogSettings, nudgeText, AUTO_MARK } from '../lib/watchdog.mjs';
import { validate } from '../lib/settings.mjs';

test('which turn endings look unfinished', () => {
  assert.equal(unfinished({ stopReason: 'end_turn', text: 'All done: PR #12 is up and CI is green.' }), null);
  assert.equal(unfinished({ stopReason: 'end_turn', text: 'Which one do you want?' }), null);
  assert.equal(unfinished({ stopReason: 'end_turn', text: 'Pick one:\n```choices\nWhich?\n- A | a\n```' }), null);
  assert.equal(unfinished({ stopReason: 'end_turn', text: 'Fixed it. Next I\'ll run the integration tests.' }), 'said-more');
  assert.equal(unfinished({ stopReason: 'end_turn', text: 'Now let me check the CI run:' }), 'mid-step');
  assert.equal(unfinished({ stopReason: 'end_turn', text: 'I can also add a test if you like. Let me know.' }), null);
  assert.equal(unfinished({ stopReason: 'end_turn', text: '' }), 'silent');
  assert.equal(unfinished({ stopReason: 'max_tokens', text: 'x' }), 'cut-off');
  assert.equal(unfinished({ stopReason: 'max_turn_requests' }), 'turn-limit');
  assert.equal(unfinished({ error: 'Copilot stopped (exit 1)' }), 'error');
  assert.equal(unfinished({ stopReason: 'cancelled', stopped: true }), null, 'you pressed Stop');
  assert.equal(unfinished({ stopReason: 'cancelled' }), null);
  assert.equal(unfinished({ stopReason: 'cancelled', stuck: true }), 'stuck');
  assert.equal(unfinished({ stopReason: 'refusal', text: '' }), null);
});

test('nudges are capped per task, wait a while, and start again with your message', () => {
  let now = 0;
  const cfg = { nudges: 2, minutes: 2, stuckMinutes: 15 };
  const w = new Watchdog({ settings: () => cfg, now: () => now });
  assert.equal(w.turnEnded('c', { stopReason: 'end_turn', text: 'Done.' }), null);
  assert.equal(w.turnEnded('c', { stopReason: 'end_turn', text: 'Next I will push.' }), 'said-more');
  assert.deepEqual(w.due(), [], 'not yet: you may answer first');
  now += 2 * 6e4;
  assert.deepEqual(w.due(), [{ id: 'c', reason: 'said-more', n: 1, max: 2 }]);
  assert.deepEqual(w.due(), [], 'once');
  w.turnEnded('c', { stopReason: 'max_tokens' });
  now += 2 * 6e4;
  assert.equal(w.due(() => false).length, 0, 'busy: skipped');
  w.turnEnded('c', { stopReason: 'max_tokens' });
  now += 2 * 6e4;
  assert.equal(w.due()[0].n, 2);
  assert.equal(w.turnEnded('c', { stopReason: 'max_tokens' }), null, 'cap reached');
  assert.equal(w.view('c').gaveUp, true);
  w.userMessage('c');
  assert.equal(w.turnEnded('c', { stopReason: 'max_tokens' }), 'cut-off');
  assert.equal(w.view('c').nudges, 0);
  // Paused for this chat, and the watchdog off.
  w.pause('c', true);
  assert.equal(w.turnEnded('c', { stopReason: 'max_tokens' }), null);
  w.pause('c', false);
  cfg.nudges = 0;
  assert.equal(w.turnEnded('c', { stopReason: 'max_tokens' }), null);
  // A stuck turn goes on at once.
  cfg.nudges = 3;
  w.turnEnded('d', { stopReason: 'cancelled', stuck: true });
  now += 5000;
  assert.equal(w.due()[0].reason, 'stuck');
  // Busy again: nothing due.
  w.turnEnded('e', { stopReason: 'max_tokens' });
  w.cancel('e');
  now += 10 * 6e4;
  assert.deepEqual(w.due(), []);
});

test('settings and the nudge itself', () => {
  assert.deepEqual(watchdogSettings({}), { nudges: 3, minutes: 2, stuckMinutes: 15 });
  assert.deepEqual(watchdogSettings({ COPILOT_NUDGES: '0', COPILOT_NUDGE_MINUTES: '500', COPILOT_STUCK_MINUTES: '1' }), { nudges: 0, minutes: 60, stuckMinutes: 5 });
  assert.equal(validate({ COPILOT_NUDGES: '5' }).COPILOT_NUDGES, '5');
  assert.throws(() => validate({ COPILOT_NUDGES: '11' }), /0 to 10/);
  assert.throws(() => validate({ COPILOT_NUDGE_MINUTES: '0' }), /1 to 60/);
  assert.throws(() => validate({ COPILOT_STUCK_MINUTES: '2' }), /5 to 120/);
  const t = nudgeText('cut-off', 1, 3);
  assert.ok(t.startsWith(AUTO_MARK));
  assert.match(t, /cut off.*Carry on.*\(Nudge 1 of 3\.\)/s);
});
