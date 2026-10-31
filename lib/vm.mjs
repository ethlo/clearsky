// Clearsky's VM: where a chat's builds that need Docker run (Testcontainers), instead of
// `outside` on your machine. A throwaway virtual machine (QEMU with KVM, no sudo) with its own
// kernel and its own Docker; a container that breaks out lands in the VM, not on your machine.
// - It sees only the chat's folder (read-write), your JDKs and your Maven repository (read only).
//   Your home, keys and Docker don't exist in there.
// - Its network goes nowhere but srt's proxy: the sandbox's allowed hosts, logins added on the
//   way out, and the GitHub gate. Containers can't reach the internet or your machine.
// - One VM per chat, started on its first `vm <command>`, stopped when the chat closes or after
//   30 idle minutes; its disk is an overlay on a prepared image, deleted with it.
// The prepared image (Ubuntu's cloud image with Docker and Maven) is made once, the first time.

import { spawn, execFile } from 'node:child_process';
import { createServer as httpServer } from 'node:http';
import { createServer as netServer } from 'node:net';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, statSync, createWriteStream, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
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
const SEED_IN_VM = '10.0.2.101';
const USER = 'clearsky';
const IDLE_MS = 30 * 6e4;

const run = (cmd, args, opts = {}) => new Promise((done, fail) =>
  execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, ...opts }, (e, stdout, stderr) => (e ? fail(Object.assign(e, { stderr })) : done(String(stdout)))));
const freePort = () => new Promise((done) => { const s = netServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => done(port)); }); });
const q = (a) => `'${String(a).replace(/'/g, `'\\''`)}'`;
const onPath = (bin, env = process.env) => (env.PATH || '').split(':').some((d) => d && existsSync(join(d, bin)));

// QEMU processes still running, stopped (and their disks deleted) when Clearsky exits.
const live = new Set();
process.on('exit', () => { for (const vm of live) { try { vm.qemu?.kill('SIGKILL'); } catch {} rmSync(vm.overlay, { force: true }); } });

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
    Object.assign(this, { dir, log, base: join(dir, IMAGE), prepared: join(dir, 'prepared.qcow2'), key: join(dir, 'id_ed25519'),
      hostKey: join(dir, 'host_ed25519'), knownHosts: join(dir, 'known_hosts') });
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Disks of VMs from a Clearsky that didn't get to clean up.
    for (const f of readdirSync(dir)) if (/^chat-[\w-]+\.(qcow2|log)$/.test(f)) rmSync(join(dir, f), { force: true });
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
        p.on('exit', (c) => { clearTimeout(timer); done(c); }).on('error', fail);
      });
      const log = existsSync(serial) ? readFileSync(serial, 'utf8') : '';
      if (code !== 0 || !log.includes('CLEARSKY-READY')) throw new Error(`preparing the VM failed (see ${serial})`);
      renameSync(tmp, this.prepared);
      say('VM image ready');
    } finally { seed?.close(); rmSync(tmp, { force: true }); rmSync(iso, { force: true }); rmSync(seedDir, { recursive: true, force: true }); }
  }

  #userData(proxy) {
    return cloudConfig({ key: readFileSync(`${this.key}.pub`, 'utf8'), hostKey: readFileSync(this.hostKey, 'utf8'), hostPub: readFileSync(`${this.hostKey}.pub`, 'utf8'),
      proxy: `${proxy.url}${PROXY_IN_VM.host}:${PROXY_IN_VM.port}` });
  }

}

// What cloud-init does on the image's one boot: our user and keys, Docker and Maven through the
// proxy, and off what slows a boot down (Docker starts later, with that run's proxy login).
export function cloudConfig({ key, hostKey, hostPub, proxy }) {
  const pub = key.trim(), hostPriv = hostKey.trim().split('\n').map((l) => `    ${l}`).join('\n'), url = proxy;
  return `#cloud-config
users:
  - name: ${USER}
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

function machine() {
  return ['-machine', 'q35,accel=kvm', '-cpu', 'host', '-smp', '4', '-m', '6144', '-display', 'none', '-nodefaults', '-no-user-config'];
}
const HOST_ALIAS = 'clearsky-vm';
const PID_MARK = '__clearsky_sid=';
const guestfwd = (inVm, hostPort) => `tcp:${inVm.host}:${inVm.port}-cmd:socat - TCP:127.0.0.1:${hostPort}`;

