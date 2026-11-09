// Clearsky's VM: where a chat's builds that need Docker run (Testcontainers), instead of
// `outside` on your machine. A throwaway virtual machine (QEMU with KVM, no sudo) with its own
// kernel and its own Docker; a container that breaks out lands in the VM, not on your machine.
// - It sees only the chat's folder (read-write), your JDKs and your Maven repository (read only).
//   Your home, keys and Docker don't exist in there.
// - Its network goes nowhere but srt's proxy: the sandbox's allowed hosts, logins added on the
//   way out, and the GitHub gate. Containers can't reach the internet or your machine.
// - One VM per chat, started on its first `vm <command>`, stopped when the chat closes or after
//   30 idle minutes; its disk is an overlay on a prepared image, deleted with it.
// The prepared image (Ubuntu's cloud image with Docker and Maven) is made once, the first time,
// and a snapshot of it booted: a chat's VM resumes from that in about a second.

import { spawn, execFile } from 'node:child_process';
import { createServer as httpServer } from 'node:http';
import { createServer as netServer, connect as netConnect } from 'node:net';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, statSync, createWriteStream, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { homedir, availableParallelism, totalmem } from 'node:os';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

// Hosts the VM needs besides the sandbox's: Ubuntu's packages (making the image), Docker Hub
// (images for tests) and Maven Central.
export const VM_DOMAINS = ['archive.ubuntu.com', 'security.ubuntu.com', '*.archive.ubuntu.com',
  'docker.io', 'index.docker.io', 'registry-1.docker.io', 'auth.docker.io', 'production.cloudfront.docker.com', '*.cloudflare.docker.com',
  'repo.maven.apache.org', 'repo1.maven.org'];
const IMAGE_DIR = 'https://cloud-images.ubuntu.com/releases/resolute/release/';
const IMAGE = 'ubuntu-26.04-server-cloudimg-amd64.img';
const PROXY_IN_VM = { host: '10.0.2.100', port: 3128 };
// Bumped when the prepared image's settings change: the image (and its snapshot) is made again.
const IMAGE_VERSION = 2;
const SEED_IN_VM = '10.0.2.101';
const USER = 'clearsky';
const IDLE_MS = 30 * 6e4;

const run = (cmd, args, opts = {}) => new Promise((done, fail) =>
  execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, ...opts }, (e, stdout, stderr) => (e ? fail(Object.assign(e, { stderr })) : done(String(stdout)))));
const freePort = () => new Promise((done) => { const s = netServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => done(port)); }); });
const q = (a) => `'${String(a).replace(/'/g, `'\\''`)}'`;
const onPath = (bin, env = process.env) => (env.PATH || '').split(':').some((d) => d && existsSync(join(d, bin)));

// QEMU processes still running, stopped (and their disks deleted) when Clearsky exits.
const live = new Set(), snapshotting = new Set();
process.on('exit', () => {
  for (const vm of live) { try { vm.qemu?.kill('SIGKILL'); } catch {} rmSync(vm.overlay, { force: true }); }
  for (const p of snapshotting) { try { p.kill('SIGKILL'); } catch {} }
});

// QEMU processes a Clearsky left behind: one that was killed outright (kill -9, the OOM killer)
// gets no chance to stop its VMs, and they would go on holding memory, CPU and a deleted disk.
// Any qemu-system process whose command line points into Clearsky's VM folder is ours, and is
// stopped. Linux only (where the VM runs); returns the pids stopped.
export function reapOrphans(dir = join(homedir(), '.cache', 'clearsky', 'vm'), { proc = '/proc', kill = process.kill, self = live } = {}) {
  if (process.platform !== 'linux' && proc === '/proc') return [];
  const mine = new Set([...self].map((vm) => vm.qemu?.pid).filter(Boolean));
  const out = [];
  let pids = [];
  try { pids = readdirSync(proc).filter((x) => /^\d+$/.test(x)); } catch { return out; }
  for (const pid of pids) {
    let args;
    try { args = readFileSync(join(proc, pid, 'cmdline'), 'utf8').split('\0'); } catch { continue; }
    if (!/(^|\/)qemu-system-/.test(args[0] || '') || mine.has(Number(pid))) continue;
    if (!args.some((a) => a.includes(`${dir}/`))) continue;
    try { kill(Number(pid), 'SIGKILL'); out.push(Number(pid)); } catch { /* not ours to stop, or gone */ }
  }
  return out;
}

// Whether this machine can run Clearsky's VM, and if not, why.
export function vmSupport({ platform = process.platform, exists = existsSync, has = onPath } = {}) {
  if (platform !== 'linux') return { ok: false, why: 'the VM needs Linux (KVM) for now' };
  if (!exists('/dev/kvm')) return { ok: false, why: 'no /dev/kvm (virtualisation off, or not allowed for you)' };
  for (const bin of ['qemu-system-x86_64', 'qemu-img', 'ssh', 'ssh-keygen', 'socat']) if (!has(bin)) return { ok: false, why: `${bin} isn't installed` };
  return { ok: true };
}

// The image every chat's VM starts from: made once, kept in `dir`.
export class VmImage {
  constructor({ dir = join(homedir(), '.cache', 'clearsky', 'vm'), log = () => {} } = {}) {
    Object.assign(this, { dir, log, base: join(dir, IMAGE), prepared: join(dir, `prepared-${IMAGE_VERSION}.qcow2`), key: join(dir, 'id_ed25519'),
      hostKey: join(dir, 'host_ed25519'), knownHosts: join(dir, 'known_hosts'), snapDisk: join(dir, 'snapshot.qcow2'), snapState: join(dir, 'snapshot.state'),
      snapStamp: join(dir, 'snapshot.json'), empty: join(dir, 'empty') });
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    mkdirSync(this.empty, { recursive: true });
    // Images made by an older Clearsky (their settings changed since).
    for (const f of readdirSync(dir)) if (/^prepared(-\d+)?\.qcow2$/.test(f) && join(dir, f) !== this.prepared) rmSync(join(dir, f), { force: true });
    // VMs, and their disks, from a Clearsky that didn't get to clean up.
    const reaped = reapOrphans(dir);
    if (reaped.length) log(`clearsky: stopped ${reaped.length} VM${reaped.length > 1 ? 's' : ''} left running by an earlier Clearsky`);
    for (const f of readdirSync(dir)) if (/^chat-[\w-]+\.(qcow2|log|qmp)$/.test(f)) rmSync(join(dir, f), { force: true });
  }

