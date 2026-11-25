// Where a chat's builds and jobs run: its VM (lib/vm.mjs) or the sandbox, what they are given, and
// how loaded they are (the VMs page).
import { readFileSync, existsSync, realpathSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir, availableParallelism, totalmem } from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as localState from '../state.mjs';
import { sandboxEnded, sandboxProxy, maskedEnv, DEFAULT_DOMAINS, parseDomains } from '../sandbox.mjs';
import { VmImage, ChatVm, VM_DOMAINS, registryLoginHint, refusedRefs } from '../vm.mjs';
import { mirrorStats, cacheCapBytes } from '../registry-mirror.mjs';
import { VmQueue } from '../vm-queue.mjs';
import { logEvent } from '../event-log.mjs';
import { TreeLoad } from '../proc-load.mjs';
import { sandboxCa } from '../maven.mjs';
import { stateFile, list } from './config.mjs';
import { execFileP } from './services.mjs';
import { copilotEnv, acpChats, chatByKey, sessionsCache, isDir } from './chat-env.mjs';
import { buildsWhere } from './chat-hints.mjs';

// ---------------------------------------------------------------- a chat's VM

// Each sandboxed chat's VM (lib/vm.mjs), for `vm <command>`: started on first use, in the git
// checkout (or folder) the command runs in, and stopped with the chat.
let vmImage = null;
export async function vmRun({ key, argv, cwd, java, signal }, out, err) {
  const c = chatByKey(key);
  if (!c) throw new Error('this chat is closed');
  const proxy = await sandboxProxy();
  if (!proxy) throw new Error('the sandbox\'s proxy isn\'t running');
  proxy.ca = readFileSync(sandboxCa(join(dirname(stateFile), 'sandbox')).cert, 'utf8'); // the VM trusts it: the proxy reads Docker Hub's HTTPS
  // The VM holds one folder (its git checkout): a command in another one gets a new VM, and says
  // so. Paths are compared as real paths (git names the checkout by its real path; the command's
  // may go through a link), so a command in the same checkout never moves it.
  if (c.vm && c.vm.state !== 'off' && !within(cwd, c.vm.cwd)) {
    c.vm.event(`Moving the VM from ${c.vm.cwd} to ${cwd}: a new VM, the containers in the old one are gone`); c.vm.stop(); c.vm = null;
  }
  if (!c.vm || c.vm.state === 'off') {
    let root = real(cwd);
    try { root = execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || root; } catch {}
    vmImage ||= new VmImage({ log: console.log });
    const old = c.vm?.events || [];
    c.vm = new ChatVm({ id: randomBytes(4).toString('hex'), cwd: root, image: vmImage, proxy, hosts: sandboxHosts(), maven: () => vmMaven(c.agent.maven), log: logEvent });
    c.vm.images = () => list(process.env.AGENT_VM_IMAGES);
    c.vm.events.push(...old);
    bindVm(c);
  }
  // In line for a VM when other chats' VMs fill the places (Settings → Agent → VMs at the same
  // time): the command, the chat and the VM's view all say where it is.
  const vm = c.vm;
  vm.onStop ||= () => vmQueue.drop(vm, 'this chat\'s VM was stopped while it waited');
  vm.queue ||= () => vmQueue.view(vm);
  const { waited, ms } = await vmQueue.enter(vm, {
    signal,
    evict: () => { vm.event('Stopping the VM: another chat is waiting for one. It starts again on the next vm command'); vm.stop(); },
    notify: ({ position, limit }) => {
      const text = `Waiting for a VM: ${ordinal(position)} in line (${limit} at a time)`;
      vm.event(text);
      err(`Clearsky: ${text}. Other chats' builds run first; this command starts on its own.\n`);
    },
  });
  if (waited) vm.event(`Got a VM after ${Math.round(ms / 1000)}s in line`);
  let said = '';
  const errSeen = (d) => { if (said.length < 65536) said += d; err(d); };
  try {
    const code = await vm.exec(argv, cwd, out, errSeen, { signal, java: java?.startsWith('/usr/lib/jvm/') ? java : hostJava() });
    if (!code) return code;
    // A registry refused the VM for want of a login (compose, a build, a run): the images named in
    // Settings come through your own Docker instead (ChatVm.fetchImages), then the command can go again.
    const hint = registryLoginHint(argv, said);
    if (hint) {
      const { got, failed } = await vm.fetchImages(refusedRefs(said, argv)).catch(() => ({ got: [], failed: [] }));
      if (got.length) err(`\nClearsky: the VM has no registry login, so ${got.join(', ')} ${got.length > 1 ? 'were' : 'was'} pulled with the user's own login on their machine and copied into the VM. Run the command again.\n`);
      for (const [ref, why] of failed) err(`\nClearsky: pulling ${ref} on the user's machine failed: ${why}\n`);
      if (!got.length && !failed.length) err(hint);
    }
    return code;
  } finally { vmQueue.leave(vm); }
}
export const vmQueue = new VmQueue();
const real = (p) => { try { return realpathSync(p); } catch { return p; } };
// Whether folder `dir` is `root` or inside it, links resolved.
export function within(dir, root, resolve = real) {
  const d = resolve(dir).replace(/\/+$/, ''), r = resolve(root).replace(/\/+$/, '');
  return d === r || d.startsWith(`${r}/`);
}
// Maven's settings for a chat's VM: the sandbox's copy of yours (mirrors, repositories, logins as
// srt's stand-ins), which srt's proxy completes on the way out, as it does for the sandbox.
export function vmMaven(maven, { masked = maskedEnv } = {}) {
  if (!maven?.settings) return null;
  let xml;
  try { xml = readFileSync(maven.settings, 'utf8'); } catch { return null; }
  let trust = null;
  if (maven.trust && maven.credentials?.length) { try { trust = readFileSync(maven.trust); } catch { /* no CA: logins can't be added */ } }
  return { xml, env: masked(maven.credentials || []), trust, unmatched: maven.unmatched || [] };
}