// One chat's VM. `events` keeps what happened (shown in the chat), newest last.
export class ChatVm {
  constructor({ id, cwd, image, proxy, hosts = [], log = () => {} }) {
    Object.assign(this, { id, cwd, image, proxy, hosts, log, state: 'off', events: [], containers: [], startedAt: null, commands: 0 });
    this.overlay = join(image.dir, `chat-${id}.qcow2`);
    this.serial = join(image.dir, `chat-${id}.log`);
  }

  event(text, kind = 'vm') {
    this.events.push({ at: new Date().toISOString(), kind, text });
    if (this.events.length > 300) this.events.splice(0, this.events.length - 300);
    this.onEvent?.(this.events.at(-1));
  }

  ssh(cmd, opts = {}) {
    return ['-i', this.image.key, '-p', String(this.sshPort), '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${this.image.knownHosts}`, '-o', `HostKeyAlias=${HOST_ALIAS}`,
      '-o', 'LogLevel=ERROR', '-o', 'BatchMode=yes', '-o', `ConnectTimeout=${opts.timeout || 5}`, `${USER}@127.0.0.1`, cmd];
  }

  async start() {
    if (this.state === 'running') return;
    if (this.starting) return this.starting;
    this.starting = this.#start().finally(() => { this.starting = null; });
    return this.starting;
  }

