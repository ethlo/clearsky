import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { creditRecords, allCreditRecords, creditTotals, costRates, costOf, liveRate, startOfWeek, dayKey } from '../lib/credit-usage.mjs';
import { validate } from '../lib/settings.mjs';

const rec = (id, at, credits, model = 'Claude Opus 5.5') => JSON.stringify({ type: 'session.usage_record', timestamp: at && new Date(at).toISOString(),
  data: { usage: { modelDisplayName: model, outputTokens: 1, accounting: { usageId: id }, copilotUsage: credits == null ? undefined : { totalNanoAiu: credits * 1e9 } } } });

test('creditRecords: one per call with credits, repeats counted once, time from the log', () => {
  const t = Date.parse('2026-11-09T10:00:00Z');
  const text = [rec('a', t, 2), rec('a', t, 2), rec('b', null, 1.5), rec('c', t, null), '{"type":"user.message","data":{"content":"x"}}', 'not json'].join('\n');
  assert.deepEqual(creditRecords(text, 42), [{ at: t, credits: 2, model: 'Claude Opus 5.5' }, { at: 42, credits: 1.5, model: 'Claude Opus 5.5' }]);
});

test('creditTotals: today, week from Monday, month, all time, days, weeks and chats', () => {
  const now = new Date(2026, 10, 11, 15, 0).getTime(); // Wednesday 11 Nov 2026, local time
  const at = (y, m, d, h = 12) => new Date(y, m, d, h).getTime();
  const records = [
    { at: at(2026, 10, 11, 9), credits: 3, chat: 'one', model: 'A' },
    { at: at(2026, 10, 9), credits: 2, chat: 'two', model: 'B' }, // Monday
    { at: at(2026, 10, 8), credits: 5, chat: 'one', model: 'A' }, // Sunday: last week
    { at: at(2026, 9, 20), credits: 10, chat: 'three', model: 'A' }, // October
  ];
  const t = creditTotals(records, now, { dayCount: 4, weekCount: 3 });
  assert.equal(t.today, 3);
  assert.equal(t.week, 5);
  assert.equal(t.month, 10);
  assert.equal(t.total, 20);
  assert.equal(t.calls, 4);
  assert.deepEqual(t.days.map((d) => [d.date, d.credits]), [['2026-11-08', 5], ['2026-11-09', 2], ['2026-11-10', 0], ['2026-11-11', 3]]);
  assert.deepEqual(t.weeks.map((w) => [w.start, w.credits]), [['2026-10-26', 0], ['2026-11-02', 5], ['2026-11-09', 5]]);
  assert.deepEqual(t.chats, [{ id: 'one', credits: 3, models: ['A'] }, { id: 'two', credits: 2, models: ['B'] }]);
  assert.deepEqual(t.models, [{ model: 'A', credits: 18 }, { model: 'B', credits: 2 }]);
  assert.equal(dayKey(startOfWeek(at(2026, 10, 15))), '2026-11-09'); // a Sunday belongs to the week before
});

test('allCreditRecords: every session log, tagged with its chat', () => {
  const home = mkdtempSync(join(tmpdir(), 'cs-usage-'));
  try {
    for (const [id, n] of [['session-one', 2], ['session-two', 1]]) {
      mkdirSync(join(home, 'session-state', id), { recursive: true });
      writeFileSync(join(home, 'session-state', id, 'events.jsonl'), Array.from({ length: n }, (_, i) => rec(`${id}-${i}`, Date.now(), 1)).join('\n'));
    }
    mkdirSync(join(home, 'session-state', 'no-log-here'), { recursive: true });
    const r = allCreditRecords(home);
    assert.equal(r.length, 3);
    assert.deepEqual([...new Set(r.map((x) => x.chat))].sort(), ['session-one', 'session-two']);
    assert.deepEqual(allCreditRecords(join(home, 'nothing')), []);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('costRates and costOf: dollars per credit, then your currency', () => {
  assert.deepEqual(costOf(250, costRates({})), { usd: 2.5, local: null, currency: null });
  const r = costRates({ COPILOT_CREDIT_USD: '0.04', CLEARSKY_CURRENCY: 'nok', CLEARSKY_FX_RATE: '10,5' });
  assert.equal(r.usdPerCredit, 0.04);
  assert.equal(r.rateFrom, 'yours');
  assert.deepEqual(costOf(100, r), { usd: 4, local: 42, currency: 'NOK' });
  // Live rate on and looked up: it wins; for another currency it's ignored.
  const live = { currency: 'NOK', rate: 11, date: '2026-11-06' };
  assert.deepEqual(costOf(100, costRates({ COPILOT_CREDIT_USD: '0.04', CLEARSKY_CURRENCY: 'NOK', CLEARSKY_FX_RATE: '10.5', CLEARSKY_FX_LIVE: 'on' }, live)), { usd: 4, local: 44, currency: 'NOK' });
  assert.equal(costRates({ CLEARSKY_CURRENCY: 'EUR', CLEARSKY_FX_RATE: '0.9', CLEARSKY_FX_LIVE: 'on' }, live).rate, 0.9);
  // A currency without a rate: dollars only.
  assert.deepEqual(costOf(100, costRates({ CLEARSKY_CURRENCY: 'SEK' })), { usd: 1, local: null, currency: 'SEK' });
  assert.equal(costRates({ CLEARSKY_CURRENCY: 'USD' }).currency, null);
  assert.equal(costOf(null, r), null);
});

test('liveRate: looks up once, keeps it, falls back to what it had', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cs-fx-'));
  const file = join(dir, 'fx.json');
  let calls = 0;
  const ok = async (url) => { calls++; assert.match(url, /base=USD&symbols=NOK$/); return { ok: true, json: async () => ({ date: '2026-11-06', rates: { NOK: 10.9 } }) }; };
  const down = async () => { calls++; throw new Error('offline'); };
  try {
    assert.equal(await liveRate('USD', file, { fetchImpl: ok }), null);
    assert.equal(await liveRate('NOK', file, { fetchImpl: down }), null);
    const got = await liveRate('NOK', file, { fetchImpl: ok, now: 1000 });
    assert.deepEqual({ rate: got.rate, date: got.date }, { rate: 10.9, date: '2026-11-06' });
    assert.equal((await liveRate('NOK', file, { fetchImpl: ok, now: 2000 })).rate, 10.9);
    assert.equal(calls, 2); // the second came from the file
    assert.equal((await liveRate('NOK', file, { fetchImpl: down, now: 1000 + 13 * 36e5 })).rate, 10.9); // stale beats nothing
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('settings: credit price, currency and rate are checked', () => {
  assert.deepEqual(validate({ COPILOT_CREDIT_USD: '0,01', CLEARSKY_CURRENCY: 'nok', CLEARSKY_FX_RATE: '10.5', CLEARSKY_FX_LIVE: 'on' }),
    { COPILOT_CREDIT_USD: '0.01', CLEARSKY_CURRENCY: 'NOK', CLEARSKY_FX_RATE: '10.5', CLEARSKY_FX_LIVE: 'on' });
  assert.throws(() => validate({ COPILOT_CREDIT_USD: 'free' }), /Dollars per credit/);
  assert.throws(() => validate({ CLEARSKY_FX_RATE: '0' }), /Rate/);
  assert.throws(() => validate({ CLEARSKY_CURRENCY: 'kroner' }), /three-letter/);
  assert.deepEqual(validate({ COPILOT_CREDIT_USD: '', CLEARSKY_CURRENCY: '' }), { COPILOT_CREDIT_USD: '', CLEARSKY_CURRENCY: '' });
});