  ready() { return existsSync(this.prepared) && existsSync(this.key) && existsSync(this.knownHosts); }

  // Download Ubuntu's cloud image (checked against its SHA256SUMS), then boot it once with
  // cloud-init to install Docker and Maven and switch off what slows a boot down.
  async prepare(proxy, say = () => {}) {
    if (this.ready()) return;
    if (this.preparing) return this.preparing;
    this.preparing = this.#prepare(proxy, say).finally(() => { this.preparing = null; });
    return this.preparing;
  }

  async #prepare(proxy, say) {
    if (!existsSync(this.key)) await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'clearsky-vm', '-f', this.key]);
    // The VM's own host key, made here so ssh can check it's talking to this VM.
    if (!existsSync(this.hostKey)) await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'clearsky-vm-host', '-f', this.hostKey]);
    writeFileSync(this.knownHosts, `${HOST_ALIAS} ${readFileSync(`${this.hostKey}.pub`, 'utf8').trim()}\n`, { mode: 0o600 });
    if (!existsSync(this.base)) {
      say('Downloading Ubuntu\'s cloud image (about 800 MB, once)');
      const sums = await (await fetch(`${IMAGE_DIR}SHA256SUMS`)).text();
      const want = (sums.split('\n').find((l) => l.endsWith(`*${IMAGE}`) || l.endsWith(` ${IMAGE}`)) || '').split(/\s+/)[0];
      if (!/^[0-9a-f]{64}$/.test(want)) throw new Error('no checksum for the VM image');
      const tmp = `${this.base}.part`, hash = createHash('sha256');
      const res = await fetch(`${IMAGE_DIR}${IMAGE}`);
      if (!res.ok) throw new Error(`downloading the VM image: ${res.status}`);
      await pipeline(Readable.fromWeb(res.body).on('data', (c) => hash.update(c)), createWriteStream(tmp));
      if (hash.digest('hex') !== want) { rmSync(tmp, { force: true }); throw new Error('the VM image doesn\'t match its checksum'); }
      renameSync(tmp, this.base);
    }
    say('Preparing the VM image: Docker and Maven (a few minutes, once)');
    const tmp = `${this.prepared}.part`;
    rmSync(tmp, { force: true });
    await run('qemu-img', ['create', '-q', '-f', 'qcow2', '-b', this.base, '-F', 'qcow2', tmp, '30G']);
    // cloud-init's settings: on a small disk (xorriso), else from a small web server here,
    // reached at SEED_IN_VM.
    const files = { 'meta-data': 'instance-id: clearsky-vm\nlocal-hostname: clearsky-vm\n', 'user-data': this.#userData(proxy), 'vendor-data': '' };
    const iso = join(this.dir, 'seed.iso'), seedDir = join(this.dir, 'seed');
    let seed = null, seedArgs;
    if (onPath('xorriso')) {
      rmSync(seedDir, { recursive: true, force: true }); mkdirSync(seedDir, { mode: 0o700 });
      for (const [f, body] of Object.entries(files)) writeFileSync(join(seedDir, f), body, { mode: 0o600 });
      await run('xorriso', ['-as', 'mkisofs', '-quiet', '-o', iso, '-V', 'cidata', '-J', '-r', seedDir]);
      seedArgs = ['-drive', `file=${iso},if=virtio,format=raw,readonly=on`];
    } else {
      seed = httpServer((req, res) => { const body = files[req.url.slice(1)]; res.writeHead(body == null ? 404 : 200).end(body ?? ''); }).listen(0, '127.0.0.1');
      await new Promise((r) => seed.once('listening', r));
      seedArgs = ['-smbios', `type=1,serial=ds=nocloud;s=http://${SEED_IN_VM}/`];
    }
    const serial = join(this.dir, 'prepare.log');
    try {
      const code = await new Promise((done, fail) => {
        const fwd = [guestfwd(PROXY_IN_VM, proxy.port), seed && guestfwd({ host: SEED_IN_VM, port: 80 }, seed.address().port)].filter(Boolean).map((g) => `,guestfwd=${g}`).join('');
        const p = spawn('qemu-system-x86_64', [...machine(), '-drive', `if=virtio,file=${tmp},format=qcow2`, ...seedArgs, '-serial', `file:${serial}`,
          '-netdev', `user,id=n0,restrict=on${fwd}`, '-device', 'virtio-net-pci,netdev=n0'], { stdio: 'ignore' });
        const timer = setTimeout(() => { p.kill(); fail(new Error('preparing the VM took over 20 minutes')); }, 20 * 6e4);
        snapshotting.add(p);
        p.on('exit', (c) => { clearTimeout(timer); snapshotting.delete(p); done(c); }).on('error', fail);
      });
      const log = existsSync(serial) ? readFileSync(serial, 'utf8') : '';
      if (code !== 0 || !log.includes('CLEARSKY-READY')) throw new Error(`preparing the VM failed (see ${serial})`);
      renameSync(tmp, this.prepared);
      say('VM image ready');
    } finally { seed?.close(); rmSync(tmp, { force: true }); rmSync(iso, { force: true }); rmSync(seedDir, { recursive: true, force: true }); }
  }

  // A booted VM saved to a file, made once per image and QEMU version: chat VMs resume from it
  // in about a second. Docker isn't started and no folder is mounted in it (that's per chat, and
  // a mounted share would block saving).
  async snapshot(proxy, say = () => {}) {
    if (!this.ready()) return false;
    const stamp = JSON.stringify({ image: IMAGE_VERSION, prepared: statSync(this.prepared).mtimeMs, qemu: await qemuVersion(),
      args: vmArgs({ disk: '', serial: '', sshPort: 0, proxyPort: 0, qmp: '', shares: SLOTS.map(([tag, ro]) => ({ tag, ro, path: '' })) }).join(' ') });
    try { if (existsSync(this.snapState) && readFileSync(this.snapStamp, 'utf8') === stamp) return true; } catch {}
    this.snapping ||= this.#snapshot(proxy, say, stamp).finally(() => { this.snapping = null; });
    return this.snapping;
  }

  async #snapshot(proxy, say, stamp) {
    say('Saving a ready VM to resume from (once, about half a minute)');
    const files = [this.snapDisk, this.snapState, `${this.snapState}.part`, this.snapStamp];
    for (const f of files) rmSync(f, { force: true });
    await run('qemu-img', ['create', '-q', '-f', 'qcow2', '-b', this.prepared, '-F', 'qcow2', this.snapDisk]);
    const port = await freePort(), qmpPath = join(this.dir, 'snapshot.qmp');
    rmSync(qmpPath, { force: true });
    const p = spawn('qemu-system-x86_64', vmArgs({ disk: this.snapDisk, serial: join(this.dir, 'snapshot.log'), sshPort: port, proxyPort: proxy.port, qmp: qmpPath,
      shares: SLOTS.map(([tag, ro]) => ({ tag, ro, path: this.empty })) }), { stdio: 'ignore' });
    let exited = false;
    snapshotting.add(p);
    p.on('exit', () => { exited = true; snapshotting.delete(p); });
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    try {
      for (let i = 0; ; i++) {
        if (exited) throw new Error('the VM stopped while starting');
        try { await run('ssh', sshArgs(this, port, 'true', { timeout: 2 }), { timeout: 5000 }); break; } catch { if (i > 240) throw new Error('the VM didn\'t come up'); }
        await sleep(300);
      }
      // Once it has settled, with little in its caches (a smaller file).
      await run('ssh', sshArgs(this, port, 'timeout 60 systemctl is-system-running --wait >/dev/null 2>&1; sync; echo 3 | sudo tee /proc/sys/vm/drop_caches >/dev/null'), { timeout: 90_000 });
      const m = await qmp(qmpPath);
      try {
        await m.cmd('stop');
        await m.cmd('migrate', { uri: `file:${this.snapState}.part` });
        for (let i = 0; ; i++) {
          const st = (await m.cmd('query-migrate')).status;
          if (st === 'completed') break;
          if (st === 'failed' || st === 'cancelled' || i > 1200) throw new Error(`saving it: ${st || 'timed out'}`);
          await sleep(100);
        }
        await m.cmd('quit').catch(() => {});
      } finally { m.close(); }
      renameSync(`${this.snapState}.part`, this.snapState);
      writeFileSync(this.snapStamp, stamp);
      say('Snapshot saved');
      return true;
    } catch (e) {
      for (const f of files) rmSync(f, { force: true });
      throw e;
    } finally { if (!exited) p.kill('SIGKILL'); rmSync(qmpPath, { force: true }); }
  }

  #userData(proxy) {
    return cloudConfig({ uid: process.getuid?.() ?? 1000, key: readFileSync(`${this.key}.pub`, 'utf8'), hostKey: readFileSync(this.hostKey, 'utf8'), hostPub: readFileSync(`${this.hostKey}.pub`, 'utf8'),
      proxy: `${proxy.url}${PROXY_IN_VM.host}:${PROXY_IN_VM.port}` });
  }

}