  async #start() {
    const t0 = Date.now();
    this.state = 'starting';
    await this.image.prepare(this.proxy, (t) => this.event(t));
    this.event('Starting the VM');
    rmSync(this.overlay, { force: true });
    await run('qemu-img', ['create', '-q', '-f', 'qcow2', '-b', this.image.prepared, '-F', 'qcow2', this.overlay]);
    this.sshPort = await freePort();
    // Debian's JDKs link their settings to /etc/java-<n>-openjdk: those go along with /usr/lib/jvm.
    let etcJava = [];
    try { etcJava = readdirSync('/etc').filter((f) => /^java-\d+-openjdk$/.test(f)).map((f) => [f.replace(/\W/g, ''), `/etc/${f}`, true]); } catch {}
    // Your Maven repository and the Maven versions ./mvnw already downloaded, read only.
    const AT = { m2: '/host/m2', m2wrapper: '/host/m2wrapper' };
    const shares = [['work', this.cwd, false], ['jvm', '/usr/lib/jvm', true], ...etcJava, ['m2', join(homedir(), '.m2', 'repository'), true],
      ['m2wrapper', join(homedir(), '.m2', 'wrapper'), true]].filter(([, path]) => existsSync(path));
    this.shares = shares.map(([tag, path, ro]) => `${path.replace(homedir(), '~')}${ro ? ' (read only)' : ''}`);
    this.qemu = spawn('qemu-system-x86_64', [...machine(), '-drive', `if=virtio,file=${this.overlay},format=qcow2`, '-serial', `file:${this.serial}`,
      '-netdev', `user,id=n0,restrict=on,hostfwd=tcp:127.0.0.1:${this.sshPort}-:22,guestfwd=${guestfwd(PROXY_IN_VM, this.proxy.port)}`,
      '-device', 'virtio-net-pci,netdev=n0',
      ...shares.flatMap(([tag, path, ro]) => ['-virtfs', `local,path=${path},mount_tag=${tag},security_model=none${ro ? ',readonly=on' : ''}`])],
    { stdio: 'ignore' });
    live.add(this);
    this.qemu.on('exit', (code) => { if (this.state !== 'off') this.event(`The VM stopped${code ? ` (exit ${code})` : ''}`); this.#gone(); });
    for (let i = 0; ; i++) {
      if (this.state === 'off') throw new Error('the VM stopped while starting');
      try { await run('ssh', this.ssh('true', { timeout: 2 }), { timeout: 5000 }); break; } catch { if (i > 120) { this.stop(); throw new Error('the VM didn\'t come up'); } }
      await new Promise((r) => setTimeout(r, 500));
    }
    this.event(`VM up in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    const url = `${this.proxy.url}${PROXY_IN_VM.host}:${PROXY_IN_VM.port}`;
    const mount = (tag, at, ro) => `sudo mkdir -p ${q(at)} && sudo mount -t 9p -o trans=virtio,version=9p2000.L,msize=524288${ro ? ',ro' : ''} ${tag} ${q(at)}`;
    const setup = [
      ...shares.map(([tag, path, ro]) => mount(tag, AT[tag] || path, ro)),
      // The wrapper's Maven versions as links, so ./mvnw finds them and can still add others.
      ...(shares.some(([tag]) => tag === 'm2wrapper') ? ['mkdir -p ~/.m2/wrapper && cp -as /host/m2wrapper/. ~/.m2/wrapper/'] : []),
      // Docker pulls through the proxy; it starts only now, with this run's proxy login.
      `printf %s ${q(JSON.stringify({ proxies: { 'http-proxy': url, 'https-proxy': url, 'no-proxy': 'localhost,127.0.0.1' } }))} | sudo tee /etc/docker/daemon.json >/dev/null`,
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

  // Docker's events in the VM, for the chat's log and the containers view.
  #watchDocker() {
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
      const out = await run('ssh', this.ssh('docker ps -a --format "{{json .}}"; echo ---; docker stats --no-stream --format "{{json .}}"; echo ---; free -m | awk \'/Mem:/{print $2, $3}\'; nproc'), { timeout: 15_000 });
      const [ps, stats, sys] = out.split('---\n');
      const use = new Map(stats.split('\n').filter(Boolean).map((l) => { try { const s = JSON.parse(l); return [s.Name, s]; } catch { return [null]; } }));
      this.containers = ps.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
        .map((c) => ({ name: c.Names, image: c.Image, state: c.State, status: c.Status, ports: c.Ports, cpu: use.get(c.Names)?.CPUPerc, mem: use.get(c.Names)?.MemUsage }));
      const [mem, cpus] = sys.trim().split('\n');
      const [total, used] = (mem || '').split(' ').map(Number);
      this.system = { memTotalMb: total, memUsedMb: used, cpus: Number(cpus) || 4 };
    } catch { /* busy or going down */ }
    return this;
  }

  // Run a command in the chat's folder in the VM; output comes as it's written.
  async exec(argv, cwd, out, err, { signal, java } = {}) {
    await this.start();
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
      const timer = setTimeout(() => { this.event(`Stopped after 60 minutes: ${line.slice(0, 120)}`, 'run'); stop(); }, 60 * 6e4);
      // (The sandbox side hangs up once it has the answer too: that's not a stop.)
      signal?.addEventListener('abort', () => { if (ended) return; stopped = true; this.event(`Stopped: ${line.slice(0, 120)}`, 'run'); stop(); });
      p.on('exit', (c) => { ended = true; clearTimeout(timer); done(c ?? 1); }).on('error', () => done(127));
    });
    if (!stopped) this.event(`${code === 0 ? 'done' : `failed (exit ${code})`} in ${Math.round((Date.now() - t0) / 1000)}s: ${line.slice(0, 120)}`, 'run');
    this.#idle();
    this.refresh();
    return code;
  }

  #idle() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => { this.event('Stopping the VM: idle for 30 minutes'); this.stop(); }, IDLE_MS);
    this.idleTimer.unref?.();
  }

  stop() {
    if (this.state === 'off') return;
    this.state = 'off';
    this.watcher?.kill();
    this.qemu?.kill('SIGTERM');
    this.#gone();
  }

  #gone() {
    this.state = 'off';
    clearTimeout(this.idleTimer);
    this.containers = [];
    this.startedAt = null;
    live.delete(this);
    rmSync(this.overlay, { force: true });
  }

  view() {
    let disk = null;
    try { disk = statSync(this.overlay).blocks * 512; } catch {}
    return { state: this.state, startedAt: this.startedAt && new Date(this.startedAt).toISOString(), cwd: this.cwd, commands: this.commands,
      vcpus: 4, memMb: 6144, system: this.system || null, diskBytes: disk, containers: this.containers,
      network: { via: 'the sandbox\'s proxy', hosts: this.hosts }, shares: this.shares || [this.cwd],
      events: this.events.slice(-150) };
  }
}

// The JDK a command runs with: yours (from the shared /usr/lib/jvm) when it's one of those.
export const javaEnv = (java) => (java && /^\/usr\/lib\/jvm\/[\w.+-]+$/.test(java) ? ` JAVA_HOME=${q(java)} PATH=${q(`${java}/bin`)}:"$PATH"` : '');

// Maven in the VM: through the proxy, with your repository as a read-only fallback.
export function mavenSettings(proxy) {
  const m = /^http:\/\/(?:([^:@]+):([^@]+)@)?$/.exec(proxy.url) || [];
  const auth = m[1] ? `<username>${m[1]}</username><password>${m[2]}</password>` : '';
  return `<settings><proxies><proxy><id>clearsky</id><active>true</active><protocol>http</protocol><host>${PROXY_IN_VM.host}</host><port>${PROXY_IN_VM.port}</port>${auth}<nonProxyHosts>localhost|127.0.0.1</nonProxyHosts></proxy></proxies></settings>\n`;
}
