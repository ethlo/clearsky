import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pushConfig, pushMessage, sendPush, duePush } from '../lib/push.mjs';

test('push settings: https topic, or none', () => {
  assert.equal(pushConfig({}), null);
  assert.equal(pushConfig({ PUSH_URL: 'http://ntfy.sh/x' }), null);
  assert.equal(pushConfig({ PUSH_URL: 'not a url' }), null);
  assert.deepEqual(pushConfig({ PUSH_URL: 'https://ntfy.sh/abc' }), { url: 'https://ntfy.sh/abc', token: null, full: false, afterMs: 60_000 });
  assert.equal(pushConfig({ PUSH_URL: 'https://ntfy.sh/abc', PUSH_AFTER_SECONDS: '0', PUSH_DETAIL: 'full' }).afterMs, 0);
});

test('short pushes name nothing; full ones say what waits', () => {
  const waits = [{ chat: 'PAY-412 · payments-api#479', title: 'git push to acme/payments-api' }, { chat: null, title: 'Jira: move PAY-1' }];
  const short = pushMessage(waits);
  assert.equal(short.title, 'Clearsky: 2 things need your OK');
  assert.doesNotMatch(short.body, /PAY|acme/);
  const full = pushMessage(waits, { full: true });
  assert.match(full.body, /PAY-412 · payments-api#479: git push to acme\/payments-api\nJira: move PAY-1/);
  assert.match(pushMessage(Array(7).fill(waits[1]), { full: true }).body, /and 2 more$/);
});

test('a card is pushed once, after it has waited long enough', () => {
  const seen = new Map(), pushed = new Set(), afterMs = 60_000;
  const cards = [{ id: 'a' }];
  assert.equal(duePush(cards, { seen, pushed, afterMs, now: 0 }).due.length, 0);
  const d = duePush(cards, { seen, pushed, afterMs, now: 61_000 }).due;
  assert.deepEqual(d.map((c) => c.id), ['a']);
  pushed.add('a');
  assert.equal(duePush(cards, { seen, pushed, afterMs, now: 200_000 }).due.length, 0);
  duePush([], { seen, pushed, afterMs, now: 201_000 }); // answered: forgotten
  assert.equal(seen.size + pushed.size, 0);
});

test('sending: ASCII title header, token, and ntfy errors', async () => {
  let got;
  const fetchFn = async (url, o) => { got = { url, o }; return { ok: true }; };
  await sendPush({ url: 'https://ntfy.sh/t', token: 'tk_1' }, { title: 'Clearsky: “OK” ✓', body: 'Bodies keep “UTF-8”' }, { fetchFn });
  assert.equal(got.o.headers.Title, 'Clearsky: OK ');
  assert.equal(got.o.headers.Authorization, 'Bearer tk_1');
  assert.equal(got.o.body, 'Bodies keep “UTF-8”');
  await assert.rejects(sendPush({ url: 'https://ntfy.sh/t' }, { title: 't', body: 'b' }, { fetchFn: async () => ({ ok: false, status: 403 }) }), /403: check the access token/);
});
