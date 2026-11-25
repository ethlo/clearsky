// The chat engine: an agent started in or outside the sandbox, its turns, what it may run through
// Clearsky's doors, background jobs that wake it, and the watchdog that nudges a chat that stopped early.
import { readFileSync, writeFileSync, statSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { delimiter } from 'node:path';
import { randomBytes } from 'node:crypto';
import * as localState from '../state.mjs';
import * as copilot from '../copilot.mjs';
import { AcpAgent, chatEvent } from '../acp.mjs';
import * as checkpoints from '../checkpoints.mjs';
import { hooksConfig, hookFiles, runHook, failText, tail as hookTail } from '../hooks.mjs';
import { sessionUsage } from '../copilot-events.mjs';
import { sandboxedCommand, sandboxEnded, sandboxProxyLogin, sandboxNetwork, githubLogin, DEFAULT_DOMAINS, parseDomains } from '../sandbox.mjs';
import { HostDoor, ruleMatches, stepLines, commandNotes } from '../host-door.mjs';
import { closeCards } from '../chat-cards.mjs';
import { vmSupport, VM_DOMAINS } from '../vm.mjs';
import { Jobs, jobReport, jobView, shellLine, tailOf } from '../jobs.mjs';
import { Watchdog, watchdogSettings, nudgeText, REASONS as NUDGE_REASONS, AUTO_MARK } from '../watchdog.mjs';
import { logWrite, readWrites } from '../agent-log.mjs';
import { redact } from '../redact.mjs';
import * as memory from '../memory.mjs';
import { disclosureLine, disclosureFields, creditSplit } from '../disclosure.mjs';
import { parseReviewArgs, changeOf, reviewPrompt, writeBaseFiles, reviewDecision, USAGE as REVIEW_USAGE } from '../review.mjs';
import { buildKind } from '../map.mjs';
import { serveBroker, brokerSocket } from '../broker.mjs';
import { mavenSandbox, sandboxCa, plainMaven, withSandboxProxy, PROXY_TOKEN_ENV } from '../maven.mjs';
import { githubFilter, REGISTRY_HOSTS, GITHUB_LOG_HOSTS } from '../github-gate.mjs';
import { makeContext } from '../sources.mjs';
import { logEvent } from '../event-log.mjs';
import { reviewGate } from '../review-gate.mjs';
import * as chatScope from '../chat-scope.mjs';
import { untilde } from '../util.mjs';
import { AGENTS } from '../agents.mjs';
import { appDir, stateFile, agentLogFile, scopesFile, agentFilesFile, vpn, config, backend, saveSettings } from './config.mjs';
import { ghModule, ticketGoal } from './services.mjs';
import { sessionAgent, chatAgent, copilotCwd, copilotInfo, copilotTmp, copilotEnv, copilotHome, acpChats, SANDBOX_GIT, chatFolders, sandboxOpts, ghToken, chatRef, gitRepos, gitReposLater, tildeHome, chatByKey, forgetSessions, isDir, assistedAllow, copilotFolders } from './chat-env.mjs';
import { doorsByName, UPDATE_INTRO, sandboxHintFor, MSG_MARK, typedPart } from './chat-hints.mjs';
import { hostAsk, githubAsk, askingChats, githubLook, githubTold, githubScope, brokerWhere, brokerAsk, askInChat } from './chat-gate.mjs';
import { vmRun, sandboxRun, runJob, bindVm, loginRegistries } from './chat-builds.mjs';

// ---------------------------------------------------------------- starting and stopping an agent

// Slash commands Copilot last offered (its built-ins and your skills).
export let copilotCommands = null;
export const hintOwed = new Set(); // resumed chats whose first message was a command: the hint goes with the next one

// An agent left idle for 20 minutes is closed, and its VM stopped; the chat is resumed by its next message.
setInterval(() => {
  // Not one with a background job running (its VM runs it) or a nudge due (lib/watchdog.mjs).
  for (const [id, c] of acpChats) if (!c.busy && !c.waiting.size && Date.now() - c.lastUsed > 20 * 6e4 && !jobs.running(id).length && !watchdog.view(id).due) { c.agent.close(); c.vm?.stop(); acpChats.delete(id); }
}, 60_000).unref();

// Stop a turn on purpose. Closing the page or switching chats leaves it running.
export function stopCopilot(chat) {
  const c = acpChats.get(chat);
  if (c) {
    c.userStopped = true; // no nudge for a turn you stopped
    watchdog.cancel(chat);
    autoInbox.delete(chat);
    c.agent.cancel();
    for (const r of c.waiting.values()) r({ outcome: 'cancelled' });
    c.waiting.clear(); c.pending.clear();
  }
  return !!c;
}

let broker = null;
// Start Copilot, inside the sandbox (srt, run by Clearsky itself) when the mode or Settings →
// Copilot says so.
// `permission` and `model` are the chat's (Claude Code takes them as a session mode and an
// environment variable); `dirs`, the folders it may use besides its own (Copilot takes flags).
// `agent`: which one ("copilot", "claude"; the default one if left out). `bin` null: its own.
async function startAgent(bin, args, cwd, { sandbox = process.env.AGENT_SANDBOX === 'srt', folders = [], permission = 'ask', model = null, dirs = [], agent: name = null } = {}) {
  const b = backend(name);
  bin ||= b.find();
  if (!bin) throw new Error(`${b.product} isn't installed here (${b.install.command})`);
  const how = { label: b.label, mode: b.sessionMode(permission), dirs, acp: false };
  const own = () => ({ ...copilotEnv(b), ...b.env({ model }) });
  if (!sandbox) return new AcpAgent(bin, b.acp(args), { env: own(), ...how });
  // In Clearsky's container, the container is the sandbox: Copilot sees only what's mounted
  // (git already goes over https there). The network isn't limited to AGENT_DOMAINS, though.
  if (process.env.CLEARSKY_IN_CONTAINER === '1') return Object.assign(new AcpAgent(bin, b.acp(args), { env: own(), ...how }), { sandboxed: true });
  // The chats' VMs share the sandbox's proxy, so its hosts include what they need (Docker Hub…),
  // and the agent's own service (Claude Code's; Copilot's is in the defaults).
  const domains = [...new Set([...(process.env.AGENT_DOMAINS ? parseDomains(process.env.AGENT_DOMAINS) : DEFAULT_DOMAINS), ...b.hosts, ...(vmSupport().ok ? VM_DOMAINS : [])])];
  const keep = join(dirname(stateFile), 'sandbox');
  // Logins stay out here; srt adds them on the way out. srt reads them from Clearsky's own
  // environment, and the sandbox gets stand-ins: Maven's (lib/maven.mjs) and your gh login.
  let maven = null;
  // The chat's folders' poms name the repositories that settings.xml has only logins for.
  try { maven = mavenSandbox({ home: homedir(), out: join(dirname(brokerSocket()), 'maven'), keep, dirs: [cwd, ...folders] }); } catch (e) {
    console.error(`clearsky: Maven logins for the sandbox: ${e.message}`);
    // Without the logins, Maven still runs from your local repository with a copy minus secrets.
    try { maven = plainMaven(readFileSync(join(homedir(), '.m2', 'settings.xml'), 'utf8'), join(dirname(brokerSocket()), 'maven')); } catch { /* no settings */ }
  }
  // No settings.xml of yours: Maven still needs one, to find srt's proxy (below).
  if (!maven) try { maven = plainMaven('<settings>\n</settings>\n', join(dirname(brokerSocket()), 'maven')); } catch { /* can't write it */ }
  if (maven) Object.assign(process.env, maven.env);
  if (maven?.unmatched?.length) console.error(`clearsky: Maven logins with no repository host found (in settings.xml or the poms under ${cwd}): ${maven.unmatched.join(', ')}`);
  const env = { ...own(), ...b.sandboxEnv() };
  const n = Number(env.GIT_CONFIG_COUNT) || 0;
  // A token from Settings → Agent if you made one, else your gh login.
  const token = process.env.AGENT_SANDBOX_TOKEN || ghToken();
  const github = token ? githubLogin(token, process.env, n + SANDBOX_GIT.length) : null;
  [...SANDBOX_GIT, ...(github ? [github.git] : [])].forEach(([k, v], i) => { env[`GIT_CONFIG_KEY_${n + i}`] = k; env[`GIT_CONFIG_VALUE_${n + i}`] = v; });
  env.GIT_CONFIG_COUNT = String(n + SANDBOX_GIT.length + (github ? 1 : 0));
  if (maven) {
    env.MAVEN_ARGS = `${env.MAVEN_ARGS ? `${env.MAVEN_ARGS} ` : ''}--settings ${maven.settings}`;
    if (maven.javaOptions) env.MAVEN_OPTS = `${env.MAVEN_OPTS ? `${env.MAVEN_OPTS} ` : ''}${maven.javaOptions}`;
  }
  // The real values never go in: srt sets the stand-ins.
  for (const c of [...(github?.credentials || []), ...(maven?.credentials || [])]) delete env[c.name];
  // Under WSL: no way to Windows programs from inside (the interop socket is hidden too, lib/wsl.mjs).
  delete env.WSL_INTEROP;
  // The doors srt's network can't be (lib/broker.mjs): acli and `outside` reach Clearsky, which
  // asks you in this chat. The key tells Clearsky which chat a request comes from.
  const key = randomBytes(16).toString('hex');
  if (process.platform === 'linux') {
    broker ||= serveBroker({ bins: { acli: config.jira.acli }, gate: ({ argv }) => reviewGate(argv, (k) => ghModule.ticketPrs(k, { fresh: true })), allow: assistedAllow, ask: brokerAsk, where: brokerWhere, vm: vmSupport().ok ? vmRun : null, doors: pluginDoor, review: reviewRun, usage: usageRun, jobs: jobsDoor, reads: () => [copilotTmp()], notes: brokerNotes, log: console.log });
    Object.assign(env, { CLEARSKY_BROKER_SOCKET: brokerSocket(), CLEARSKY_BROKER_KEY: key });
    env.PATH = `${join(appDir, 'scripts', 'sandbox-bin')}${delimiter}${env.PATH}`;
  }
  // srt hands the sandbox TMPDIR=/tmp/claude unless told otherwise, so $TMPDIR in a chat wasn't
  // the scratch folder Clearsky reads acli's text files from (lib/broker.mjs): its Markdown went
  // to Jira as it was. The same folder inside and out.
  process.env.CLAUDE_CODE_TMPDIR = copilotTmp();
  // Copilot's built-in GitHub tools would change GitHub past the gate: off (b.sandboxArgs).
  const s = await sandboxedCommand(bin, b.acp([...args, ...b.sandboxArgs]), { ...sandboxOpts(cwd, folders), state: b.state, protect: b.protect, run: dirname(brokerSocket()), domains, maven, github, ca: sandboxCa(keep),
    // Read only, so the proxy reads them: CI logs (with GitHub on), Docker Hub (with the VM).
    inspect: [...(github ? GITHUB_LOG_HOSTS : []), ...(vmSupport().ok ? REGISTRY_HOSTS : [])] },
    sandboxGate());
  // Maven reaches the net only through srt's proxy, with its login (lib/maven.mjs): otherwise a
  // download gets the proxy's 407, and the host door never asks about the host.
  const proxy = maven && await sandboxProxyLogin();
  if (proxy) {
    try {
      writeFileSync(maven.settings, withSandboxProxy(readFileSync(maven.settings, 'utf8'), { ...proxy, token: !!proxy.token }), { mode: 0o600 });
      if (proxy.token) env[PROXY_TOKEN_ENV] = proxy.token;
    } catch (e) { console.error(`clearsky: Maven's proxy for the sandbox: ${e.message}`); }
  }
  const agent = new AcpAgent(s.bin, s.args, { env, ...how });
  agent.child.once('exit', sandboxEnded);
  // A background job (`bg <command>`) runs in a sandbox of its own with the same fence: folders,
  // hosts, logins added on the way out, and the GitHub gate.
  agent.inSandbox = async (argv, dir) => ({ env, ...await sandboxedCommand(argv[0], argv.slice(1), { ...sandboxOpts(dir, folders), state: b.state, protect: b.protect, run: dirname(brokerSocket()), domains, maven, github, ca: sandboxCa(keep),
    inspect: [...(github ? GITHUB_LOG_HOSTS : []), ...(vmSupport().ok ? REGISTRY_HOSTS : [])] },
  sandboxGate()) });
  return Object.assign(agent, { sandboxed: true, brokerKey: key, maven,
    github: github ? `${process.env.AGENT_SANDBOX_TOKEN ? 'your sandbox token' : 'your gh login'}, added on the way out; changes ask you` : 'not signed in (gh auth login)',
    hosts: [...new Set([...domains, ...(maven?.hosts || []), ...(github?.read || [])])] });
}

// srt's proxy asks Clearsky about two things: hosts not on its list (the host door, which asks
// you before Copilot reaches a new host) and requests it reads (data sent to such a host, and
// GitHub changes).
function sandboxGate() {
  const github = githubFilter(githubAsk, { told: githubTold, look: githubLook, scope: githubScope });
  const listed = (host) => sandboxNetwork().allowed.some((r) => ruleMatches(r.replace(/:\d+$/, ''), host, 443));
  return { ask: (p) => hostDoor.decide(p), filterRequest: async (req) => (await hostDoor.check(req, { listed })) || github(req) };
}
// The host door (lib/host-door.mjs): a host not on the sandbox's list waits at the proxy for your
// answer in the working chat. Always allowed ones are Settings → Agent → Hosts allowed from a chat.
const hostDoor = new HostDoor({
  chats: () => askingChats(null),
  ask: hostAsk,
  always: () => parseDomains(process.env.AGENT_READ_HOSTS),
  addAlways: (rule) => {
    const hosts = parseDomains(process.env.AGENT_READ_HOSTS);
    if (hosts.includes(rule)) return;
    saveSettings({ AGENT_READ_HOSTS: [...hosts, rule].join(', ') });
  },
  readable: () => sandboxNetwork().readsHttps,
  // You answered after the request gave up (or long enough that it may have): the chat goes on.
  // A chat at work hears it in the output of its next Clearsky command (`vm`, a door), in its turn:
  // a message after the turn comes too late when it already went another way.
  late: (chats, rule) => {
    for (const c of chats) {
      const text = `Clearsky: ${rule} is allowed now. If a request there failed while you waited, try it again and go on.`;
      if (!acpChats.get(c.id)?.busy) { tellChat(c.id, text); continue; }
      if (!doorNotes.has(c.id)) doorNotes.set(c.id, new Map());
      doorNotes.get(c.id).set(rule, text);
    }
  },
  // What each chat was doing when the host was asked for (the proxy can't say which chat it was).
  steps: (chats, host) => chats.flatMap((c) => {
    const lines = stepLines([...(c.steps?.values() || [])], host, backend(c.agentName).label);
    return chats.length > 1 && lines.length ? [`In the chat in ${tildeHome(c.cwd)}:`, ...lines] : lines;
  }),
  seen: (chats, line) => { for (const c of chats) c.emit({ type: 'note', text: `Network: ${line} (read)` }); },
  // A registry your Docker or Podman is logged in to: the VM gets its images through your Docker
  // (lib/app/chat-builds.mjs), so its own pull there is turned away at once instead of asking.
  refuse: (host, port) => port === 443 && vmSupport().ok && loginRegistries().has(host),
});

const doorNotes = new Map(); // chat id → Map(rule → text): hosts allowed while the chat worked, not told yet
// What a chat's Clearsky command (lib/broker.mjs) adds to its output (lib/host-door.mjs).
export async function brokerNotes(key, { code, vm } = {}) {
  const c = chatByKey(key);
  return c ? commandNotes({ door: hostDoor, id: c.id, untold: doorNotes, code, vm }) : '';
}

// ---------------------------------------------------------------- background jobs and the watchdog
// Chats stopped on long tasks: a turn that waits on a 20-minute build or a CI run runs into its
// limits, or Copilot gives up on the wait. So a long command runs as a background job
// (lib/jobs.mjs, `bg <command>`), the chat ends its turn, and Clearsky wakes it with the result.
// And a chat that stops before its task is done gets a nudge to go on (lib/watchdog.mjs).
export const jobs = new Jobs({ file: join(dirname(stateFile), 'jobs.json'), logDir: () => join(copilotTmp(), 'jobs'), run: runJob, onEnd: jobEnded });
export function jobEnded(job) {
  console.log(`clearsky: background job ${job.where} -> ${job.state}${job.code != null ? ` (exit ${job.code})` : ''}`);
  const c = acpChats.get(job.chat);
  c?.emit({ type: 'note', text: `Job ${job.id} ${job.state === 'done' ? 'finished' : job.state}: ${shellLine(job.argv).slice(0, 120)}` });
  tellChat(job.chat, `${AUTO_MARK}${jobReport(job, jobs.tail(job.id, 40, 16 * 1024), { tilde: tildeHome })}`, { ...job.ctx, onSent: () => jobs.told(job.id) });
}
// The `bg` and `jobs` doors (lib/broker.mjs, scripts/sandbox-bin/bg and jobs).
function jobsDoor({ key, tool, where, argv, cwd, java }) {
  const c = chatByKey(key);
  if (!c) return { code: 1, stdout: '', stderr: 'Clearsky: this chat is closed.\n' };
  if (tool === 'bg') {
    const job = jobs.start({ chat: c.id, where, argv, cwd, ctx: { options: c.options, cwd: c.cwd } });
    if (java?.startsWith('/usr/lib/jvm/')) job.java = java;
    c.emit({ type: 'note', text: `Job ${job.id} started ${where === 'sandbox' ? 'in the sandbox' : where === 'vm' ? 'in the VM' : 'outside the sandbox'}: ${shellLine(argv).slice(0, 120)}` });
    return { code: 0, stderr: '', stdout: `Started background job ${job.id}. Its output goes to ${tildeHome(job.log)}.\n`
      + 'End your turn now (say what you are waiting for): Clearsky wakes you in this chat with the result when it ends. '
      + `Meanwhile \`jobs log ${job.id}\` shows its output so far; don't wait for it with sleep.\n` };
  }
  const [cmd = 'list', id, n] = argv;
  if (cmd === 'list' || cmd === 'ls') {
    const mine = jobs.list(c.id).slice(0, 15);
    return { code: 0, stderr: '', stdout: mine.length ? `${mine.map((j) => { const v = jobView(j); return `${j.id}  ${v.state}${j.code != null ? ` (exit ${j.code})` : ''}  ${j.where}  ${Math.round(v.ms / 1000)}s  ${v.command}`; }).join('\n')}\n` : 'No background jobs in this chat.\n' };
  }
  const job = id && jobs.get(id);
  if (!job || job.chat !== c.id) return { code: 1, stdout: '', stderr: `Clearsky: no job ${id || ''} in this chat (\`jobs\` lists them).\n` };
  if (cmd === 'log') return { code: 0, stderr: '', stdout: `${tailOf(job.log, Math.min(Math.max(Number(n) || 60, 1), 2000), 512 * 1024)}\n` };
  if (cmd === 'stop') return jobs.stop(job.id) ? { code: 0, stderr: '', stdout: `Stopping ${job.id}.\n` } : { code: 1, stdout: '', stderr: `Clearsky: ${job.id} isn't running.\n` };
  return { code: 2, stdout: '', stderr: 'usage: jobs [list] | jobs log <id> [lines] | jobs stop <id>\n' };
}

// Messages Clearsky sends a chat on its own (a job's result, a nudge): one turn at a time, after
// the chat's own; a chat whose Copilot closed meanwhile is resumed, as your next message would.
const autoInbox = new Map(); // chat → [{ text, ctx }]
const autoBusy = new Set();
function tellChat(id, text, ctx = {}) {
  autoInbox.set(id, [...(autoInbox.get(id) || []), { text, ctx }]);
  setImmediate(() => pumpChat(id));
}
async function pumpChat(id) {
  const c = acpChats.get(id);
  if (autoBusy.has(id) || c?.busy || c?.waiting.size || startingChats.has(id)) return; // its turn's end comes back here
  const q = autoInbox.get(id);
  if (!q?.length) return;
  autoInbox.delete(id);
  const ctx = Object.assign({}, ...q.map((x) => x.ctx));
  const options = c?.options || ctx.options, cwd = c?.cwd || ctx.cwd;
  if (!options || !cwd || !isDir(cwd)) { console.log('clearsky: a chat to wake has no mode or folder any more; left for its next message'); return; }
  autoBusy.add(id);
  try {
    const info = await copilotInfo();
    if (!info.available) throw new Error('Copilot CLI not found');
    // A chat that goes on in a new Copilot gets the sandbox's rules again, as for your message.
    const hint = sandboxHintFor(options.permission);
    const owed = hint && (!c || c.agent.closed || hintOwed.has(id));
    hintOwed.delete(id);
    const message = q.map((x) => x.text).join('\n\n');
    const prompt = owed ? `${UPDATE_INTRO}${hint}${MSG_MARK}${message}` : message;
    forgetSessions();
    // Nobody watches yet: an open page sees the chat working and follows it (attachCopilot).
    await acpTurn({ chat: id, options, prompt, resumeId: id, cwd, emit: () => {}, res: { on() {} }, bin: info.bin, auto: true });
    for (const x of q) x.ctx.onSent?.();
  } catch (e) {
    console.log(`clearsky: waking a chat didn't work: ${e.message}`);
  } finally { autoBusy.delete(id); }
  setImmediate(() => pumpChat(id));
}

// Run your hooks in the chat's sandbox after a turn that changed files. True: the check failed
// and the chat was asked to fix it.
async function endHooks(c, cfg, paths) {
  if (!c.agent?.inSandbox || c.agent.closed) { c.emit({ type: 'note', text: 'Hooks: not run, they run only in the sandbox.' }); return false; }
  const run = sandboxRun(c), files = hookFiles(paths, c.cwd, existsSync);
  if (cfg.afterEdit && files.length) {
    const r = await runHook(run, cfg.afterEdit, files);
    c.emit({ type: 'note', text: `Hook after edits: ${r.code ? `failed (exit ${r.code}): ${hookTail(r.out, 3, 300)}` : `done on ${files.length} file${files.length === 1 ? '' : 's'}`}` });
  }
  if (!cfg.beforeDone) return false;
  const r = await runHook(run, cfg.beforeDone, files);
  if (!r.code) { c.emit({ type: 'note', text: `Hook before done: passed (${cfg.beforeDone.slice(0, 80)})` }); return false; }
  c.hookTries = (c.hookTries || 0) + 1;
  if (c.hookTries > cfg.retries) { c.emit({ type: 'note', text: `Hook before done: still failing (exit ${r.code}) after ${cfg.retries} tries; over to you.` }); return false; }
  c.emit({ type: 'note', text: `Hook before done: failed (exit ${r.code}); asking ${backend(c.agentName).label} to fix it (${c.hookTries} of ${cfg.retries}).` });
  tellChat(c.id, `${AUTO_MARK}${failText(cfg.beforeDone, r, { tries: c.hookTries, retries: cfg.retries })}`);
  return true;
}

export const watchdog = new Watchdog();
// A turn ended: Clearsky's own messages go first; then a chat with a job running waits for it;
// else the watchdog looks at how the turn ended.
function afterTurn(c, { stopReason, error, command }) {
  const id = c.id;
  if (autoInbox.get(id)?.length) { setImmediate(() => pumpChat(id)); return; }
  if (command || jobs.running(id).length) return;
  const reason = watchdog.turnEnded(id, { stopReason, error: error?.message || null, text: c.turnText, stuck: c.stuck, stopped: c.userStopped });
  const w = watchdog.view(id);
  if (reason) c.emit({ type: 'note', text: `Watchdog: ${NUDGE_REASONS[reason]}. Nudging it to go on ${reason === 'stuck' ? 'now' : `in ${w.minutes} min`} unless you write first (${w.nudges + 1} of ${w.max}).` });
  else if (w.gaveUp) c.emit({ type: 'note', text: `Watchdog: still not finished after ${w.max} nudges; over to you.` });
}
// Every 15 seconds: a turn with nothing running and no word for long is stopped (and so nudged);
// due nudges go out to chats that are free.
setInterval(() => {
  const cfg = watchdogSettings();
  if (!cfg.nudges) return;
  for (const c of acpChats.values()) {
    if (c.busy && !c.hooking && !c.stuck && !c.waiting.size && !c.running.size && Date.now() - (c.lastEvent || Date.now()) > cfg.stuckMinutes * 6e4) {
      console.log('clearsky: watchdog: a turn had no word and nothing running, stopping it');
      c.stuck = true;
      c.agent.cancel();
    }
  }
  const free = (id) => { const c = acpChats.get(id); return !!c && !c.agent.closed && !c.busy && !c.waiting.size && !jobs.running(id).length && !autoInbox.get(id)?.length; };
  for (const { id, reason, n, max } of watchdog.due(free)) {
    logEvent(`watchdog nudged a chat (${reason}, ${n} of ${max})`, { echo: false });
    tellChat(id, nudgeText(reason, n, max));
  }
}, 15_000).unref();

// ---------------------------------------------------------------- doors: plugins, review, usage

function pluginDoor(name) {
  const found = doorsByName().get(name);
  return found ? (req) => doorRun(found, req) : null;
}
async function doorRun({ p, door }, { key, name, argv }) {
  const c = chatByKey(key);
  if (!c) return { code: 1, stdout: '', stderr: 'Clearsky: this chat is closed.\n' };
  const line = [name, ...argv].map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ');
  const log = (decided, extra = {}) => logWrite(agentLogFile, { where: name, door: p.name, what: line, chats: [chatRef(c)], decided, ...extra });
  if (p.enabled && !p.enabled(process.env)) { log('not set up'); return { code: 1, stdout: '', stderr: `Clearsky: ${p.label} isn't set up yet (Settings → Plugins → ${p.label}).\n` }; }
  const ctx = {
    env: makeContext(p).env, chat: { mode: c.mode },
    ask: ({ title, detail = line, advice } = {}) => askInChat(c, { title: String(title || `${name} as you`), detail, ...(advice && { advice }) }),
    vpn: () => vpn.check(),
  };
  try {
    const r = (await door.run(argv, ctx)) || {};
    const { text, removed } = redact(String(r.stdout ?? ''));
    const max = 200_000, cut = text.length > max;
    log(r.decided || (r.code ? 'failed' : 'ran'), { target: r.target || null, removed });
    return { code: Number.isInteger(r.code) ? r.code : 0, stdout: text ? `${cut ? text.slice(-max) : text}${text.endsWith('\n') ? '' : '\n'}` : '',
      stderr: `${r.stderr || ''}${removed ? `(Clearsky removed ${removed} secret${removed > 1 ? 's' : ''} from this output)\n` : ''}${cut ? '(output cut to its last 200k characters: narrow the query)\n' : ''}` };
  } catch (e) {
    log('failed');
    return { code: 1, stdout: '', stderr: `${name}: ${e.message}\n` };
  }
}
// `review …` from a chat (lib/review.mjs): a proper review by a fresh Copilot, in its own
// sandbox, that gets only the goal and the code. Clearsky works out the diff and reads the
// ticket itself, so nothing of the asking chat (its history, its reasoning) goes along. The
// reviewer may read files in the repo and nothing else: no shell, no edits, no web, no MCPs.
async function reviewRun({ key, argv, cwd, signal }, out, err) {
  const c = chatByKey(key);
  if (!c) { err('Clearsky: this chat is closed.\n'); return 1; }
  const o = parseReviewArgs(argv);
  if (o.help) { out(`${REVIEW_USAGE}\n`); return 0; }
  if (o.error) { err(`review: ${o.error}\n\n${REVIEW_USAGE}\n`); return 2; }
  // git reads the chat's repo inside the chat's sandbox: the repo's settings are the chat's to
  // write, and a diff runs the programs they name (lib/safe-git.mjs).
  const run = sandboxRun(c);
  const root = String((await run('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { timeout: 10_000 }).catch(() => ({ stdout: '' }))).stdout).trim();
  if (!root) { err('review: not in a git repository\n'); return 1; }
  const log = (decided, extra = {}) => logWrite(agentLogFile, { where: 'review', what: ['review', ...argv].join(' '), target: root.replace(homedir(), '~'), repo: [...(gitRepos(root) || [])][0] || null, chats: [chatRef(c)], decided, ...extra });
  let change, ticket = null;
  try { change = await changeOf(root, o.base, { run }); } catch (e) { err(`review: ${e.message}\n`); return 1; }
  if (o.ticket) {
    try { ticket = await ticketGoal(o.ticket); } catch (e) { err(`review: couldn't read ${o.ticket} (${e.message}); use --goal instead\n`); return 1; }
  }
  // The reviewer runs in the same agent as the chat that asks.
  const rb = backend(c?.agentName);
  if (!rb.find()) { err(`review: ${rb.product} isn't found\n`); return 1; }
  err(`Clearsky: a fresh reviewer is reading ${change.branch || 'the change'} against ${change.base}${ticket ? ` for ${ticket.key}` : ''} (it sees only the goal and the code). This takes a few minutes.\n`);
  const model = process.env.AGENT_REVIEW_MODEL || process.env.AGENT_MODEL || undefined;
  const args = rb.args({ permission: 'read', model, deny: ['url'] });
  // The changed files as they were before, in a folder the reviewer's sandbox can read.
  const baseDir = join(copilotTmp(), 'review', randomBytes(6).toString('hex'));
  const baseFiles = await writeBaseFiles(root, change, baseDir, { run }).catch(() => []);
  const roots = [root, ...(baseFiles.length ? [baseDir] : [])];
  const agent = await startAgent(null, args, root, { sandbox: true, permission: 'read', model, agent: rb.name });
  const tally = { allowed: 0, denied: 0 };
  const refused = [];
  // Copilot ends its whole turn ("Operation cancelled by user") when a tool call is refused, so
  // each refusal is said in the asking chat, and the reviewer is told to carry on without it.
  agent.onPermission = async (p) => {
    const once = (p.options || []).find((x) => x.kind === 'allow_once');
    const no = (p.options || []).find((x) => x.kind === 'reject_once');
    const d = reviewDecision(p, roots);
    const ok = once && d.ok;
    tally[ok ? 'allowed' : 'denied']++;
    if (!ok) { refused.push(d.what); err(`Clearsky: the reviewer asked to ${d.what}; it may only read this repo, so that was refused.\n`); }
    return ok ? { outcome: 'selected', optionId: once.optionId } : no ? { outcome: 'selected', optionId: no.optionId } : { outcome: 'cancelled' };
  };
  let text = '', steps = 0;
  agent.onUpdate = (u) => {
    if (u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text') text += u.content.text;
    if (u.sessionUpdate === 'tool_call') { steps++; if (steps % 10 === 0) err(`Clearsky: the reviewer has read ${steps} things so far…\n`); }
  };
  const stop = () => agent.close();
  signal?.addEventListener('abort', stop);
  const timer = setTimeout(stop, 20 * 6e4);
  const verdictOf = (t) => t.match(/VERDICT:\s*(ready|fix first)/i)?.[1]?.toLowerCase() || null;
  let reviewer = null;
  try {
    const id = await agent.start(root);
    reviewer = id;
    localState.setSessionName(stateFile, id, `Review: ${change.branch || 'change'} against ${change.base}`);
    forgetSessions();
    await agent.prompt(reviewPrompt({ goal: o.goal, ticket, change, baseDir, baseFiles }));
    // Cut short by a refusal: tell it what it can read and let it finish, at most twice.
    for (let round = 0; round < 2 && !verdictOf(text) && refused.length && !agent.closed && !signal?.aborted; round++) {
      const seen = refused.length;
      text += '\n';
      await agent.prompt(`That was refused: you asked to ${refused.at(-1)}. You may only read and search files in ${roots.join(' and ')}; no commands, no git, no other folders.${baseFiles.length ? ` The changed files as they were before are in ${baseDir}.` : ''} Carry on with the review from what you can read, and finish with the VERDICT line.`);
      if (refused.length === seen) break;
    }
    const findings = text.trim();
    const verdict = verdictOf(findings);
    log('reviewed', { verdict, steps, ...tally, session: reviewer });
    console.log(`clearsky: review ${verdict || 'no verdict'}, ${steps} steps, ${tally.allowed} allowed, ${tally.denied} denied`);
    if (!verdict && refused.length) {
      out(`${findings ? `${findings}\n\n` : ''}The review didn't finish. The reviewer kept asking for things outside what it may read (${[...new Set(refused)].slice(0, 3).join('; ')}). Run review again; if it happens again, tell the user.\n`);
      return 1;
    }
    out(`${findings || 'The reviewer gave no answer.'}\n`);
    if (change.cut) err('(the diff was long, so the reviewer read the rest from the repo)\n');
    return 0;
  } catch (e) {
    log('failed', { session: reviewer });
    err(`review: ${signal?.aborted ? 'stopped' : e.message}\n`);
    return 1;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
    agent.close();
    try { rmSync(baseDir, { recursive: true, force: true }); } catch { /* gone */ }
  }
}

// The last looked-up dollar rate (Settings → Agent, live rate), without asking again.
export function readFx() {
  if (process.env.CLEARSKY_FX_LIVE !== 'on') return null;
  try { return JSON.parse(readFileSync(join(homedir(), '.cache', 'clearsky', 'fx.json'), 'utf8')); } catch { return null; }
}

// What a chat's work cost, split the way a ticket records it: the chat itself (implementation)
// and the reviewers it ran with `review` (code review), each from its own session log.
export function chatCredits(id, model = null) {
  const home = join(homedir(), '.copilot');
  const ok = (x) => /^[\w-]{8,64}$/.test(x || '');
  const reviews = readWrites(agentLogFile, { chat: id, limit: 3000 }).filter((e) => e.where === 'review' && ok(e.session)).map((e) => e.session);
  return creditSplit([
    { kind: 'implementation', usage: ok(id) ? sessionUsage(home, id) : null, model },
    ...[...new Set(reviews)].map((r) => ({ kind: 'code review', usage: sessionUsage(home, r), model: process.env.AGENT_REVIEW_MODEL || null })),
  ]);
}

// `usage` from a chat: the line for the end of its PR description (lib/disclosure.mjs), from
// the chats' own session logs; `usage --fields` gives it as Jira field values too. Only when
// you switched it on in Settings → Agent.
function usageRun({ key, argv = [] }) {
  const c = chatByKey(key);
  if (!c) return { code: 1, stdout: '', stderr: 'Clearsky: this chat is closed.\n' };
  if (c.agentName !== 'copilot') return { code: 1, stdout: '', stderr: `Clearsky: usage is only counted for Copilot chats so far, not ${backend(c.agentName).label}; leave the line out.\n` };
  if (process.env.AGENT_DISCLOSE !== 'on') return { code: 1, stdout: '', stderr: 'Clearsky: saying what did the work is off (Settings → Agent); leave the line out.\n' };
  const split = chatCredits(c.id, c.model);
  return { code: 0, stdout: `${argv.includes('--fields') ? disclosureFields(split) : disclosureLine(split)}\n`, stderr: '' };
}

// ---------------------------------------------------------------- short-lived agents

// One prompt and its answer, changing nothing: the stand-up summary with Claude Code (Copilot
// has `-p` for that).
export async function oneShot(bin, prompt, { model, timeoutMs = 120_000 } = {}) {
  const b = backend();
  const agent = await startAgent(bin, b.args({ permission: 'read', model }), copilotCwd(), { permission: 'read', model, agent: b.name });
  let text = '';
  agent.onUpdate = (u) => { if (u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text') text += u.content.text; };
  const timer = setTimeout(() => agent.close(), timeoutMs);
  try { await agent.start(copilotCwd()); await agent.prompt(prompt); } finally { clearTimeout(timer); agent.close(); }
  if (!text.trim()) throw new Error(`${b.label} gave no answer`);
  return text.trim();
}

// A short-lived agent process (`name`, the default one if null), for listing or reading sessions.
export async function withAgent(name, fn) {
  const agent = await startAgent(null, [], copilotCwd(), { agent: name });
  const timer = setTimeout(() => agent.close(), 30_000);
  try { return await fn(agent); } finally { clearTimeout(timer); agent.close(); }
}

// ---------------------------------------------------------------- a turn

function toolDetail(call = {}) {
  const input = call.rawInput;
  if (!input || typeof input !== 'object') return '';
  const text = input.command || input.path || input.url || JSON.stringify(input);
  return String(text).slice(0, 400);
}

// Files a chat creates or edits, for its Outputs: the paths only, when the step went through.
function noteFiles(c, u) {
  if (u.sessionUpdate === 'tool_call' && ['edit', 'delete', 'move'].includes(u.kind)) {
    const paths = [...(u.locations || []).map((l) => l?.path), u.rawInput?.path, u.rawInput?.file_path].filter((x) => typeof x === 'string' && x.startsWith('/'));
    if (paths.length) (c.fileCalls ||= new Map()).set(u.toolCallId, { paths: [...new Set(paths)], kind: u.kind });
    return;
  }
  const f = c.fileCalls?.get(u.toolCallId);
  if (!f || u.sessionUpdate !== 'tool_call_update') return;
  if (Array.isArray(u.locations)) for (const l of u.locations) if (typeof l?.path === 'string' && l.path.startsWith('/') && !f.paths.includes(l.path)) f.paths.push(l.path);
  if (!['completed', 'failed'].includes(u.status)) return;
  c.fileCalls.delete(u.toolCallId);
  if (u.status !== 'completed') return;
  if (f.kind !== 'delete') for (const path of f.paths) (c.turnFiles ||= new Set()).add(path);
  for (const path of f.paths.slice(0, 20)) logWrite(agentFilesFile, { where: 'file', what: path, kind: f.kind === 'delete' ? 'deleted' : 'wrote', chats: [chatRef(c)], decided: 'done' });
}

// Builds and test runs in a chat, for its map (lib/map.mjs): the command, how it ended and how
// long it took, logged like the agent's writes. Nothing else about the step is kept.
function noteBuild(c, u) {
  const cmd = u.rawInput?.command;
  if (u.sessionUpdate === 'tool_call' && u.kind === 'execute' && typeof cmd === 'string') {
    const kind = buildKind(cmd);
    if (kind) (c.builds ||= new Map()).set(u.toolCallId, { cmd: redact(cmd.replace(/\s+/g, ' ').trim().slice(0, 200)).text, kind, at: Date.now() });
    return;
  }
  const b = c.builds?.get(u.toolCallId);
  if (!b || u.sessionUpdate !== 'tool_call_update' || !['completed', 'failed'].includes(u.status)) return;
  c.builds.delete(u.toolCallId);
  logWrite(agentLogFile, { where: 'build', what: b.cmd, kind: b.kind, target: c.cwd.replace(homedir(), '~'), repo: [...(gitRepos(c.cwd) || [])][0] || null,
    chats: [chatRef(c)], decided: u.status === 'completed' ? 'passed' : 'failed', ms: Date.now() - b.at });
}

const startingChats = new Map(); // chat → while its Copilot starts
export async function acpTurn({ chat, options, prompt, resumeId, cwd, emit, res, bin, scope = [], auto = false, agent: agentPick = null, images = [] }) {
  // One turn at a time in a chat: a message that comes while Clearsky's own turn runs (a job's
  // result, a nudge), or while the chat's Copilot starts, waits for it.
  for (;;) {
    const b = acpChats.get(chat);
    if (b?.busy) { await b.turnDone; continue; }
    if (startingChats.has(chat)) { await startingChats.get(chat); continue; }
    break;
  }
  // Changing the folders in Settings starts the chat's Copilot again (resuming it) on its next turn.
  // Changing a chat's own folders (its side panel) does the same.
  const extra = chatFolders(chat);
  const dirs = [...copilotFolders(), ...extra, copilotTmp(), memory.memoryDir()].map((f) => untilde(f)).filter(isDir);
  // The chat's agent: the one it runs in already, else your pick for a new chat, else the rules.
  const name = acpChats.get(chat)?.agentName || (resumeId && sessionAgent(resumeId)) || (AGENTS[agentPick] ? agentPick : null)
    || chatAgent(chat, { cwd, repos: scope.filter((x) => x.repo).map((x) => x.repo) });
  const b = backend(name);
  const args = b.args({ ...options, folders: dirs });
  // Sandboxed mode always runs in srt; the others when Settings → Agent → Sandbox says so.
  const sandbox = !!copilot.PERMISSIONS[options.permission]?.sandbox || process.env.AGENT_SANDBOX === 'srt';
  const sig = JSON.stringify([b.name, args, dirs, options.permission, options.model, sandbox, process.env.AGENT_DOMAINS, process.env.AGENT_FOLDERS]);
  let c = acpChats.get(chat);
  // A new Copilot for the same chat keeps its VM, and the repos and Jira projects it works on.
  let keep = {};
  if (c && (c.sig !== sig || c.agent.closed)) { resumeId = c.agent.sessionId; keep = { vm: c.vm, repos: c.repos, jira: c.jira, tickets: c.tickets }; c.agent.close(); acpChats.delete(chat); c = null; }
  let started = null;
  if (!c) startingChats.set(chat, new Promise((d) => { started = d; }));
  try { if (!c) {
    const agent = await startAgent(b.name === backend().name ? bin : null, args, cwd, { sandbox, folders: extra, permission: options.permission, model: options.model, dirs, agent: b.name });
    c = { agent, agentName: b.name, sig, cwd, vm: keep.vm || null, repos: keep.repos || new Set(), jira: keep.jira || new Set(), tickets: keep.tickets || new Set(), waiting: new Map(), pending: new Map(), approved: new Set(), running: new Set(), steps: new Map(), shared: new Set(), emit: () => {}, lastUsed: Date.now() };
    bindVm(c);
    const id = await agent.start(cwd, resumeId);
    c.id = id;
    // Its repos are the ones its folder has now, before its first turn; a chat seen before keeps its list.
    c.scope = chatScope.scopeOf(scopesFile, id) || chatScope.saveScope(scopesFile, id, await chatScope.scopeSnapshot(cwd, gitReposLater));
    for (const r of c.scope['+'] || []) c.repos.add(r);
    acpChats.set(id, c);
    localState.setSessionAgent(stateFile, id, b.name);
    // A new chat gets Copilot's own session id; the panel keeps using that from now on.
    if (id !== chat) emit({ type: 'session', id });
    emit({ type: 'agent', name: b.name });
  } } finally { if (started) { startingChats.delete(chat); started(); } }
  c.lastUsed = Date.now();
  c.mode = options.permission;
  c.model = options.model || null;
  c.options = options; // for Clearsky's own turns in this chat (a job's result, a nudge)
  // What this chat is about (the items it was started with, the tickets you named): its writes
  // to those go through without asking.
  for (const x of scope) {
    if (x.kind === 'issue') { c.jira.add(x.key.split('-')[0]); c.tickets.add(x.key); }
    else if (x.repo) c.repos.add(x.repo.toLowerCase());
  }
  const { agent } = c;
  // Events go to whichever page is watching this chat; none while you look at another one.
  c.emit = emit;
  if (agent.commands) { copilotCommands = agent.commands; emit({ type: 'commands', commands: agent.commands }); }
  agent.onUpdate = (u) => {
    if (u.sessionUpdate === 'available_commands_update') { copilotCommands = agent.commands; c.emit({ type: 'commands', commands: agent.commands }); return; }
    // A step you allowed has finished: its GitHub changes ask again (see githubAsk).
    if (u.sessionUpdate === 'tool_call_update' && ['completed', 'failed'].includes(u.status)) { c.approved.delete(u.toolCallId); c.running.delete(u.toolCallId); c.steps.delete(u.toolCallId); }
    else if (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') {
      c.running.add(u.toolCallId);
      // What the step is, for the host door's card (lib/host-door.mjs, stepLines).
      const was = c.steps.get(u.toolCallId) || {};
      c.steps.set(u.toolCallId, { title: u.title ?? was.title, kind: u.kind ?? was.kind, input: u.rawInput ?? was.input });
    }
    noteBuild(c, u);
    noteFiles(c, u);
    // For the watchdog: when it last did anything, and what it said after its last step.
    c.lastEvent = Date.now();
    if (u.sessionUpdate === 'tool_call') c.turnText = '';
    else if (u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text') c.turnText += u.content.text;
    const e = chatEvent(u);
    if (e?.type === 'plan') c.plan = e.entries;
    // A /compact turn's own words wait for its end: "Nothing to compact" isn't shown as said.
    if (e?.type === 'text' && c.heldText) { c.heldText.push(e.text); return; }
    if (e && (e.type !== 'text' || e.text)) c.emit(e);
  };
  const autoAllow = copilot.PERMISSIONS[options.permission]?.autoAllow || [];
  agent.onPermission = (p) => new Promise((done) => {
    // One log line per question, without its content: the mode, the kind of step, the input's
    // field names and how it was answered, to see why something did or didn't ask.
    const resolve = (answer) => {
      console.log(`clearsky: permission mode=${options.permission || 'ask'} kind=${p.toolCall?.kind || '?'} input=${Object.keys(p.toolCall?.rawInput || {}).join('+') || '-'} -> ${answer.rule || 'you'}`);
      done(answer.rule ? { outcome: answer.outcome, optionId: answer.optionId } : answer);
    };
    const once = (p.options || []).find((o) => o.kind === 'allow_once');
    if (once && (autoAllow.includes('*') || autoAllow.includes(p.toolCall?.kind))) return resolve({ outcome: 'selected', optionId: once.optionId, rule: 'mode' });
    // Sandboxed: srt is the fence, so every step inside it runs. What leaves it (a push, a GitHub
    // or Jira change, `outside`) goes through Clearsky's doors, which ask you (lib/broker.mjs).
    if (once && options.permission === 'sandboxed' && c.agent.sandboxed) return resolve({ outcome: 'selected', optionId: once.optionId, rule: 'sandboxed' });
    const id = randomBytes(6).toString('hex');
    const ev = { type: 'permission', id, title: p.toolCall?.title || 'Copilot wants to use a tool', kind: p.toolCall?.kind,
      detail: toolDetail(p.toolCall), options: (p.options || []).map((o) => ({ id: o.optionId, name: o.name, kind: o.kind })) };
    c.waiting.set(id, (answer) => {
      c.pending.delete(id);
      const opt = (p.options || []).find((o) => o.optionId === answer.optionId);
      if (/^allow/.test(opt?.kind || '') && p.toolCall?.toolCallId) c.approved.add(p.toolCall.toolCallId);
      resolve(answer);
    });
    c.pending.set(id, ev);
    c.emit(ev);
  });
  // Switching chats or reloading the page leaves the turn running; Stop ends it.
  res.on('close', () => { if (c.emit === emit) c.emit = () => {}; });
  c.busy = true;
  c.turnFiles = new Set(); // files this turn changed, for your hooks
  if (!auto) c.hookTries = 0; // a message of yours: the check may ask for fixes again
  c.plan = null; // a turn's plan is its own; one from an earlier turn isn't shown as this one's
  let turnOver;
  c.turnDone = new Promise((d) => { turnOver = d; });
  Object.assign(c, { turnText: '', lastEvent: Date.now(), userStopped: false, stuck: false, auto });
  watchdog.cancel(c.id);
  // /compact: Copilot's answer to it isn't a reliable end (sometimes it never comes), so the
  // compaction's own record in the session's log ends the turn.
  const compact = /^\s*\/compact\b/.test(prompt) ? watchCompaction(c, chat) : null;
  // Rewind: the folder as it was before each of your messages (not Clearsky's own turns), and
  // after a rewind, the agent hears of it with your next message.
  if (!compact && !auto) {
    await checkpoints.snapshot(c.id, c.cwd || cwd, typedPart(prompt)).catch((e) => console.log(`clearsky: checkpoint: ${e.message.split('\n')[0]}`));
    const note = checkpoints.takeNote(c.id);
    if (note) prompt = `${note}${MSG_MARK}${prompt}`;
  }
  c.heldText = compact ? [] : null;
  let r = null, error = null;
  try { r = await (compact ? Promise.race([agent.prompt(prompt), compact]) : agent.prompt(prompt, images)); } catch (e) { error = e; }
  finally {
    compact?.turnOver();
    // Copilot's "Failed to run /compact: Error: Nothing to compact." (as an error or as its
    // answer) isn't a failure: the chat is already as short as it gets. A quiet note instead.
    if (compact) {
      const said = c.heldText.join('');
      c.heldText = null;
      if (NOTHING_TO_COMPACT.test(error?.message || '') || NOTHING_TO_COMPACT.test(said)) {
        error = null;
        compact.stop();
        c.emit({ type: 'note', text: 'Nothing to compact: this chat is already as short as Copilot can make it.' });
      } else if (said) c.emit({ type: 'text', text: said });
    }
    c.approved.clear(); c.running.clear(); c.steps.clear(); closeCards(c); hostDoor.turnEnded(c.id);
  }
  // Your hooks (lib/hooks.mjs), still as part of the turn so the page shows them: after a turn
  // that changed files; a failed check sends the chat its output (afterTurn sees that waiting).
  const isCommand = /^\s*\//.test(typedPart(prompt));
  const hooks = !isCommand && !error && r?.stopReason === 'end_turn' && c.turnFiles?.size ? hooksConfig() : null;
  if (hooks) {
    c.hooking = true; // the turn stays busy (your next message waits) and the watchdog leaves it be
    await endHooks(c, hooks, [...c.turnFiles]).catch((e) => c.emit({ type: 'note', text: `Hooks: ${e.message}` }));
    c.hooking = false;
  }
  c.busy = false; turnOver();
  // A host allowed in this turn that no command of it told about: the chat hears it now.
  const untold = doorNotes.get(c.id);
  doorNotes.delete(c.id);
  if (untold?.size) tellChat(c.id, [...untold.values()].join('\n'));
  afterTurn(c, { stopReason: r?.stopReason, error, command: isCommand });
  if (error) throw error;
  c.emit({ type: 'done', stopReason: r?.stopReason });
  c.emit = () => {};
}

// Waits for Copilot's session.compaction_complete (after this point in its log) and says how much it
// removed. If Copilot is still "answering" the /compact turn then, that turn is ended: the
// compaction is done. Gives up after three minutes. `turnOver()` says the turn ended by itself.
const NOTHING_TO_COMPACT = /nothing to compact/i;
function watchCompaction(c, id) {
  const file = join(copilotHome(), 'session-state', c.agent.sessionId || id, 'events.jsonl');
  let from = 0, over = false;
  try { from = statSync(file).size; } catch {}
  const k = (n) => `${Math.round((n || 0) / 1000)}k`;
  const started = Date.now();
  let timer;
  const p = new Promise((done) => {
    timer = setInterval(() => {
      let text = '';
      try { const buf = readFileSync(file); text = buf.subarray(Math.min(from, buf.length)).toString('utf8'); } catch {}
      const line = text.split('\n').find((l) => l.includes('"session.compaction_complete"'));
      if (!line && Date.now() - started < 180_000) return;
      clearInterval(timer);
      let d = {};
      try { d = JSON.parse(line).data || {}; } catch {}
      // After a turn that ended by itself, the note goes to the chat's next turn or nowhere.
      c.emit({ type: 'note', text: !line ? 'Compact: no word from Copilot after 3 minutes'
        : NOTHING_TO_COMPACT.test(d.error || '') ? 'Nothing to compact: this chat is already as short as Copilot can make it.'
        : d.success === false ? `Compact didn't work${d.error ? `: ${d.error}` : ''}`
        : `Compacted: ${k(d.preCompactionTokens)} → ${k(d.postCompactionTokens)} tokens` });
      if (over) return;
      setTimeout(() => { if (!over) { c.agent.cancel(); done({ stopReason: 'end_turn' }); } }, 2000);
    }, 1000);
  });
  p.turnOver = () => { over = true; };
  p.stop = () => { over = true; clearInterval(timer); };
  return p;
}

// Watch a chat that is still running (after switching back to it): its open questions, then
// what it does from now on, until the turn ends.
export function attachCopilot(chat, req, res) {
  const c = acpChats.get(chat);
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  const send = (e) => { e.at ??= Date.now(); if (!res.writableEnded && !res.destroyed) res.write(`${JSON.stringify(e)}\n`); };
  if (!c?.busy) { send({ type: 'done' }); return res.end(); }
  if (c.plan?.length) send({ type: 'plan', entries: c.plan });
  for (const ev of c.pending.values()) send(ev);
  const emit = (e) => { send(e); if (e.type === 'done') res.end(); };
  c.emit = emit;
  res.on('close', () => { if (c.emit === emit) c.emit = () => {}; });
}