// What cloud-init does on the image's one boot: our user and keys, Docker and Maven through the
// proxy, and off what slows a boot down (Docker starts later, with that run's proxy login).
export function cloudConfig({ key, hostKey, hostPub, proxy, uid = 1000 }) {
  const pub = key.trim(), hostPriv = hostKey.trim().split('\n').map((l) => `    ${l}`).join('\n'), url = proxy;
  return `#cloud-config
users:
  - name: ${USER}
    uid: ${uid}
    groups: [sudo]
    sudo: ALL=(ALL) NOPASSWD:ALL
    shell: /bin/bash
    lock_passwd: true
    ssh_authorized_keys: [${JSON.stringify(pub)}]
ssh_deletekeys: true
ssh_genkeytypes: []
ssh_keys:
  ed25519_private: |
${hostPriv}
  ed25519_public: ${JSON.stringify(hostPub.trim())}
apt:
  http_proxy: ${url}
  https_proxy: ${url}
package_update: true
packages: [docker.io, maven]
write_files:
  # Every ssh from Clearsky comes from one address: sshd mustn't lock it out after a few dropped ones.
  - path: /etc/ssh/sshd_config.d/clearsky.conf
    content: |
      PerSourcePenalties no
  - path: /etc/systemd/system/docker.service.d/clearsky.conf
    content: |
      [Service]
      Environment=DOCKER_MIN_API_VERSION=1.24
runcmd:
  - usermod -aG docker ${USER}
  - systemctl disable docker.service docker.socket
  - systemctl mask systemd-networkd-wait-online.service snapd.service snapd.socket snapd.seeded.service apt-daily.timer apt-daily-upgrade.timer unattended-upgrades.service motd-news.timer || true
  - rm -f /etc/apt/apt.conf.d/90cloud-init-aptproxy
  - cloud-init clean --logs
  - touch /etc/cloud/cloud-init.disabled
  - echo CLEARSKY-READY > /dev/ttyS0
power_state:
  mode: poweroff
  condition: true
`;
}

let qemuVersionP = null;
const qemuVersion = () => (qemuVersionP ||= run('qemu-system-x86_64', ['--version']).then((v) => v.split('\n')[0].trim()).catch(() => 'unknown'));

