import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { vmSupport, mavenSettings, javaEnv, cloudConfig, VM_DOMAINS, VmImage, ChatVm } from '../lib/vm.mjs';
import { needs, serveBroker } from '../lib/broker.mjs';

test('whether this machine can run the VM, and why not', () => {
  assert.match(vmSupport({ platform: 'darwin' }).why, /Linux/);
  assert.match(vmSupport({ platform: 'linux', exists: () => false }).why, /kvm/);
  assert.match(vmSupport({ platform: 'linux', exists: () => true, has: (b) => b !== 'socat' }).why, /socat/);
  assert.deepEqual(vmSupport({ platform: 'linux', exists: () => true, has: () => true }), { ok: true });
});

test('the VM reaches Docker Hub (with its CDN) and Maven Central through the proxy', () => {
  for (const h of ['registry-1.docker.io', 'production.cloudfront.docker.com', '*.cloudflare.docker.com', 'repo.maven.apache.org']) assert.ok(VM_DOMAINS.includes(h), h);
  const s = mavenSettings({ port: 1, url: 'http://srt:tok3n@' });
  assert.match(s, /<host>10\.0\.2\.100<\/host><port>3128<\/port><username>srt<\/username><password>tok3n<\/password>/);
  assert.doesNotMatch(mavenSettings({ port: 1, url: 'http://' }), /username/);
});

test('the prepared image: our keys, Docker and Maven via the proxy, nothing left that slows a boot', () => {
  const c = cloudConfig({ key: 'ssh-ed25519 AAAA you\n', hostKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n', hostPub: 'ssh-ed25519 BBBB host\n', proxy: 'http://srt:t@10.0.2.100:3128' });
  assert.match(c, /^#cloud-config\n/);
  assert.match(c, /ed25519_private: \|\n    -----BEGIN OPENSSH PRIVATE KEY-----\n    abc\n/);
  assert.match(c, /http_proxy: http:\/\/srt:t@10\.0\.2\.100:3128/);
  assert.match(c, /packages: \[docker\.io, maven\]/);
  for (const s of ['systemctl disable docker.service docker.socket', 'snapd.seeded.service', 'systemd-networkd-wait-online', 'rm -f /etc/apt/apt.conf.d/90cloud-init-aptproxy', 'cloud-init clean --logs', 'cloud-init.disabled']) assert.ok(c.includes(s), s);
});

test('a command runs with your JDK only when it is one the VM has', () => {
  assert.equal(javaEnv('/usr/lib/jvm/java-25-openjdk-amd64'), " JAVA_HOME='/usr/lib/jvm/java-25-openjdk-amd64' PATH='/usr/lib/jvm/java-25-openjdk-amd64/bin':\"$PATH\"");
  assert.equal(javaEnv('/home/alex/.sdkman/candidates/java/21'), '');
  assert.equal(javaEnv('/usr/lib/jvm/x; rm -rf /'), '');
  assert.equal(javaEnv(null), '');
});

test('a chat\'s VM keeps a log and a view of what runs in it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vm-'));
  writeFileSync(join(dir, 'chat-dead.qcow2'), ''); // left by a Clearsky that crashed
  const image = new VmImage({ dir });
  assert.ok(!existsSync(join(dir, 'chat-dead.qcow2')));
  assert.equal(image.ready(), false);
  const vm = new ChatVm({ id: 'abc', cwd: '/work/repo', image, proxy: { port: 1, url: 'http://' }, hosts: ['repo1.maven.org'] });
  const seen = [];
  vm.onEvent = (e) => seen.push(e.text);
  for (let i = 0; i < 305; i++) vm.event(`e${i}`);
  assert.equal(vm.events.length, 300);
  assert.equal(vm.events[0].text, 'e5');
  assert.equal(seen.length, 305);
  const v = vm.view();
  assert.equal(v.state, 'off');
  assert.deepEqual(v.network.hosts, ['repo1.maven.org']);
  assert.equal(v.events.length, 150);
  assert.equal(v.shares[0], '/work/repo');
  assert.ok(vm.ssh('true').includes('StrictHostKeyChecking=yes'));
});

test('`vm <command>` runs without asking, and its output comes as it is written', async () => {
  assert.equal(needs('vm', ['./mvnw', 'verify']), 'run');
  assert.equal(needs('vm', []), 'no');
  const dir = mkdtempSync(join(tmpdir(), 'broker-vm-'));
  const path = join(dir, 's', 'broker.sock');
  const work = join(dir, 'work'); mkdirSync(work);
  const calls = [];
  const vm = async ({ key, argv, cwd, java }, out, err) => {
    calls.push([key, argv.join(' '), cwd, java]);
    out('first\n'); await new Promise((r) => setTimeout(r, 20)); err('warn\n'); out('ünïcode\n');
    return 3;
  };
  const server = serveBroker({ path, vm, where: (key) => (key === 'k1' ? [work] : null), ask: async () => { throw new Error('should not ask'); } });
  await new Promise((r) => server.once('listening', r));
  const bin = fileURLToPath(new URL('../scripts/sandbox-bin/vm', import.meta.url));
  const go = (env = {}) => new Promise((r) => execFile(process.execPath, [bin, './mvnw', 'verify'],
    { cwd: work, env: { ...process.env, CLEARSKY_BROKER_SOCKET: path, CLEARSKY_BROKER_KEY: 'k1', JAVA_HOME: '/usr/lib/jvm/java-21', ...env } }, (e, o, er) => r({ code: e ? e.code : 0, out: o, err: er })));
  try {
    const r = await go();
    assert.equal(r.code, 3);
    assert.equal(r.out, 'first\nünïcode\n');
    assert.equal(r.err, 'warn\n');
    assert.deepEqual(calls, [['k1', './mvnw verify', work, '/usr/lib/jvm/java-21']]);
    const closed = await go({ CLEARSKY_BROKER_KEY: 'gone' });
    assert.equal(closed.code, 1);
    assert.match(closed.err, /closed/);
  } finally { server.close(); }
  const none = serveBroker({ path, where: () => [work] });
  await new Promise((r) => none.once('listening', r));
  try {
    const r = await new Promise((done) => execFile(process.execPath, [bin, 'true'], { cwd: work, env: { ...process.env, CLEARSKY_BROKER_SOCKET: path, CLEARSKY_BROKER_KEY: 'k1' } }, (e, o, er) => done({ code: e ? e.code : 0, err: er })));
    assert.equal(r.code, 1);
    assert.match(r.err, /outside/);
  } finally { none.close(); }
});
