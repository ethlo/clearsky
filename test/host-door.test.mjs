import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HostDoor, hostRule, ruleMatches, stepLines, describeRequest, commandNotes, redact } from '../lib/host-door.mjs';

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

test('a VM command that gave up while its host was asked waits for the answer, then says to run it again', async () => {
  // Docker gives up on the proxy after a minute; the Allow came three seconds later.
  let release;
  const untold = new Map();
  const { d } = door({ answers: [() => new Promise((r) => { release = r; })],
    late: (cs, rule) => { for (const c of cs) untold.set(c.id, new Map([[rule, `Clearsky: ${rule} is allowed now.`]])); } });
  const request = d.decide({ host: 'registry.example.com', port: 443 });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(d.waiting('a').map((w) => w.rule), ['registry.example.com']);
  assert.deepEqual(d.waiting('b'), []);
  const note = commandNotes({ door: d, id: 'a', untold, code: 1, vm: true });
  release('chat');
  assert.equal(await request, true);
  const said = await note;
  assert.match(said, /registry\.example\.com is allowed now: run the command again/);
  assert.equal(said.match(/allowed now/g).length, 1, 'said once, not also as the late note');
  assert.equal(untold.has('a'), false);
  assert.deepEqual(d.waiting('a'), [], 'answered: no card waits');
});

test('a late Allow while the chat works goes into its next command\'s output; a card nobody answers isn\'t a Deny', async () => {
  const untold = new Map([['a', new Map([['example.org', 'Clearsky: example.org is allowed now.']])]]);
  const { d } = door();
  assert.equal(await commandNotes({ door: d, id: 'a', untold, code: 0 }), '\nClearsky: example.org is allowed now.\n');
  assert.equal(await commandNotes({ door: d, id: 'a', untold, code: 0 }), '', 'told once');
  // A failed command with nothing asked: nothing to say, no wait.
  assert.equal(await commandNotes({ door: d, id: 'a', untold, code: 1, vm: true }), '');

  let release;
  const { d: d2 } = door({ answers: [() => new Promise((r) => { release = r; })] });
  const request = d2.decide({ host: 'registry.example.com', port: 443 });
  await new Promise((r) => setImmediate(r));
  const note = commandNotes({ door: d2, id: 'a', untold, code: 1, vm: true });
  release('expired');
  assert.equal(await request, false);
  assert.match(await note, /still waits for the user's answer.*isn't unreachable/);
  // And one the user doesn't answer in time: the command doesn't wait for ever.
  const { d: d3 } = door({ holdMs: 20, answers: [() => new Promise(() => {})] });
  d3.decide({ host: 'registry.example.com', port: 443 });
  await new Promise((r) => setImmediate(r));
  assert.match(await commandNotes({ door: d3, id: 'a', untold, code: 1, vm: true, waitMs: 10 }), /still waits/);
});

