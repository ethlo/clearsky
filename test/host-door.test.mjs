import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HostDoor, hostRule, ruleMatches } from '../lib/host-door.mjs';

const chat = (id, mode = 'sandboxed') => ({ id, mode });
function door({ chats = [chat('a')], answers = [], ...rest } = {}) {
  const asked = [], always = [];
  const d = new HostDoor({
    chats: () => chats,
    ask: async (card, cs, info) => { asked.push({ card, chats: cs.map((c) => c.id), info }); return typeof answers[0] === 'function' ? answers.shift()() : answers.shift(); },
    always: () => always, addAlways: (r) => always.push(r), ...rest,
  });
  return { d, asked, always };
}

test('rules: port only when not the web\'s own, wildcards cover subdomains', () => {
  assert.equal(hostRule('WWW.rfc-editor.org.', 443), 'www.rfc-editor.org');
  assert.equal(hostRule('docs.example.org', 8443), 'docs.example.org:8443');
  assert.ok(ruleMatches('www.rfc-editor.org', 'www.rfc-editor.org', 443));
  assert.ok(!ruleMatches('www.rfc-editor.org', 'www.rfc-editor.org', 22));
  assert.ok(ruleMatches('*.example.org', 'a.example.org', 443));
  assert.ok(!ruleMatches('*.example.org', 'example.org', 443));
  assert.ok(!ruleMatches('*.example.org', 'badexample.org', 443));
  assert.ok(ruleMatches('docs.example.org:8443', 'docs.example.org', 8443));
});

test('a new host asks once in the chat; Allow lasts for the turn', async () => {
  const { d, asked } = door({ answers: ['allow'] });
  assert.equal(await d.decide({ host: 'www.rfc-editor.org', port: 443 }), true);
  assert.equal(asked.length, 1);
  assert.match(asked[0].card.detail, /www\.rfc-editor\.org \(https\)/);
  assert.deepEqual(asked[0].card.options.map((o) => o.id), ['allow', 'chat', 'always', 'deny']);
  assert.equal(await d.decide({ host: 'www.rfc-editor.org', port: 443 }), true, 'same turn: no second card');
  assert.equal(asked.length, 1);
  d.turnEnded('a');
  assert.equal(await d.decide({ host: 'www.rfc-editor.org', port: 443 }), false, 'next turn asks again (and here is denied)');
  assert.equal(asked.length, 2);
});

test('many connections to one host make one card', async () => {
  let release;
  const { d, asked } = door({ answers: [() => new Promise((r) => { release = r; })] });
  const all = Promise.all([1, 2, 3].map(() => d.decide({ host: 'example.org', port: 443 })));
  await new Promise((r) => setImmediate(r));
  release('chat');
  assert.deepEqual(await all, [true, true, true]);
  assert.equal(asked.length, 1);
});

test('"in this chat" outlives the turn; "always" goes to Settings; deny blocks', async () => {
  const { d, always, asked } = door({ answers: ['chat', 'always', 'deny', 'deny'] });
  assert.equal(await d.decide({ host: 'a.example', port: 443 }), true);
  d.turnEnded('a');
  assert.equal(await d.decide({ host: 'a.example', port: 443 }), true);
  assert.equal(await d.decide({ host: 'b.example', port: 443 }), true);
  assert.deepEqual(always, ['b.example']);
  assert.equal(await d.decide({ host: 'c.example', port: 443 }), false);
  assert.equal(await d.decide({ host: 'c.example', port: 443 }), false, 'a retry in the same turn: no new card');
  assert.equal(asked.length, 3);
  d.turnEnded('a');
  assert.equal(await d.decide({ host: 'c.example', port: 443 }), false);
  assert.equal(asked.length, 4, 'next turn asks again');
});

test('nobody working: blocked without a card; Full mode lets it through', async () => {
  const none = door({ chats: [] });
  assert.equal(await none.d.decide({ host: 'example.org', port: 443 }), false);
  assert.equal(none.asked.length, 0);
  const full = door({ chats: [chat('a', 'full')] });
  assert.equal(await full.d.decide({ host: 'example.org', port: 443 }), true);
  assert.equal(full.asked.length, 0);
});

test('with two chats working, one chat\'s allowance doesn\'t let the other through', async () => {
  const chats = [chat('a')];
  const { d, asked } = door({ chats, answers: ['chat', 'deny'] });
  assert.equal(await d.decide({ host: 'example.org', port: 443 }), true);
  chats.push(chat('b'));
  assert.equal(await d.decide({ host: 'example.org', port: 443 }), false);
  assert.deepEqual(asked[1].chats, ['a', 'b']);
});

test('no answer in time: the request is blocked, a later Allow tells the chat to try again', async () => {
  let release;
  const told = [];
  const { d } = door({ holdMs: 10, answers: [() => new Promise((r) => { release = r; })], late: (cs, rule) => told.push([cs.map((c) => c.id), rule]) });
  assert.equal(await d.decide({ host: 'example.org', port: 443 }), false);
  release('chat');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(told, [[['a'], 'example.org']]);
  assert.equal(await d.decide({ host: 'example.org', port: 443 }), true);
});

test('a slow Allow (past the request\'s own patience) also tells the chat', async () => {
  let t = 0;
  const told = [];
  const { d } = door({ now: () => t, lateMs: 1000, answers: [() => { t = 5000; return 'allow'; }], late: (cs, rule) => told.push(rule) });
  assert.equal(await d.decide({ host: 'example.org', port: 443 }), true);
  assert.deepEqual(told, ['example.org']);
});

test('reading an allowed host goes through; sending data there asks', async () => {
  const { d, asked } = door({ answers: ['chat', 'deny', 'allow'] });
  await d.decide({ host: 'example.org', port: 443 });
  assert.equal(await d.check(new Request('https://example.org/rfc/rfc9457.txt')), null);
  const post = () => new Request('https://example.org/upload', { method: 'POST', body: 'x' });
  const no = await d.check(post());
  assert.equal(no.action, 'deny');
  assert.match(no.reason, /declined: POST example\.org\/upload/);
  assert.match(asked[1].card.detail, /^POST example\.org\/upload/);
  assert.deepEqual(await d.check(post()), { action: 'allow' });
  // Hosts on the sandbox's own list, and ones never allowed here, aren't the door's to judge.
  assert.equal(await d.check(new Request('https://other.example/x', { method: 'POST', body: 'x' })), null);
  assert.equal(await d.check(post(), { listed: () => true }), null);
});

test('the card says when Clearsky can\'t keep a host read only', async () => {
  const { d, asked } = door({ readable: () => false, answers: ['deny'] });
  await d.decide({ host: 'example.org', port: 8443 });
  assert.match(asked[0].card.detail, /^example\.org:8443\n/);
  assert.match(asked[0].card.detail, /sending as well as reading/);
});
