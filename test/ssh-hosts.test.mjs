import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sshHosts, groupOf } from '../lib/ssh-hosts.mjs';

test('named hosts from the config and its includes, with first-wins settings and jump hosts', () => {
  const home = mkdtempSync(join(tmpdir(), 'ssh-'));
  mkdirSync(join(home, '.ssh', 'config.d'), { recursive: true });
  writeFileSync(join(home, '.ssh', 'config'), 'Include config.d/*\n\nHost *\n  User fallback\n  Port 22\n');
  writeFileSync(join(home, '.ssh', 'config.d', 'acme'), 'Host acme-jump\n  HostName jump.example.com\n\nHost acme-test-* !acme-test-direct\n  ProxyJump acme-jump\n  User ops\n\n# The database\nHost acme-test-db acme-test-direct\n  HostName=10.0.0.5\n  Port 2222\n  LocalForward 5432 localhost:5432\n');
  const hosts = sshHosts(join(home, '.ssh', 'config'), { home });
  assert.deepEqual(hosts.map((h) => h.name), ['acme-jump', 'acme-test-db', 'acme-test-direct']);
  const [jump, db, direct] = hosts;
  assert.equal(jump.isJump, true);
  assert.equal(jump.user, 'fallback');
  assert.deepEqual({ host: db.host, user: db.user, port: db.port, jump: db.jump, forwards: db.forwards, note: db.note, group: db.group, file: db.file },
    { host: '10.0.0.5', user: 'ops', port: 2222, jump: 'acme-jump', forwards: 1, note: 'The database', group: 'acme', file: 'acme' });
  assert.equal(direct.jump, null, 'a negated pattern keeps the jump off');
  assert.equal(direct.user, 'fallback');
});

test('no config, no hosts; groups come from the start of the name', () => {
  assert.deepEqual(sshHosts('/nonexistent/config'), []);
  assert.equal(groupOf('mig-dr-core'), 'mig');
  assert.equal(groupOf('db1.example.com'), 'db1');
  assert.equal(groupOf('laptop'), 'other');
});