// ssh into a VM, checking it's ours by the host key the image was made with.
const sshArgs = (image, port, cmd, opts = {}) => ['-i', image.key, '-p', String(port), '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${image.knownHosts}`,
  '-o', `HostKeyAlias=${HOST_ALIAS}`, '-o', 'LogLevel=ERROR', '-o', 'BatchMode=yes', '-o', `ConnectTimeout=${opts.timeout || 5}`, `${USER}@127.0.0.1`, cmd];

// The folders a VM can be given, always all of them (an empty folder for those not used): a
// snapshot only resumes on the same devices. [tag, read only]
const SLOTS = [['work', false], ['jvm', true], ['m2', true], ['m2w', true], ['gitc', true], ['ej0', true], ['ej1', true], ['ej2', true], ['ej3', true]];

// QEMU's arguments for a chat's VM (and for making its snapshot, which must match them).
export function vmArgs({ disk, serial, sshPort, proxyPort, qmp, shares }) {
  return [...machine(), '-drive', `if=virtio,file=${disk},format=qcow2`, '-serial', `file:${serial}`,
    '-netdev', `user,id=n0,restrict=on,hostfwd=tcp:127.0.0.1:${sshPort}-:22,guestfwd=${guestfwd(PROXY_IN_VM, proxyPort)}`,
    '-device', 'virtio-net-pci,netdev=n0',
    ...shares.flatMap(({ tag, path, ro }) => ['-virtfs', `local,path=${path},mount_tag=${tag},security_model=none${ro ? ',readonly=on' : ''}`]),
    '-qmp', `unix:${qmp},server=on,wait=off`];
}

// QEMU's control socket (QMP): `cmd(name, args)` resolves with its answer.
async function qmp(path) {
  let sock;
  for (let i = 0; !sock; i++) {
    try { sock = await new Promise((ok, fail) => { const s = netConnect(path, () => ok(s)).once('error', fail); }); } catch (e) { if (i > 100) throw e; await new Promise((r) => setTimeout(r, 50)); }
  }
  let buf = '', closed = false;
  const waiting = [];
  sock.on('data', (d) => {
    buf += d;
    for (let i; (i = buf.indexOf('\n')) >= 0;) {
      let m; try { m = JSON.parse(buf.slice(0, i)); } catch {}
      buf = buf.slice(i + 1);
      if (m && ('return' in m || 'error' in m)) waiting.shift()?.(m);
    }
  }).on('error', () => {}).on('close', () => {
    // QEMU went away (a snapshot it couldn't load): what still waits gets an error, not silence.
    closed = true;
    for (const w of waiting.splice(0)) w({ error: { desc: 'QEMU stopped' } });
  });
  const cmd = (execute, args) => new Promise((ok, fail) => {
    if (closed) { fail(new Error('QEMU stopped')); return; }
    waiting.push((m) => (m.error ? fail(new Error(m.error.desc)) : ok(m.return)));
    sock.write(`${JSON.stringify(args ? { execute, arguments: args } : { execute })}\n`);
  });
  await cmd('qmp_capabilities');
  return { cmd, close: () => sock.destroy() };
}

// The VM's size. Default: half this machine's cores (up to 12) and a quarter of its memory, between
// 4 and 16 GB: room for a test run, and for you. Memory a VM doesn't touch isn't taken from you.
// COPILOT_VM_CPUS and COPILOT_VM_MEMORY_GB (Settings) override it, kept to what this machine has:
// 1 core up to all of them, 2 GB up to half its memory. Read at each start, so a change applies
// to the next VM (its snapshot is remade, since the snapshot's stamp holds the size).
export const VM_DEFAULT = { cpus: Math.min(12, Math.max(2, Math.floor(availableParallelism() / 2))), memMb: Math.min(16384, Math.max(4096, Math.floor(totalmem() / 4 / 1048576 / 512) * 512)) };
export function vmSize(env = process.env, host = { cpus: availableParallelism(), memMb: Math.floor(totalmem() / 1048576) }) {
  const num = (v) => (v == null || String(v).trim() === '' ? NaN : Number(String(v).trim().replace(',', '.')));
  const c = num(env.COPILOT_VM_CPUS), g = num(env.COPILOT_VM_MEMORY_GB);
  const maxMb = Math.max(2048, Math.floor(host.memMb / 2 / 512) * 512);
  return {
    cpus: Number.isFinite(c) && c >= 1 ? Math.min(host.cpus, Math.floor(c)) : Math.min(host.cpus, VM_DEFAULT.cpus),
    memMb: Number.isFinite(g) && g > 0 ? Math.min(maxMb, Math.max(2048, Math.floor((g * 1024) / 512) * 512)) : Math.min(maxMb, VM_DEFAULT.memMb),
  };
}
function machine() {
  const size = vmSize();
  return ['-machine', 'q35,accel=kvm', '-cpu', 'host', '-smp', String(size.cpus), '-m', String(size.memMb), '-display', 'none', '-nodefaults', '-no-user-config'];
}
const HOST_ALIAS = 'clearsky-vm';
const PID_MARK = '__clearsky_sid=';
const guestfwd = (inVm, hostPort) => `tcp:${inVm.host}:${inVm.port}-cmd:socat - TCP:127.0.0.1:${hostPort}`;

// A local proxy port that passes everything to `proxy` (srt's), adding its login to each request
// (proxy.url = 'http://user:token@'). A plain HTTP request gets "Connection: close", so each
// connection carries one request and every request has the login; CONNECT is a tunnel after it.
export function loginHead(head, auth) {
  const lines = head.split('\r\n').filter((l) => !/^proxy-authorization:/i.test(l));
  const connect = /^CONNECT /i.test(lines[0]);
  const keep = connect ? lines : lines.filter((l) => !/^(proxy-)?connection:/i.test(l));
  return [keep[0], ...(auth ? [`Proxy-Authorization: Basic ${auth}`] : []), ...(connect ? [] : ['Connection: close']), ...keep.slice(1)].join('\r\n');
}
export function loginForwarder(proxy) {
  const m = /^http:\/\/(?:([^:@]+):([^@]+)@)?$/.exec(proxy.url) || [];
  const auth = m[1] ? Buffer.from(`${decodeURIComponent(m[1])}:${decodeURIComponent(m[2])}`).toString('base64') : null;
  const server = netServer((client) => {
    let buf = Buffer.alloc(0);
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) { if (buf.length > 65536) client.destroy(); return; }
      client.off('data', onData);
      client.pause();
      const head = loginHead(buf.subarray(0, end).toString('latin1'), auth);
      const up = netConnect(proxy.port, '127.0.0.1', () => {
        up.write(Buffer.concat([Buffer.from(head, 'latin1'), buf.subarray(end)]));
        client.pipe(up).pipe(client);
        client.resume();
      });
      up.on('error', () => client.destroy());
      client.on('error', () => up.destroy());
      client.on('close', () => up.destroy());
    };
    client.on('data', onData);
    client.on('error', () => {});
  });
  server.unref();
  return new Promise((ok, fail) => server.once('error', fail).listen(0, '127.0.0.1', () => ok(server)));
}