test('a Deny while a VM command waited: it says so', async () => {
  let release;
  const { d } = door({ answers: [() => new Promise((r) => { release = r; })] });
  const request = d.decide({ host: 'registry.example.com', port: 443 });
  await new Promise((r) => setImmediate(r));
  const note = commandNotes({ door: d, id: 'a', untold: new Map(), code: 1, vm: true });
  release('deny');
  assert.equal(await request, false);
  assert.match(await note, /didn't allow it/);
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
  assert.match(asked[0].card.detail, /^example\.org:8443 \(not the web's own port/);
  assert.match(asked[0].card.note, /sending as well as reading/);
});

test('a card taken down at the end of the turn is not a Deny: the next turn asks again', async () => {
  const { d, asked } = door({ answers: ['expired', 'allow'] });
  assert.equal(await d.decide({ host: 'ref.example.org', port: 443 }), false);
  assert.equal(await d.decide({ host: 'ref.example.org', port: 443 }), true, 'asked again, not blocked as denied');
  assert.equal(asked.length, 2);
});

test('Copilot\'s fetch gives up after about 10 s: an Allow after 8 s tells the chat to try again', async () => {
  let t = 0;
  const told = [];
  const { d } = door({ now: () => t, answers: [() => { t = 9000; return 'allow'; }], late: (cs, rule) => told.push(rule) });
  assert.equal(await d.decide({ host: 'ref.example.org', port: 443 }), true);
  assert.deepEqual(told, ['ref.example.org']);
});

test('the first card names the agent\'s step that named the host, and says what it can\'t see yet', async () => {
  const steps = () => stepLines([
    { title: 'Viewing file', kind: 'read', input: { path: '/x/README.md' } },
    { title: 'Fetching web content', kind: 'fetch', input: { url: 'https://docs.example.org/guide?page=2' } },
  ], 'docs.example.org', 'Copilot');
  const { d, asked } = door({ steps, answers: ['deny'] });
  await d.decide({ host: 'docs.example.org', port: 443 });
  const card = asked[0].card.detail;
  assert.match(card, /^docs\.example\.org \(https\)\n/);
  assert.match(card, /Copilot's step that names it: Fetching web content: https:\/\/docs\.example\.org\/guide\?page=2/);
  assert.doesNotMatch(card, /README/);
  assert.match(asked[0].card.note, /can't see the request yet/);
  assert.match(asked[0].card.note, /HTTPS is encrypted/);
  assert.match(asked[0].card.note, /sending data asks again with what it sends/);
});

test('step lines: no step names the host, or none is running', () => {
  assert.deepEqual(stepLines([], 'a.example'), []);
  assert.deepEqual(stepLines([{ title: 'Run tests', kind: 'execute', input: { command: 'npm test' } }], 'a.example', 'Copilot'),
    ['Copilot\'s step running then (none names this host):', '  Run tests: npm test']);
});

test('no step running: the card says it is the agent itself or a program it started', async () => {
  const { d, asked } = door({ answers: ['deny'] });
  await d.decide({ host: 'telemetry.example', port: 443 });
  assert.match(asked[0].card.detail, /No step was running/);
});

test('reading an allowed host shows in the chat, once per address in a turn', async () => {
  const seen = [];
  const { d } = door({ answers: ['chat'], seen: (cs, line) => seen.push([cs.map((c) => c.id), line]) });
  await d.decide({ host: 'example.org', port: 443 });
  await d.check(new Request('https://example.org/a?b=1'));
  await d.check(new Request('https://example.org/a?b=1'));
  await d.check(new Request('https://listed.example/x'), { listed: (h) => h === 'listed.example' });
  assert.deepEqual(seen, [[['a'], 'GET example.org/a?b=1']]);
  d.turnEnded('a');
  await d.check(new Request('https://example.org/a?b=1'));
  assert.equal(seen.length, 2);
});

test('reads that differ only by a digest show as one line (a docker pull)', async () => {
  const seen = [];
  const { d } = door({ answers: ['chat'], seen: (cs, line) => seen.push(line) });
  await d.decide({ host: 'registry.example', port: 443 });
  const a = 'a'.repeat(64), b = 'b'.repeat(64);
  for (const p of [`blobs/sha256:${a}`, `blobs/sha256:${b}`, `manifests/sha256:${a}`, `manifests/sha256-${b}`, 'manifests/main']) {
    await d.check(new Request(`https://registry.example/v2/acme/app/${p}`));
  }
  assert.deepEqual(seen, ['GET registry.example/v2/acme/app/blobs/…', 'GET registry.example/v2/acme/app/manifests/…', 'GET registry.example/v2/acme/app/manifests/main']);
});

test('the sending card shows the request: address, size, headers (logins hidden) and the body', async () => {
  const { d, asked } = door({ answers: ['chat', 'deny'] });
  await d.decide({ host: 'api.example.org', port: 443 });
  const body = JSON.stringify({ model: 'demo', messages: [{ role: 'user', content: 'Hello from Acme' }] });
  await d.check(new Request('https://api.example.org/v1/messages?beta=true', { method: 'POST', body,
    headers: { 'content-type': 'application/json', 'content-length': String(body.length), 'x-api-key': 'fake_value_123', authorization: 'Bearer abc', 'user-agent': 'demo/1.0' } }));
  const card = asked[1].card.detail;
  assert.match(card, /^POST api\.example\.org\/v1\/messages\?beta=true\n/);
  assert.match(card, new RegExp(`Sends ${body.length} bytes \\(application/json\\)`));
  assert.match(card, /x-api-key: \(hidden, 14 characters\)/);
  assert.match(card, /authorization: \(hidden/);
  assert.match(card, /user-agent: demo\/1\.0/);
  assert.doesNotMatch(card, /abc|fake_value/);
  assert.match(card, /Body:\n\{"model":"demo".*\}$/);
  assert.equal(asked[1].card.note, 'You allowed reading api.example.org; this sends data there.');
});

test('describeRequest: long text bodies are cut, binary ones not shown, no body said so', async () => {
  const long = await describeRequest(new Request('https://a.example/up', { method: 'PUT', body: 'x'.repeat(5000), headers: { 'content-type': 'text/plain' } }));
  assert.match(long, /Sends (5000 bytes|at least [\d.]+ KB) \(text\/plain\)/);
  assert.match(long, /Body \(the start\):\nx{600}\n…/);
  const bin = await describeRequest(new Request('https://a.example/up', { method: 'POST', body: new Uint8Array([0, 1, 2, 255]), headers: { 'content-type': 'application/octet-stream' } }));
  assert.match(bin, /Body: not text \(application\/octet-stream\), not shown\./);
  const none = await describeRequest(new Request('https://a.example/x', { method: 'DELETE' }));
  assert.match(none, /Sends no body/);
});

test('describeRequest: logins in the body, the address and header values are hidden', async () => {
  const card = await describeRequest(new Request('https://login.example/v1/oauth/token?client_secret=s3cret&x=1', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-extra': 'Bearer abcdefghijklmnop' },
    body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: 'sk-ant-ort01-aaaaaaaaaaaaaaaa', client_id: 'id-1', password: 'pw' }),
  }));
  assert.doesNotMatch(card, /sk-ant-ort01|s3cret|abcdefghijklmnop|"pw"/);
  assert.match(card, /"refresh_token":"\(hidden, 29 characters\)"/);
  assert.match(card, /"client_id":"id-1"/); // what isn't a login still shows
  assert.match(card, /client_secret=\(hidden, 6 characters\)&x=1/);
});

test('redact: token shapes anywhere, form fields, a value cut at the preview end', () => {
  assert.equal(redact('grant_type=refresh_token&refresh_token=abc123&scope=x'), 'grant_type=refresh_token&refresh_token=(hidden, 6 characters)&scope=x');
  assert.equal(redact('see ghp_aaaaaaaaaaaaaaaaaaaaaaaa here'), 'see (hidden, 28 characters) here');
  assert.equal(redact('{"access_token":"abcdef'), '{"access_token":"(hidden, 6 characters)');
  assert.equal(redact('{"name":"token","tokens":3}'), '{"name":"token","tokens":3}');
});
