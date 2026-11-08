import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkTarget, reachable, vpnWatch } from '../lib/vpn.mjs';

test('VPN: checked against a host behind it, and only noticed', async () => {
  assert.deepEqual(checkTarget({ VPN_CHECK: 'jira.internal.example.com:8443' }), { host: 'jira.internal.example.com', port: 8443 });
  assert.deepEqual(checkTarget({ VPN_CHECK: 'wiki.example.com' }), { host: 'wiki.example.com', port: 443, url: 'https://wiki.example.com/' });
  assert.deepEqual(checkTarget({ VPN_CHECK: 'http://wiki.example.com:8080/ping' }), { host: 'wiki.example.com', port: 8080, url: 'http://wiki.example.com:8080/ping' });
  assert.deepEqual(checkTarget({}, ['https://grafana.test.example.com']), { host: 'grafana.test.example.com', port: 443, url: 'https://grafana.test.example.com/api/health' });
  assert.equal(checkTarget({}, []), null);
  const down = await reachable({ host: 'x.example', port: 443 }, { resolve: async () => { throw new Error('ENOTFOUND'); } });
  assert.deepEqual(down, { up: false, why: 'x.example doesn\'t resolve' });
  // A host anyone can connect to that refuses you at the load balancer off the VPN
  const { EventEmitter } = await import('node:events');
  const open = () => { const s = new EventEmitter(); s.destroy = () => {}; setImmediate(() => s.emit('connect')); return s; };
  const t = { host: 'g.example.com', port: 443, url: 'https://g.example.com/api/health' };
  assert.equal((await reachable(t, { resolve: async () => {}, open, ask: async () => 403 })).up, false);
  assert.equal((await reachable(t, { resolve: async () => {}, open, ask: async () => 'timeout' })).up, false);
  assert.equal((await reachable(t, { resolve: async () => {}, open, ask: async () => 200 })).up, true);
  assert.equal((await reachable(t, { resolve: async () => {}, open, ask: async () => 'answered' })).up, true, 'a TLS complaint still reached it');
  assert.equal((await reachable({ host: 'h', port: 22 }, { resolve: async () => {}, open, ask: async () => 403 })).up, true, 'no web check for non-web ports');
  let n = 0;
  const w = vpnWatch({ target: () => ({ host: 'h', port: 1 }), probe: async () => { n++; return { up: false, why: 'no' }; } });
  assert.equal((await w.check()).up, false);
  await w.check();
  assert.equal(n, 1, 'checked at most once a minute');
  await w.check(true);
  assert.equal(n, 2);
});