// One chat's VM. `events` keeps what happened (shown in the chat), newest last.
export class ChatVm {
  constructor({ id, cwd, image, proxy, hosts = [], log = () => {} }) {
    Object.assign(this, { id, cwd, image, proxy, hosts, log, state: 'off', events: [], containers: [], startedAt: null, commands: 0 });
    this.overlay = join(image.dir, `chat-${id}.qcow2`);
    this.serial = join(image.dir, `chat-${id}.log`);
  }

  event(text, kind = 'vm') {
    // Never a login in the log (a command can carry the proxy's): URLs lose theirs.
    text = String(text).replace(/\/\/[^/\s:@]+:[^@\s]+@/g, '//…@');
    const token = /^http:\/\/[^:]+:([^@]+)@$/.exec((this.upstream || this.proxy)?.url || '')?.[1];
    if (token) text = text.split(token).join('…');
    this.events.push({ at: new Date().toISOString(), kind, text });
    if (this.events.length > 300) this.events.splice(0, this.events.length - 300);
    this.onEvent?.(this.events.at(-1));
  }

  ssh(cmd, opts = {}) { return sshArgs(this.image, this.sshPort, cmd, opts); }

  async start() {
    if (this.state === 'running') return;
    if (this.starting) return this.starting;
    this.starting = this.#start().finally(() => { this.starting = null; });
    return this.starting;
  }

