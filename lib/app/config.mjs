// Your settings, as Clearsky runs with them: the files it keeps, the config built from the
// environment, which tracker and agent are in use, the plugins you added, and the hours of your day.
// Loaded once, first: the settings files are read here.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import * as settings from '../settings.mjs';
import { vpnWatch, checkTarget } from '../vpn.mjs';
import { loadSources, makeContext, hook, asList } from '../sources.mjs';
import { loadPlugins, migrateBundled, pluginPaths, retiredText } from '../plugins.mjs';
import { sandboxedSource } from '../plugin-sandbox.mjs';
import { trackerName } from '../tracker.mjs';
import { agentName, AGENTS, AGENT_NAMES } from '../agents.mjs';

// ---------------------------------------------------------------- files and settings

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let value = m[2];
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

// Clearsky's own folder: the page, the scripts and the bundled skills are read from it.
export const appDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const userEnvFile = join(homedir(), '.config', 'clearsky', '.env');
export const stateFile = process.env.CLEARSKY_STATE || join(homedir(), '.config', 'clearsky', 'state.json');
export const agentLogFile = join(dirname(stateFile), 'agent-writes.jsonl');
export const scopesFile = join(dirname(stateFile), 'chat-scopes.json'); // each chat's repos, as they were when it started (lib/chat-scope.mjs)
// Files a chat wrote or you attached to it, for its Outputs (see chatOutputs).
export const agentFilesFile = join(dirname(stateFile), 'agent-files.jsonl');

// The VPN (lib/vpn.mjs): noticed, never managed. Modules listed in VPN_NEEDED_BY pause while
// it's off, and plugins' doors (Grafana) say so. Checked against VPN_CHECK, else the first address
// a plugin names (its vpnTargets() hook, such as your first Grafana).
const pluginVpnTargets = () => [...(globalThis.clearskyPlugins?.sources.values() || [])].flatMap((p) => asList(hook(p, 'vpnTargets', makeContext(p).env)).filter((u) => typeof u === 'string'));
export const vpn = vpnWatch({ target: () => checkTarget(process.env, pluginVpnTargets()) });
export const needsVpn = (name) => String(process.env.VPN_NEEDED_BY || '').split(/[\s,]+/).includes(name);
loadEnvFile(join(process.cwd(), '.env'));
loadEnvFile(join(appDir, '.env'));
loadEnvFile(userEnvFile);

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

// "Mon-Fri", "Sun-Thu" or "Mon,Tue,Thu" -> set of JS weekday numbers.
export function parseWorkdays(spec) {
  const days = new Set();
  for (const part of spec.toLowerCase().split(',').map((p) => p.trim()).filter(Boolean)) {
    const [a, b] = part.split('-').map((x) => DAY_NAMES.indexOf(x.slice(0, 3)));
    if (a < 0 || (b !== undefined && b < 0)) throw new Error(`bad workday "${part}"`);
    if (b === undefined) { days.add(a); continue; }
    for (let d = a; ; d = (d + 1) % 7) { days.add(d); if (d === b) break; }
  }
  return days;
}

export const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);

