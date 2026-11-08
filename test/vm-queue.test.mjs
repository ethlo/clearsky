import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VmQueue, vmMax } from '../lib/vm-queue.mjs';
import { validate } from '../lib/settings.mjs';

const tick = () => new Promise((r) => setImmediate(r));
const state = (p) => Promise.race([p.then(() => 'in', () => 'out'), tick().then(() => 'waiting')]);

test('how many VMs at once: 1 unless set to 1 to 8', () => {
  assert.equal(vmMax({}), 1);
  assert.equal(vmMax({ COPILOT_VM_MAX: '' }), 1);
  assert.equal(vmMax({ COPILOT_VM_MAX: '3' }), 3);
  assert.equal(vmMax({ COPILOT_VM_MAX: '0' }), 1);
  assert.equal(vmMax({ COPILOT_VM_MAX: '40' }), 8);
  assert.equal(vmMax({ COPILOT_VM_MAX: 'lots' }), 1);
  assert.equal(validate({ COPILOT_VM_MAX: '2' }).COPILOT_VM_MAX, '2');
  assert.throws(() => validate({ COPILOT_VM_MAX: '0' }), /1 to 8/);
  assert.throws(() => validate({ COPILOT_VM_MAX: 'two' }), /1 to 8/);
});

test('a second chat waits while the first one builds, and starts when it ends', async () => {
  const q = new VmQueue({ limit: () => 1 });
  const evicted = [], told = [];
  const a = {}, b = {};
  await q.enter(a, { evict: () => { evicted.push('a'); q.drop(a); } });
  const pb = q.enter(b, { evict: () => evicted.push('b'), notify: (n) => told.push(n) });
  assert.equal(await state(pb), 'waiting');
  assert.equal(q.position(b), 1);
  assert.deepEqual(told, [{ position: 1, waiting: 1, limit: 1 }]);
  assert.deepEqual(q.view(b), { limit: 1, running: 1, waiting: 1, position: 1 });
  // The first chat's own next command doesn't wait behind anyone.
  await q.enter(a);
  q.leave(a);
  assert.equal(await state(pb), 'waiting');
  q.leave(a);
  assert.equal(await state(pb), 'in');
  assert.deepEqual(evicted, ['a']);
  assert.equal(q.position(b), null);
  assert.equal((await pb).waited, true);
});

test('an idle VM makes room right away; first come first served after it', async () => {
  const q = new VmQueue({ limit: () => 1 });
  const a = {}, b = {}, c = {};
  const evicted = [];
  await q.enter(a, { evict: () => evicted.push('a') });
  q.leave(a); // nothing runs in it: it stays up until someone needs the place
  assert.deepEqual(evicted, []);
  const pb = q.enter(b, { evict: () => evicted.push('b') });
  assert.equal(await state(pb), 'in');
  assert.deepEqual(evicted, ['a']);
  const pc = q.enter(c, {});
  const pa = q.enter(a, {});
  assert.equal(q.position(c), 1);
  assert.equal(q.position(a), 2);
  q.leave(b);
  assert.equal(await state(pc), 'in');
  assert.equal(await state(pa), 'waiting');
});

test('stopping a waiting command or its chat takes it out of the line', async () => {
  const q = new VmQueue({ limit: () => 1 });
  const a = {}, b = {}, c = {};
  await q.enter(a, {});
  const ac = new AbortController();
  const pb = q.enter(b, { signal: ac.signal });
  const told = [];
  const pc = q.enter(c, { notify: (n) => told.push(n.position) });
  ac.abort();
  await assert.rejects(pb, { name: 'AbortError' });
  assert.deepEqual(told, [2, 1]);
  q.drop(c, 'closed');
  await assert.rejects(pc, /closed/);
  assert.equal(q.view().waiting, 0);
  // The running chat's VM stopping (idle, closed) frees its place.
  const pd = q.enter(b, {});
  q.drop(a);
  assert.equal(await state(pd), 'in');
});

test('more places in Settings let whoever waits start', async () => {
  let limit = 1;
  const q = new VmQueue({ limit: () => limit });
  const a = {}, b = {};
  await q.enter(a, {});
  const pb = q.enter(b, {});
  assert.equal(await state(pb), 'waiting');
  limit = 2;
  q.pump();
  assert.equal(await state(pb), 'in');
  assert.equal(q.view().running, 2);
});