  async #start() {
    const t0 = Date.now();
    this.state = 'starting';
    // Inside, the proxy needs no login: Clearsky adds it on the way to srt's proxy. Tools that
    // can't send a proxy login (protoc-jar, some Gradle plugins) then work too. What's allowed out
    // is still srt's allow list.
    if (!this.forwarder) {
      this.upstream ||= this.proxy;
      this.forwarder = await loginForwarder(this.upstream);
      this.proxy = { ...this.upstream, url: 'http://', port: this.forwarder.address().port };
    }
    await this.image.prepare(this.proxy, (t) => this.event(t));
    const shares = await this.#shares();
    this.shares = shares.filter((x) => x.path).map(({ path, ro }) => `${path.replace(homedir(), '~')}${ro ? ' (read only)' : ''}`);
    this.sshPort = await freePort();
    // From the snapshot (about a second), else a normal boot (about 8 seconds).
    let resumed = false;
    if (await this.image.snapshot(this.proxy, (t) => this.event(t)).catch((e) => { this.event(`No snapshot: ${e.message}`); return false; })) {
      this.event('Resuming the VM');
      try { await this.#boot(shares, true); resumed = true; } catch (e) {
        this.event(`Resuming didn't work (${e.message}); booting instead, and saving a new snapshot next time`);
        rmSync(this.image.snapStamp, { force: true });
        const p = this.qemu; this.qemu = null; p?.kill('SIGKILL');
        if (this.state === 'off') this.state = 'starting';
      }
    }
    if (!resumed) { this.event('Starting the VM'); await this.#boot(shares, false); }
    this.event(`VM up in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    const url = `${this.proxy.url}${PROXY_IN_VM.host}:${PROXY_IN_VM.port}`;
    // Read-only shares are cached in the VM (reading jars uncached was ~200 times slower); not
    // the work folder or git's, which change while the VM runs.
    const mount = ({ tag, at, ro }) => `sudo mkdir -p ${q(at)} && sudo mount -t 9p -o trans=virtio,version=9p2000.L,msize=524288${ro ? ',ro' : ''}${ro && tag !== 'gitc' ? ',cache=loose' : ''} ${tag} ${q(at)}`;
    const setup = [
      // A resumed VM's clock is the snapshot's (and it has no time server).
      ...(resumed ? [`sudo date -s @${Math.floor(Date.now() / 1000)} >/dev/null`] : []),
      ...shares.filter((x) => x.path).map(mount),
      // The wrapper's Maven versions under a writable layer, so ./mvnw finds them and can still add
      // others (copying them as links took seconds over 9p).
      ...(shares.some((x) => x.tag === 'm2w' && x.path) ? ['mkdir -p ~/.m2/wrapper ~/.m2/.wrapper-up ~/.m2/.wrapper-work && sudo mount -t overlay overlay -o lowerdir=/host/m2wrapper,upperdir=$HOME/.m2/.wrapper-up,workdir=$HOME/.m2/.wrapper-work ~/.m2/wrapper'] : []),
      // Docker pulls through the proxy; it starts only now, with this run's proxy login.
      `printf %s ${q(JSON.stringify({ proxies: { 'http-proxy': url, 'https-proxy': url, 'no-proxy': 'localhost,127.0.0.1' } }))} | sudo tee /etc/docker/daemon.json >/dev/null`,
      // The proxy reads Docker Hub's HTTPS (to refuse pushes): Docker trusts the CA it signs with.
      ...(this.proxy.ca ? [`printf %s ${q(this.proxy.ca)} | sudo tee /usr/local/share/ca-certificates/clearsky-sandbox.crt >/dev/null && sudo update-ca-certificates >/dev/null 2>&1`] : []),
      'sudo systemctl start docker',
      `mkdir -p ~/.m2 && printf %s ${q(mavenSettings(this.proxy))} > ~/.m2/settings.xml`,
    ].join(' && ');
    await run('ssh', this.ssh(setup), { timeout: 120_000 });
    this.state = 'running';
    this.startedAt = Date.now();
    this.event(`Docker ready, ${((Date.now() - t0) / 1000).toFixed(1)}s after start`);
    this.#watchDocker();
    this.#idle();
  }

  // What the VM sees of this machine, in SLOTS (the same devices every time, as a snapshot needs).
  async #shares() {
    // Debian's JDKs link their settings to /etc/java-<n>-openjdk: those go along with /usr/lib/jvm.
    let etcJava = [];
    try { etcJava = readdirSync('/etc').filter((f) => /^java-\d+-openjdk$/.test(f)).map((f) => `/etc/${f}`); } catch {}
    // A worktree's history lives in its main checkout's .git: shared read only, so builds that
    // read git (commit id plugins) work.
    let gitCommon = null;
    try {
      gitCommon = (await run('git', ['-C', this.cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { timeout: 3000 })).trim();
      if (!gitCommon || gitCommon === this.cwd || gitCommon.startsWith(`${this.cwd}/`)) gitCommon = null;
    } catch {}
    // Your Maven repository and the Maven versions ./mvnw already downloaded, read only.
    const paths = { work: this.cwd, jvm: '/usr/lib/jvm', m2: join(homedir(), '.m2', 'repository'), m2w: join(homedir(), '.m2', 'wrapper'), gitc: gitCommon,
      ej0: etcJava[0], ej1: etcJava[1], ej2: etcJava[2], ej3: etcJava[3] };
    const at = { m2: '/host/m2', m2w: '/host/m2wrapper' };
    return SLOTS.map(([tag, ro]) => { const path = paths[tag] && existsSync(paths[tag]) ? paths[tag] : null; return { tag, ro, path, at: at[tag] || path }; });
  }

  // Start QEMU: booting the chat's own disk, or resuming the snapshot on a disk over its own.
  async #boot(shares, resume) {
    rmSync(this.overlay, { force: true });
    await run('qemu-img', ['create', '-q', '-f', 'qcow2', '-b', resume ? this.image.snapDisk : this.image.prepared, '-F', 'qcow2', this.overlay]);
    const qmpPath = join(this.image.dir, `chat-${this.id}.qmp`);
    rmSync(qmpPath, { force: true });
    this.size = vmSize();
    const p = spawn('qemu-system-x86_64', [...vmArgs({ disk: this.overlay, serial: this.serial, sshPort: this.sshPort, proxyPort: this.proxy.port, qmp: qmpPath,
      shares: shares.map((x) => ({ ...x, path: x.path || this.image.empty })) }), ...(resume ? ['-incoming', `file:${this.image.snapState}`] : [])], { stdio: 'ignore' });
    this.qemu = p;
    live.add(this);
    p.on('exit', (code) => { if (this.qemu !== p) return; if (this.state !== 'off' && !resume) this.event(`The VM stopped${code ? ` (exit ${code})` : ''}`); this.#gone(); });
    if (resume) {
      const m = await qmp(qmpPath);
      try {
        for (let i = 0; ; i++) {
          const st = (await m.cmd('query-migrate')).status;
          if (st === 'completed') break;
          if (st === 'failed' || i > 200) throw new Error(`loading the snapshot: ${st || 'timed out'}`);
          await new Promise((r) => setTimeout(r, 100));
        }
        await m.cmd('cont');
      } finally { m.close(); }
    }
    for (let i = 0; ; i++) {
      if (this.qemu !== p || this.state === 'off') throw new Error('the VM stopped while starting');
      try { await run('ssh', this.ssh('true', { timeout: 2 }), { timeout: 5000 }); return; } catch {
        if (i > (resume ? 30 : 240)) { if (!resume) this.stop(); throw new Error('the VM didn\'t come up'); }
      }
      await new Promise((r) => setTimeout(r, resume ? 100 : 300));
    }
  }

  // Docker's events in the VM, for the chat's log and the containers view.
  #watchDocker() {
    this.#watchPulls();
    const p = spawn('ssh', this.ssh('docker events --format "{{json .}}"'), { stdio: ['ignore', 'pipe', 'ignore'] });
    this.watcher = p;
    let buf = '';
    p.stdout.on('data', (d) => {
      buf += d;
      const lines = buf.split('\n'); buf = lines.pop();
      for (const l of lines) {
        let e; try { e = JSON.parse(l); } catch { continue; }
        const name = e.Actor?.Attributes?.name || '', image = e.Actor?.Attributes?.image || '';
        if (e.Type === 'container' && ['start', 'die', 'create', 'destroy', 'oom', 'kill'].includes(e.Action)) {
          this.event(`${e.Action} ${name}${image ? ` (${image})` : ''}${e.Action === 'die' && e.Actor?.Attributes?.exitCode ? `, exit ${e.Actor.Attributes.exitCode}` : ''}`, 'docker');
          this.refresh();
        } else if (e.Type === 'image' && e.Action === 'pull') this.event(`pulled ${e.Actor?.ID || name}`, 'docker');
      }
    });
  }

  // A pull that fails (an image the VM can't reach) makes Testcontainers retry for minutes and
  // then fail every test: stop the command at the first one, saying why. (With sudo: the VM's
  // user can't read the system journal, docker's log included.)
  #watchPulls() {
    const p = spawn('ssh', this.ssh('sudo journalctl -fu docker -o cat -n 0'), { stdio: ['ignore', 'pipe', 'ignore'] });
    this.pullWatcher = p;
    let buf = '';
    p.stdout.setEncoding('utf8').on('data', (d) => {
      buf += d;
      const lines = buf.split('\n'); buf = lines.pop();
      for (const l of lines) {
        const why = pullFailure(l);
        if (why) this.pullFailed(why);
      }
    });
  }

  pullFailed(why) {
    this.event(`Pull failed: ${why}`, 'docker');
    const r = this.running;
    if (!r || r.pullStopped) return;
    r.pullStopped = true;
    r.err(`\nClearsky stopped this command: the VM couldn't pull an image (${why}).\n`
      + 'A private image needs to be in your own Docker and listed under Settings → Copilot → Images the VM copies from your Docker; '
      + 'other hosts have to be allowed for the sandbox. Tell the user which image it is.\n');
    this.event('Stopped: an image pull failed', 'run');
    r.stop();
  }