// Built from the environment; rebuilt when settings are saved from the page.
const buildConfig = (env = process.env) => ({
  days: Number(env.CLEARSKY_MENTION_DAYS || 14),
  cacheSeconds: Number(env.CLEARSKY_CACHE_SECONDS || 120),
  port: Number(env.CLEARSKY_PORT || 7777),
  // Where it listens: this machine only. A container sets 0.0.0.0 and publishes the port to
  // the host's 127.0.0.1 (see Dockerfile).
  bind: env.CLEARSKY_BIND || '127.0.0.1',
  github: {
    token: env.GITHUB_TOKEN,
    api: (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, ''),
    orgs: list(env.GITHUB_ORGS),
    ignoreAuthors: list(env.CLEARSKY_IGNORE_AUTHORS),
    myPrsEverywhere: env.GITHUB_MY_PRS === 'all',
  },
  jira: {
    acli: env.ACLI_BIN || 'acli',
    url: (env.JIRA_URL || '').replace(/\/$/, ''), // optional: base for browse links
    accountId: env.JIRA_ACCOUNT_ID, // optional: skips the lookup of your account id
    assignedJql: env.JIRA_ASSIGNED_JQL ||
      'assignee = currentUser() AND statusCategory != Done ORDER BY priority DESC, updated DESC',
    mentionsJql: env.JIRA_MENTIONS_JQL,
  },
  calendar: {
    icsUrl: env.CALENDAR_ICS_URL || env.GOOGLE_CALENDAR_ICS, // optional; Google Calendar "secret address in iCal format"
    email: env.CALENDAR_EMAIL, // used to drop events you declined, and to find your Evolution calendar
    evolution: env.EVOLUTION_CALENDARS, // optional; Evolution calendar names or uids to read
  },
  workdayEnd: env.CLEARSKY_WORKDAY_END || '17:00',
  standupTime: env.CLEARSKY_STANDUP_TIME || '09:45', // daily stand-up (local time)
  workdays: parseWorkdays(env.CLEARSKY_WORKDAYS || 'Mon-Fri'),
});
export const config = buildConfig();
// Where your tickets live (lib/tracker.mjs): 'jira', 'github' or 'none'. Worked out again when
// settings are saved.
let trackerMemo = null;
export const tracker = () => (trackerMemo ||= trackerName(process.env));
// The coding agent behind chats: Copilot or Claude Code (lib/agents.mjs). `backend()` is the
// default one; `backend(name)` a chat's own (Settings → Agent → Use … for).
let agentMemo = null;
export const backend = (name) => AGENTS[name] || AGENTS[agentMemo ||= agentName(process.env)];
// The agents installed here (the default one even when it isn't, so its error shows).
export const installedAgents = () => AGENT_NAMES.filter((n) => n === backend().name || AGENTS[n].find());
// Settings were saved: the config, the tracker and the default agent are worked out again.
// Says whether the default agent is another one now.
export function reloadConfig() {
  Object.assign(config, buildConfig());
  trackerMemo = null;
  const other = !!agentMemo && agentMemo !== agentName(process.env);
  if (other) agentMemo = null;
  return other;
}

// ---------------------------------------------------------------- plugins

// Extra sources: the plugins you added (lib/plugins.mjs; `clearsky add`, or Settings → Plugins),
// and your own single-file ones in ~/.config/clearsky/sources/*.mjs.
export const pluginDirs = pluginPaths();
const migrated = migrateBundled(process.env, { paths: pluginDirs });
if (migrated.length) console.error(`clearsky: ${migrated.join(', ')} ${migrated.length === 1 ? 'is a plugin' : 'are plugins'} now, and added for you since ${migrated.length === 1 ? 'it was' : 'they were'} set up`);
export const plugins = await loadSources([process.env.CLEARSKY_SOURCES_DIR || join(homedir(), '.config', 'clearsky', 'sources')]);
{
  const added = await loadPlugins({ paths: pluginDirs, makeSandboxed: sandboxedSource({ root: pluginDirs.root, standupSince: () => previousStandup() }) });
  for (const [n, p] of added.sources) {
    if (plugins.sources.has(n)) plugins.errors.push(`plugin ${n}: a source called "${n}" is already loaded from ~/.config/clearsky/sources`);
    else plugins.sources.set(n, p);
  }
  plugins.errors.push(...added.errors);
  // A retired plugin still loads if you have its code, but says what to use instead.
  for (const n of added.sources.keys()) { const t = retiredText(n); if (t) plugins.errors.push(t); }
}
for (const e of plugins.errors) console.error(`clearsky: ${e}`);
globalThis.clearskyPlugins = plugins;
for (const p of plugins.sources.values()) settings.addFields(p.settings, p.label, p.name);

// ---------------------------------------------------------------- your day: the clock, workdays and the stand-up

// Clock times in 24-hour format unless CLEARSKY_TIME_FORMAT=12.
export const clock = (d) => new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: process.env.CLEARSKY_TIME_FORMAT === '12' ? 'h12' : 'h23' });

export function atLocalTime(base, hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date(base); d.setHours(h, m || 0, 0, 0);
  return d.getTime();
}

export const isWorkday = (d) => config.workdays.has(d.getDay());
export const sameDay = (a, b) => a.toDateString() === b.toDateString();

export function standupOn(day) {
  const [h, m] = config.standupTime.split(':').map(Number);
  const d = new Date(day); d.setHours(h, m || 0, 0, 0);
  return d;
}

// The next stand-up: today's if it hasn't started more than 15 minutes ago, else the next workday's.
export function nextStandup(now = new Date()) {
  let d = standupOn(now);
  if (!config.workdays.size) return d;
  while (!isWorkday(d) || +d + 15 * 6e4 <= +now) { d.setDate(d.getDate() + 1); d = standupOn(d); }
  return d;
}

// The stand-up before the next one; the summary covers everything since then.
export function previousStandup(now = new Date()) {
  const d = nextStandup(now);
  do d.setDate(d.getDate() - 1); while (!isWorkday(d));
  return standupOn(d);
}