// ---------------------------------------------------------------- a command in the sandbox or outside it

const jobGroups = new Set(); // process groups of jobs running here, ended with Clearsky
process.on('exit', () => { for (const pid of jobGroups) { try { process.kill(-pid, 'SIGTERM'); } catch {} } });
// Run a command in its own process group, its output to out/err, until it ends or `signal` stops it.
function spawnJob(bin, args, { cwd, env, signal, hours = 4, onPid = null }, out, err) {
  return new Promise((done) => {
    const child = spawn(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    if (child.pid) { jobGroups.add(child.pid); onPid?.(child.pid); }
    const kill = () => { try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM'); else child.kill('SIGTERM'); } catch {} };
    const timer = setTimeout(() => { err(`\nClearsky: stopped after ${hours} hours.\n`); kill(); }, hours * 36e5);
    signal?.addEventListener('abort', () => { err('\nClearsky: stopped.\n'); kill(); }, { once: true });
    child.stdout.on('data', (d) => out(d));
    child.stderr.on('data', (d) => err(d));
    child.on('error', (e) => { err(`${e.message}\n`); });
    child.on('close', (code) => { clearTimeout(timer); jobGroups.delete(child.pid); done(code ?? 1); });
  });
}
// A short command (git) in a chat's sandbox, with execFile's shape: for what Clearsky runs in a
// folder the chat can write, where git would run programs the chat names (lib/safe-git.mjs).
export const sandboxRun = (c) => async (bin, args, opts = {}) => {
  if (!c?.agent?.inSandbox || c.agent.closed) throw new Error('this chat\'s sandbox has stopped');
  const dir = args[0] === '-C' && isDir(args[1]) ? args[1] : c.cwd;
  const s = await c.agent.inSandbox([bin, ...args], dir);
  try { return await execFileP(s.bin, s.args, { ...opts, env: s.env, cwd: dir }); } finally { sandboxEnded(); }
};
// Background jobs running in a chat's sandbox: pid → chat, for the VMs view's sandbox load.
const sandboxJobs = new Map();
// Where a job runs is the fence of the chat that started it.
export async function runJob(job, out, err, signal) {
  const c = acpChats.get(job.chat);
  if (job.where === 'vm') return vmRun({ key: c?.agent.brokerKey, argv: job.argv, cwd: job.cwd, java: job.java, signal }, out, err);
  if (job.where === 'outside') return spawnJob(job.argv[0], job.argv.slice(1), { cwd: job.cwd, env: copilotEnv(), signal }, out, err);
  if (!c?.agent.inSandbox) throw new Error('this chat\'s sandbox has stopped');
  const s = await c.agent.inSandbox(job.argv, job.cwd);
  let pid = null;
  try { return await spawnJob(s.bin, s.args, { cwd: job.cwd, env: s.env, signal, onPid: (p) => { pid = p; sandboxJobs.set(p, job.chat); } }, out, err); } finally { sandboxJobs.delete(pid); sandboxEnded(); }
}

// ---------------------------------------------------------------- the VMs page

// Every chat's VM that runs or waits, running ones first (oldest first), then the line in order.
export async function vmsOverview({ look = true } = {}) {
  const snap = vmQueue.snapshot();
  const names = localState.sessionNames(stateFile), titles = new Map((sessionsCache?.data || []).map((x) => [x.id, x.title]));
  const tilde = (p) => (p && p.startsWith(homedir()) ? `~${p.slice(homedir().length)}` : p);
  const held = new Map(snap.holders.map((h) => [h.holder, h])), line = new Map(snap.line.map((w) => [w.holder, w]));
  const chats = [...acpChats].filter(([, c]) => c.vm && (c.vm.state !== 'off' || held.has(c.vm) || line.has(c.vm)));
  if (look) await Promise.all(chats.map(([, c]) => c.vm.refresh())); // ssh into each: only while the view is open
  const vms = chats.map(([id, c]) => {
    const v = c.vm.view(), h = held.get(c.vm), w = line.get(c.vm);
    return { chat: id, title: names[id] || titles.get(id) || null, state: v.state, place: w ? 'waiting' : h ? 'running' : v.state === 'off' ? 'off' : 'running',
      position: w?.position ?? null, busy: !!h?.active, since: new Date(w?.since ?? h?.since ?? (Date.parse(v.startedAt) || Date.now())).toISOString(),
      startedAt: v.startedAt, cwd: tilde(v.cwd), commands: v.commands, vcpus: v.vcpus, memMb: v.memMb, diskBytes: v.diskBytes, system: v.system, containers: v.containers };
  }).sort((a, b) => (a.place === 'waiting') - (b.place === 'waiting') || (a.position ?? 0) - (b.position ?? 0) || Date.parse(a.since) - Date.parse(b.since));
  return { limit: snap.limit, running: snap.holders.length, waiting: snap.line.length, vms, sandboxes: sandboxesLoad(names, titles), builds: buildsWhere(),
    imageCache: imageCacheView(), host: { cpus: availableParallelism(), memMb: Math.floor(totalmem() / 1048576) } };
}
// The VMs' Docker Hub image cache (lib/registry-mirror.mjs): what's in it, looked at most every
// 15 seconds (the VMs view asks every 3).
export const IMAGE_CACHE_DIR = join(homedir(), '.cache', 'clearsky', 'vm', 'registry');
let imageCacheSeen = null;
export function imageCacheView(fresh = false) {
  if (fresh || !imageCacheSeen || Date.now() - imageCacheSeen.at > 15_000) imageCacheSeen = { at: Date.now(), ...mirrorStats(IMAGE_CACHE_DIR) };
  const { at, ...s } = imageCacheSeen;
  return { ...s, capBytes: cacheCapBytes() };
}
// What chats' sandboxes run on this machine itself (Linux): the sandbox fences files and network,
// not CPU, so a build run there instead of in the VM shows here, with its busiest process.
const treeLoad = new TreeLoad();
function sandboxesLoad(names, titles) {
  if (process.platform !== 'linux') return [];
  const roots = new Map();
  for (const [id, c] of acpChats) if (c.agent?.sandboxed && !c.agent.closed && c.agent.child?.pid) roots.set(`${id}\t${c.agent.child.pid}`, c.agent.child.pid);
  for (const [pid, id] of sandboxJobs) roots.set(`${id}\t${pid}`, pid);
  const per = new Map();
  for (const [key, l] of treeLoad.sample(roots)) {
    const id = key.split('\t')[0], a = per.get(id) || { chat: id, title: names[id] || titles.get(id) || null, cpuPct: null, memMb: 0, procs: 0, top: null, jobs: 0 };
    if (l.cpuPct != null) a.cpuPct = (a.cpuPct || 0) + l.cpuPct;
    a.memMb += l.memMb; a.procs += l.procs;
    if (l.top && (!a.top || l.top.cpuPct > a.top.cpuPct)) a.top = l.top;
    if (sandboxJobs.has(Number(key.split('\t')[1]))) a.jobs++;
    per.set(id, a);
  }
  return [...per.values()].sort((a, b) => (b.cpuPct || 0) - (a.cpuPct || 0));
}

// ---------------------------------------------------------------- what the VM is given

const ordinal = (n) => `${n}${[, 'st', 'nd', 'rd'][n % 100 >> 3 ^ 1 && n % 10] || 'th'}`;
// VM events show in the chat as they happen (commands and containers; the rest is in its view).
export function bindVm(c) {
  const shown = { vm: /^(VM up|Docker ready|Stopping|Stopped from|The VM stopped|Moving the VM|Preparing|Downloading|VM image|Waiting for a VM|Got a VM)/, docker: /^(start|die|oom) /, run: /^(done|failed|Stopped)/ };
  // Containers stopped after the tests (Testcontainers kills them: exit 137, its reaper exits 0)
  // are cleanup, not a crash: one quiet line for them all. Other exits show as they happen.
  let stopped = 0, timer = null;
  const cleanup = () => { if (stopped) c.emit({ type: 'note', text: `VM: ${stopped} test container${stopped > 1 ? 's' : ''} stopped` }); stopped = 0; timer = null; };
  if (c.vm) c.vm.onEvent = (e) => {
    if (e.kind === 'docker' && /^die .*, exit (137|143)$|^die [^,]*$|^die .*, exit 0$/.test(e.text)) { stopped++; clearTimeout(timer); timer = setTimeout(cleanup, 2000); return; }
    if (shown[e.kind]?.test(e.text)) c.emit({ type: 'note', text: `VM: ${e.text}` });
  };
}
// Your default JDK (what `java` is here) for the VM, which has your /usr/lib/jvm in place of its
// own; else the newest one in there.
let defaultJava;
function hostJava() {
  if (defaultJava === undefined) {
    try { defaultJava = realpathSync(execFileSync('sh', ['-c', 'command -v java'], { encoding: 'utf8', timeout: 3000 }).trim()).replace(/\/bin\/java$/, ''); } catch { defaultJava = null; }
    if (!defaultJava?.startsWith('/usr/lib/jvm/')) {
      try { defaultJava = readdirSync('/usr/lib/jvm').filter((d) => existsSync(`/usr/lib/jvm/${d}/bin/java`)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).map((d) => `/usr/lib/jvm/${d}`).pop() || null; } catch { defaultJava = null; }
    }
  }
  return defaultJava;
}
const sandboxHosts = () => [...new Set([...(process.env.AGENT_DOMAINS ? parseDomains(process.env.AGENT_DOMAINS) : DEFAULT_DOMAINS), ...VM_DOMAINS])];