  // What runs in the VM now: containers (with ports and state) and how much they use.
  refresh() {
    if (this.state !== 'running') return Promise.resolve(this);
    // Asked again while one runs (a container started meanwhile): one more after it.
    if (this.refreshing) { this.again ||= this.refreshing.then(() => { this.again = null; return this.refresh(); }); return this.again; }
    this.refreshing = this.#refresh().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  async #refresh() {
    try {
      const out = await run('ssh', this.ssh('docker ps -a --format "{{json .}}"; echo ---; docker stats --no-stream --format "{{json .}}"; echo ---; free -m | awk \'/Mem:/{print $2, $3}\'; nproc; echo ---; head -1 /proc/stat'), { timeout: 15_000 });
      const [ps, stats, sys, stat = ''] = out.split('---\n');
      const use = new Map(stats.split('\n').filter(Boolean).map((l) => { try { const s = JSON.parse(l); return [s.Name, s]; } catch { return [null]; } }));
      this.containers = ps.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
        .map((c) => ({ name: c.Names, image: c.Image, state: c.State, status: c.Status, ports: c.Ports, cpu: use.get(c.Names)?.CPUPerc, mem: use.get(c.Names)?.MemUsage }));
      const [mem, cpus] = sys.trim().split('\n');
      const [total, used] = (mem || '').split(' ').map(Number);
      // CPU in use since the last look, from the guest's /proc/stat (null on the first look).
      const sample = cpuSample(stat);
      const cpuPct = cpuBusy(this.cpuSample, sample);
      if (sample) this.cpuSample = sample;
      this.system = { memTotalMb: total, memUsedMb: used, cpus: Number(cpus) || 4, cpuPct: cpuPct ?? this.system?.cpuPct ?? null };
    } catch { /* busy or going down */ }
    return this;
  }

  // Run a command in the chat's folder in the VM; output comes as it's written.
  async exec(argv, cwd, out, err, { signal, java } = {}) {
    await this.start();
    await this.copyImages().catch((e) => this.event(`Couldn't copy images from your Docker: ${e.message}`));
    clearTimeout(this.idleTimer);
    const t0 = Date.now(), line = argv.join(' ');
    this.commands++;
    this.event(`$ ${line.slice(0, 300)}`, 'run');
    // The remote shell is its ssh session's leader: its id (said first) stops the whole command.
    // Tools that download (the Maven wrapper, curl) go through the proxy too.
    const url = `${this.proxy.url}${PROXY_IN_VM.host}:${PROXY_IN_VM.port}`;
    const proxyEnv = ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY'].map((k) => `${k}=${q(url)}`).join(' ');
    const cmd = `echo ${PID_MARK}$$ >&2; cd ${q(cwd)} && export ${proxyEnv} no_proxy=localhost,127.0.0.1 NO_PROXY=localhost,127.0.0.1 MAVEN_ARGS="\${MAVEN_ARGS:+$MAVEN_ARGS }-Dmaven.repo.local.tail=/host/m2"${javaEnv(java)} && exec ${argv.map(q).join(' ')}`;
    let sid = null, stopped = false, ended = false;
    const code = await new Promise((done) => {
      const p = spawn('ssh', this.ssh(cmd), { stdio: ['ignore', 'pipe', 'pipe'] });
      p.stdout.setEncoding('utf8').on('data', out);
      p.stderr.setEncoding('utf8').on('data', (d) => {
        if (sid == null) { const m = d.match(new RegExp(`^${PID_MARK}(\\d+)\\n`)); if (m) { sid = m[1]; d = d.slice(m[0].length); } else sid = ''; }
        if (d) err(d);
      });
      const stop = () => { if (sid) execFile('ssh', this.ssh(`sudo pkill -TERM -s ${sid}`), () => {}); setTimeout(() => p.kill(), 5000).unref(); };
      this.running = { err, stop: () => { stopped = true; stop(); } };
      const timer = setTimeout(() => { this.event(`Stopped after 60 minutes: ${line.slice(0, 120)}`, 'run'); stop(); }, 60 * 6e4);
      // (The sandbox side hangs up once it has the answer too: that's not a stop.)
      signal?.addEventListener('abort', () => { if (ended) return; stopped = true; this.event(`Stopped: ${line.slice(0, 120)}`, 'run'); stop(); });
      p.on('exit', (c) => { ended = true; this.running = null; clearTimeout(timer); done(c ?? 1); }).on('error', () => done(127));
    });
    if (!stopped) this.event(`${code === 0 ? 'done' : `failed (exit ${code})`} in ${Math.round((Date.now() - t0) / 1000)}s: ${line.slice(0, 120)}`, 'run');
    this.#idle();
    this.refresh();
    return code;
  }

  // Images from your own Docker that tests need but the VM can't pull (a private registry): those
  // named like `images()` are copied in when the VM doesn't have that version yet. No login goes in.
  async copyImages() {
    const prefixes = this.images?.() || [];
    if (!prefixes.length) return;
    const list = (out) => new Map(out.split('\n').map((l) => l.trim().split(' ')).filter(([ref, id]) => id && !ref.includes('<none>')));
    // An entry with a tag is that image; others are name prefixes, and then only the newest tag of
    // each repository (docker lists newest first), not every dated one.
    const exact = (p) => /:[^/]+$/.test(p), seen = new Set();
    const mine = [...list(await run('docker', ['images', '--format', '{{.Repository}}:{{.Tag}} {{.ID}}'], { timeout: 15_000 }))].filter(([ref]) => {
      if (prefixes.some((p) => exact(p) && ref === p)) return true;
      const repo = ref.slice(0, ref.lastIndexOf(':'));
      if (!prefixes.some((p) => !exact(p) && ref.startsWith(p)) || seen.has(repo)) return false;
      seen.add(repo);
      return true;
    });
    // A whole image named in Settings that your Docker doesn't have can't be copied: say so first.
    for (const p of prefixes.filter((x) => exact(x) && !mine.some(([ref]) => ref === x))) this.event(`${p} isn't in your Docker: pull it once on your machine`, 'docker');
    if (!mine.length) return;
    const theirs = list(await run('ssh', this.ssh('docker images --format "{{.Repository}}:{{.Tag}} {{.ID}}"'), { timeout: 15_000 }));
    for (const [ref, id] of mine.filter(([r, i]) => theirs.get(r) !== i)) {
      const t0 = Date.now();
      this.event(`Copying ${ref} from your Docker`, 'docker');
      await new Promise((done, fail) => {
        const save = spawn('docker', ['save', ref], { stdio: ['ignore', 'pipe', 'ignore'] });
        const load = spawn('ssh', this.ssh('docker load -q'), { stdio: ['pipe', 'ignore', 'pipe'] });
        let why = '';
        load.stderr.on('data', (d) => { why += d; });
        save.stdout.pipe(load.stdin);
        save.on('exit', (c) => { if (c) { load.kill(); fail(new Error(`docker save ${ref} failed`)); } });
        load.on('exit', (c) => (c ? fail(new Error(why.trim() || `docker load failed (${c})`)) : done()));
      });
      this.event(`Copied ${ref} (${id}) in ${Math.round((Date.now() - t0) / 1000)}s`, 'docker');
    }
  }

  #idle() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => { this.event('Stopping the VM: idle for 30 minutes'); this.stop(); }, IDLE_MS);
    this.idleTimer.unref?.();
  }

  stop() {
    this.forwarder?.close(); this.forwarder = null;
    this.onStop?.(); // its place in the VM queue (lib/vm-queue.mjs), also while it waits
    if (this.state === 'off') return;
    this.state = 'off';
    this.watcher?.kill();
    this.pullWatcher?.kill();
    this.qemu?.kill('SIGTERM');
    this.#gone();
  }

  #gone() {
    this.state = 'off';
    this.onStop?.();
    clearTimeout(this.idleTimer);
    this.containers = [];
    this.startedAt = null;
    live.delete(this);
    rmSync(this.overlay, { force: true });
    rmSync(join(this.image.dir, `chat-${this.id}.qmp`), { force: true });
    rmSync(this.serial, { force: true });
  }

  view() {
    let disk = null;
    try { disk = statSync(this.overlay).blocks * 512; } catch {}
    return { state: this.state, queue: this.queue?.() || null, startedAt: this.startedAt && new Date(this.startedAt).toISOString(), cwd: this.cwd, commands: this.commands,
      vcpus: this.size?.cpus ?? vmSize().cpus, memMb: this.size?.memMb ?? vmSize().memMb, system: this.system || null, diskBytes: disk, containers: this.containers,
      network: { via: 'the sandbox\'s proxy', hosts: this.hosts }, shares: this.shares || [this.cwd],
      events: this.events.slice(-150) };
  }
}

// The first line of /proc/stat ("cpu  user nice system idle iowait irq softirq steal …") as
// { busy, total } jiffies; null when it isn't one.
export function cpuSample(line) {
  const m = String(line).match(/^cpu\s+([\d\s]+)/);
  if (!m) return null;
  const n = m[1].trim().split(/\s+/).map(Number).slice(0, 8);
  if (n.length < 4) return null;
  const total = n.reduce((a, b) => a + b, 0), idle = n[3] + (n[4] || 0);
  return { busy: total - idle, total };
}
// Percent of all the VM's CPUs in use between two samples (0 to 100), or null.
export function cpuBusy(a, b) {
  if (!a || !b || b.total <= a.total) return null;
  return Math.round(Math.min(100, Math.max(0, ((b.busy - a.busy) / (b.total - a.total)) * 100)));
}

// The JDK a command runs with: yours (from the shared /usr/lib/jvm) when it's one of those.
export const javaEnv = (java) => (java && /^\/usr\/lib\/jvm\/[\w.+-]+$/.test(java) ? ` JAVA_HOME=${q(java)} PATH=${q(`${java}/bin`)}:"$PATH"` : '');

// Why dockerd failed a pull, from a line of its log; null when the line isn't one. (Testcontainers
// pulls through the API: POST /images/create.)
export function pullFailure(line) {
  // Most failures log the API handler's error. A missing or forbidden image (a client error) is logged
  // only at info level, as "fetch failed": that one counts when it's final (not found, denied), not a
  // retry Docker may still recover from.
  const m = /images\/create returned error: (.+?)"?\s*$/.exec(line) || /level=error msg="(?:Not continuing with pull after error|pull failed)[^:]*: (.+?)"?\s*$/i.exec(line)
    || /msg="fetch failed" error="((?:[^"\\]|\\.)*(?:pull access denied|not found|manifest unknown|unauthorized|forbidden|denied)(?:[^"\\]|\\.)*)"/i.exec(line);
  return m ? m[1].replace(/\\"/g, '"').slice(0, 300) : null;
}

// Maven in the VM: through the proxy, with your repository as a read-only fallback.
export function mavenSettings(proxy) {
  const m = /^http:\/\/(?:([^:@]+):([^@]+)@)?$/.exec(proxy.url) || [];
  const auth = m[1] ? `<username>${m[1]}</username><password>${m[2]}</password>` : '';
  return `<settings><proxies><proxy><id>clearsky</id><active>true</active><protocol>http</protocol><host>${PROXY_IN_VM.host}</host><port>${PROXY_IN_VM.port}</port>${auth}<nonProxyHosts>localhost|127.0.0.1</nonProxyHosts></proxy></proxies></settings>\n`;
}
