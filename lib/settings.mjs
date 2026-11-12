
// Settings for the local Settings page: reads and writes ~/.config/clearsky/.env,
// reports which integrations are connected, and starts the CLI logins (gh, acli).
// Secret values are never sent back to the page.

import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { edsCalendars, pickCalendars, ownCalendars } from './eds.mjs';
import { DEFAULT_DOMAINS, READ_DEFAULT, parseDomains, checkDomains } from './sandbox.mjs';
import { VM_DEFAULT } from './vm.mjs';
import { loginEnv, acliLoginHint } from './wsl.mjs';
const vmDefaults = () => ({ cpus: VM_DEFAULT.cpus, memGb: VM_DEFAULT.memMb / 1024 });

const execFileP = promisify(execFile);

// Keys the page may set, and whether their value is secret.
export const FIELDS = {
  GITHUB_ORGS: { secret: false },
  GITHUB_MY_PRS: { secret: false }, // 'all': your PRs in any repo, not only the work organizations
  GITHUB_TOKEN: { secret: true },
  GOOGLE_CALENDAR_ICS: { secret: true },
  CALENDAR_EMAIL: { secret: false },
  EVOLUTION_CALENDARS: { secret: false }, // extra calendars to include, by uid
  CALENDAR_MY_NAMES: { secret: false }, // names that make an event on a shared calendar yours
  CALENDAR_HIDDEN: { secret: false }, // calendar names whose events you hid from the agenda
  CLEARSKY_WORKDAY_END: { secret: false },
  CLEARSKY_STANDUP_TIME: { secret: false },
  CLEARSKY_WORKDAYS: { secret: false },
  CLEARSKY_MENTION_DAYS: { secret: false },
  CLEARSKY_TIME_FORMAT: { secret: false }, // 24 (default) or 12
  CLEARSKY_POLL_MINUTES: { secret: false }, // how often GitHub, Jira mentions and plugins' reminders are checked (default 3)
  TRACKER: { secret: false }, // where tickets live: jira, github or none (empty: Jira when it's set up, else GitHub Issues; lib/tracker.mjs)
  JIRA_STARRED_PROJECTS: { secret: false }, // Jira project keys on the Versions page, comma-separated
  GITHUB_STARRED_REPOS: { secret: false }, // repos whose milestones are on the Versions page with GitHub Issues, comma-separated
  GITHUB_BUILD_REPOS: { secret: false }, // repos on the Builds page (empty: the ones your PRs and reviews are in)
  COPILOT_FOLDERS: { secret: false }, // folders Copilot chats may read and write without asking, comma-separated
  CLEARSKY_AGENT: { secret: false }, // the coding agent for chats: copilot or claude (empty: Copilot when it's installed, else Claude Code; lib/agents.mjs)
  AGENT_COPILOT_FOR: { secret: false }, // folders, owners or repos whose chats run in Copilot whatever the default (lib/agents.mjs)
  AGENT_CLAUDE_FOR: { secret: false }, // the same for Claude Code
  COPILOT_MODEL: { secret: false }, // defaults for a new Copilot chat; the chat's own pickers override them
  COPILOT_DISCLOSE: { secret: false }, // on: chats end PR descriptions with the model and credits used
  COPILOT_REVIEW_MODEL: { secret: false }, // the model for `review` (empty: COPILOT_MODEL)
  COPILOT_EFFORT: { secret: false },
  COPILOT_PERMISSION: { secret: false },
  COPILOT_CWD: { secret: false }, // where a chat that isn't about a PR or ticket runs
  COPILOT_ASSISTED_ALLOW: { secret: false }, // commands the sandbox's doors run without asking (lib/broker.mjs), comma-separated
  COPILOT_SANDBOX_TOKEN: { secret: true }, // optional GitHub token for the sandbox instead of your gh login
  COPILOT_SANDBOX: { secret: false }, // off (default) or srt: run Copilot inside Anthropic's sandbox runtime
  COPILOT_READ: { secret: false }, // more of your home a sandboxed Copilot may read, comma-separated (on top of READ_DEFAULT)
  COPILOT_DOMAINS: { secret: false }, // hosts a sandboxed Copilot may reach, comma-separated (empty: GitHub, Copilot, Jira)
  COPILOT_READ_HOSTS: { secret: false }, // more hosts it may read, from a chat's "Always allow" (lib/host-door.mjs), comma-separated
  COPILOT_VM_IMAGES: { secret: false }, // images (name prefixes) the VM gets from your Docker instead of pulling, comma-separated
  VPN_CHECK: { secret: false }, // a host only reachable on the VPN (empty: the first a plugin names, such as a Grafana)
  VPN_NEEDED_BY: { secret: false }, // modules that pause while the VPN is off, comma-separated
  COPILOT_GATE_RULES: { secret: false }, // kinds of change let through without asking, from a card's "always" (lib/advice.mjs RULES)
  COPILOT_VM_CPUS: { secret: false }, // cores for each chat's VM (empty: half of this machine's, up to 12)
  COPILOT_VM_MEMORY_GB: { secret: false }, // memory for each chat's VM in GB (empty: a quarter of this machine's, 4 to 16)
  COPILOT_CREDIT_USD: { secret: false }, // dollars per AI credit (empty: 0.01), for the Usage page
  CLEARSKY_CURRENCY: { secret: false }, // your currency (ISO code like NOK) for costs; empty: dollars only
  CLEARSKY_FX_RATE: { secret: false }, // how much one dollar is in CLEARSKY_CURRENCY
  CLEARSKY_FX_LIVE: { secret: false }, // on: look the rate up once a day (no token), else use CLEARSKY_FX_RATE
  COPILOT_BUILDS: { secret: false }, // where sandboxed chats run builds and tests: empty (the chat's VM when there is one) or sandbox
  COPILOT_VM_MAX: { secret: false }, // how many chats' VMs run at once, 1 to 8 (empty: 1); others wait in line (lib/vm-queue.mjs)
  // The watchdog (lib/watchdog.mjs): nudges for a chat that stops before its task is done.
  COPILOT_NUDGES: { secret: false }, // at most this many per task, 0 to 10 (empty: 3; 0 is off)
  COPILOT_NUDGE_MINUTES: { secret: false }, // quiet this long after the turn first, 1 to 60 (empty: 2)
  COPILOT_STUCK_MINUTES: { secret: false }, // a turn with no word and nothing running this long is stuck, 5 to 120 (empty: 15)
};

// Settings that extra sources declare (see lib/sources.mjs). Never overrides a built-in one.
// `pattern` (with `patternHint`) checks a value when it's saved; `link` is a { label, url } to set it up.
// `team: true` lets a team pack set it (lib/team.mjs); a secret never is.
export function addFields(fields = {}, source = null, plugin = null) {
  for (const [k, f] of Object.entries(fields)) {
    if (FIELDS[k]) continue;
    let pattern = null;
    try { pattern = f.pattern ? new RegExp(f.pattern) : null; } catch { /* a bad pattern checks nothing */ }
    const link = f.link && /^https:\/\//.test(f.link.url || '') ? { label: String(f.link.label || 'Set it up'), url: f.link.url } : null;
    FIELDS[k] = { secret: !!f.secret, label: f.label || k, hint: f.hint || '', extra: true, source, plugin, pattern, team: !!f.team && !f.secret, patternHint: f.patternHint || '', link,
      type: ['list', 'map'].includes(f.type) ? f.type : 'text', item: String(f.item || ''), valueItem: String(f.valueItem || ''), empty: String(f.empty || '') };
  }
}

export function readEnvFile(path) {
  const out = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

// Replace or append KEY=value lines, keeping comments and other lines. An empty value removes the key.
export function writeEnvFile(path, updates) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lines = existsSync(path) ? readFileSync(path, 'utf8').split(/\r?\n/) : [];
  const pending = new Map(Object.entries(updates));
  const out = [];
  for (const line of lines) {
    const key = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1];
    if (key && pending.has(key)) {
      const v = pending.get(key);
      pending.delete(key);
      if (v) out.push(`${key}=${v}`);
    } else {
      out.push(line);
    }
  }
  while (out.length && out.at(-1) === '') out.pop();
  for (const [k, v] of pending) if (v) out.push(`${k}=${v}`);
  writeFileSync(path, out.join('\n') + '\n', { mode: 0o600 });
  chmodSync(path, 0o600);
}

// Only allow values that cannot break the .env format.
export function validate(updates) {
  const clean = {};
  for (const [k, raw] of Object.entries(updates || {})) {
    if (!FIELDS[k]) throw new Error(`unknown setting ${k}`);
    let v = String(raw ?? '').trim();
    if (k === 'COPILOT_ASSISTED_ALLOW') v = v.replace(/\s*[\r\n]+\s*/g, ', ');
    if (k === 'COPILOT_GATE_RULES') {
      v = v.split(/[\s,]+/).filter(Boolean).join(', ');
      const bad = v.split(', ').filter((r) => r && !/^(merge-ready|delete-merged-branch|repo:[\w.-]+\/[\w.-]+|jira:[A-Z][A-Z0-9_]+)$/.test(r));
      if (bad.length) throw new Error(`not a rule: ${bad.join(', ')} (use merge-ready, delete-merged-branch, repo:owner/name or jira:KEY)`);
    }
    if (k === 'JIRA_STARRED_PROJECTS') {
      const keys = v.toUpperCase().split(/[\s,]+/).filter(Boolean);
      const bad = keys.filter((x) => !/^[A-Z][A-Z0-9_]{0,49}$/.test(x));
      if (bad.length) throw new Error(`not a Jira project key: ${bad.join(', ')} (use keys like ABC)`);
      v = [...new Set(keys)].join(', ');
    }
    if (k === 'TRACKER' && v && !['jira', 'github', 'none'].includes(v.toLowerCase())) throw new Error('Tickets live in: jira, github or none');
    if (k === 'TRACKER') v = v.toLowerCase();
    if (k === 'CLEARSKY_AGENT' && v && !['copilot', 'claude'].includes(v.toLowerCase())) throw new Error('The agent is copilot or claude');
    if (k === 'CLEARSKY_AGENT') v = v.toLowerCase();
    if ((k === 'AGENT_COPILOT_FOR' || k === 'AGENT_CLAUDE_FOR') && v) {
      const items = [...new Set(v.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean))];
      const bad = items.find((x) => !/^[~/]/.test(x) && !/^[\w.-]+(\/[\w.-]+)?$/.test(x));
      if (bad) throw new Error(`"${bad}" is not a folder (~/… or /…), an owner or owner/name`);
      v = items.join(', ');
    }
    if (k === 'GITHUB_STARRED_REPOS') {
      const repos = v.split(/[\s,]+/).filter(Boolean);
      const bad = repos.filter((x) => !/^[\w-][\w.-]*\/[\w-][\w.-]*$/.test(x));
      if (bad.length) throw new Error(`not a repo: ${bad.join(', ')} (use owner/name)`);
      v = [...new Set(repos)].join(', ');
    }
    if (k === 'COPILOT_BUILDS' && v && !['vm', 'sandbox'].includes(v)) throw new Error('Run builds in: vm or sandbox');
    if (k === 'COPILOT_VM_MAX' && v && !(/^\d+$/.test(v) && +v >= 1 && +v <= 8)) throw new Error('VMs at the same time: a number from 1 to 8');
    if (k === 'COPILOT_NUDGES' && v && !(/^\d+$/.test(v) && +v <= 10)) throw new Error('Nudges: a number from 0 to 10');
    if (k === 'COPILOT_NUDGE_MINUTES' && v && !(/^\d+$/.test(v) && +v >= 1 && +v <= 60)) throw new Error('Nudge after: minutes from 1 to 60');
    if (k === 'COPILOT_STUCK_MINUTES' && v && !(/^\d+$/.test(v) && +v >= 5 && +v <= 120)) throw new Error('Stuck after: minutes from 5 to 120');
    if ((k === 'COPILOT_CREDIT_USD' || k === 'CLEARSKY_FX_RATE') && v) {
      v = v.replace(',', '.');
      if (!(/^\d*\.?\d+$/.test(v) && +v > 0)) throw new Error(`${k === 'COPILOT_CREDIT_USD' ? 'Dollars per credit' : 'Rate'}: a number above 0, like ${k === 'COPILOT_CREDIT_USD' ? '0.01' : '10.5'}`);
    }
    if (k === 'CLEARSKY_CURRENCY') { v = v.toUpperCase(); if (v && !/^[A-Z]{3}$/.test(v)) throw new Error('Currency: a three-letter code, like NOK, EUR or SEK'); }
    if (k === 'CLEARSKY_FX_LIVE' && v && v !== 'on') throw new Error('Live rate: on or empty');
    if (k === 'COPILOT_ASSISTED_ALLOW' && /[;&|<>`$]/.test(v)) throw new Error('list command starts only, like mvn deploy, docker compose');
    if (/[\r\n]/.test(v)) throw new Error(`${k} must be a single line`);
    // One or more calendar addresses, separated by spaces (say a work and a family calendar).
    for (const url of k === 'GOOGLE_CALENDAR_ICS' ? v.split(/\s+/).filter(Boolean) : []) {
      if (!/^https:\/\/\S+$/.test(url)) throw new Error('each calendar address must be an https:// URL');
      if (/calendar\.google\.com\/calendar\/ical\/[^/]+\/public\//.test(url)) {
        throw new Error('that is the public address; use "Secret address in iCal format" (…/private-…/basic.ics)');
      }
      if (/calendar\.google\.com/.test(url) && !/\/ical\/.*\.ics/.test(url)) {
        throw new Error('that is a browser link; use "Secret address in iCal format" (…/calendar/ical/…/private-…/basic.ics)');
      }
    }
    if (FIELDS[k]?.pattern && v && !FIELDS[k].pattern.test(v)) throw new Error(FIELDS[k].patternHint || `${FIELDS[k].label} doesn't look right`);
    if (k === 'COPILOT_FOLDERS' && v && !v.split(',').map((x) => x.trim()).filter(Boolean).every((x) => /^(~|\/)/.test(x) && !x.split('/').includes('..'))) {
      throw new Error('Copilot folders should be full paths like ~/dev/acme, separated by commas');
    }
    if (k === 'COPILOT_CWD' && v && (!/^(~|\/)/.test(v) || v.includes(','))) throw new Error('the Copilot folder should be one full path like ~/dev');
    if (k === 'COPILOT_SANDBOX' && v && !['off', 'srt'].includes(v)) throw new Error('should be off or srt');
    if ((k === 'COPILOT_DOMAINS' || k === 'COPILOT_READ_HOSTS') && v && !checkDomains(parseDomains(v))) throw new Error('list host names like github.com or *.atlassian.net, separated by commas');
    if (k === 'COPILOT_MODEL' && v && !/^[\w.:-]{1,80}$/.test(v)) throw new Error('that does not look like a model name');
    if (k === 'COPILOT_EFFORT' && v && !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(v)) throw new Error('unknown reasoning effort');
    if (k === 'COPILOT_PERMISSION' && v && !['ask', 'assisted', 'sandboxed', 'full', 'read', 'plan'].includes(v)) throw new Error('unknown access mode');
    if (k === 'GITHUB_MY_PRS' && v && v !== 'all') throw new Error('GITHUB_MY_PRS should be empty or all');
    if (k === 'CLEARSKY_POLL_MINUTES' && v && !(/^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 60)) throw new Error('check every 1 to 60 minutes');
    if (k === 'CLEARSKY_TIME_FORMAT' && v && !['12', '24'].includes(v)) throw new Error('time format should be 12 or 24');
    if (k === 'CLEARSKY_WORKDAY_END' && v && !/^\d{1,2}:\d{2}$/.test(v)) throw new Error('workday end should look like 17:00');
    if (k === 'CLEARSKY_WORKDAYS' && v && !/^[a-z]{3}(-[a-z]{3})?(\s*,\s*[a-z]{3}(-[a-z]{3})?)*$/i.test(v)) throw new Error('workdays should look like Mon-Fri');
    if (k === 'CLEARSKY_STANDUP_TIME' && v && !/^\d{1,2}:\d{2}$/.test(v)) throw new Error('stand-up time should look like 09:45');
    clean[k] = v;
  }
  return clean;
}

async function run(cmd, args) {
  try {
    const { stdout, stderr } = await execFileP(cmd, args, { timeout: 15_000 });
    return { ok: true, out: `${stdout}\n${stderr}`.trim() };
  } catch (e) {
    return { ok: false, missing: e.code === 'ENOENT', out: `${e.stdout || ''}\n${e.stderr || e.message}`.trim() };
  }
}

const mask = (v) => (v ? `set (…${v.slice(-4)})` : null);

export async function status(config, fileValues) {
  const [gh, acli] = await Promise.all([run('gh', ['auth', 'status']), run(config.jira.acli, ['jira', 'auth', 'status'])]);
  const ghUser = gh.out.match(/Logged in to \S+ (?:account|as) (\S+)/)?.[1] || null;
  const acliSite = acli.out.match(/[\w-]+\.atlassian\.net/)?.[0] || null;
  return {
    file: fileValues.path,
    github: {
      cli: gh.missing ? 'missing' : gh.ok ? 'logged-in' : 'logged-out',
      user: ghUser,
      token: mask(process.env.GITHUB_TOKEN),
      orgs: config.github.orgs.join(','),
      myPrs: config.github.myPrsEverywhere ? 'all' : '', buildRepos: process.env.GITHUB_BUILD_REPOS || '',
    },
    jira: {
      cli: acli.missing ? 'missing' : acli.ok && !/not (logged|authenticated)|no .*account/i.test(acli.out) ? 'logged-in' : 'logged-out',
      site: acliSite,
      starred: process.env.JIRA_STARRED_PROJECTS || '',
    },
    tracker: { set: process.env.TRACKER || '', starredRepos: process.env.GITHUB_STARRED_REPOS || '' },
    calendar: {
      url: mask(config.calendar.icsUrl),
      email: config.calendar.email || '',
      myNames: process.env.CALENDAR_MY_NAMES || '',
      // Calendars GNOME Online Accounts syncs for that address, used when there's no iCal link.
      evolution: (() => {
        try {
          return pickCalendars(edsCalendars(), { wanted: config.calendar.evolution, email: config.calendar.email })
            .map((c) => ({ name: c.name, synced: !!c.cacheDb }));
        } catch { return []; }
      })(),
      // Every calendar on this machine, to choose extra ones (family, personal) in Settings.
      all: (() => {
        try {
          const all = edsCalendars();
          const own = new Set(ownCalendars(all, config.calendar.email).map((c) => c.uid));
          const picked = new Set(pickCalendars(all, { wanted: config.calendar.evolution, email: config.calendar.email }).map((c) => c.uid));
          return all.map((c) => ({ uid: c.uid, name: c.name, account: c.account, synced: !!c.cacheDb, own: own.has(c.uid), picked: picked.has(c.uid) }));
        } catch { return []; }
      })(),
    },
    // Settings of extra sources: secrets masked, the rest as saved.
    extra: Object.entries(FIELDS).filter(([, f]) => f.extra).map(([key, f]) => ({
      key, label: f.label, hint: f.hint, secret: f.secret, source: f.source, plugin: f.plugin, link: f.link, type: f.type, item: f.item, valueItem: f.valueItem, empty: f.empty, value: f.secret ? mask(process.env[key]) : process.env[key] || '',
    })),
    workdayEnd: config.workdayEnd,
    standupTime: config.standupTime,
    workdays: process.env.CLEARSKY_WORKDAYS || 'Mon-Fri',
    mentionDays: config.days,
    timeFormat: process.env.CLEARSKY_TIME_FORMAT || '24',
    pollMinutes: process.env.CLEARSKY_POLL_MINUTES || '',
    vpn: { check: process.env.VPN_CHECK || '', neededBy: process.env.VPN_NEEDED_BY || '' },
    copilot: { agent: process.env.CLEARSKY_AGENT || '', copilotFor: process.env.AGENT_COPILOT_FOR || '', claudeFor: process.env.AGENT_CLAUDE_FOR || '', folders: process.env.COPILOT_FOLDERS || '', model: process.env.COPILOT_MODEL || '', effort: process.env.COPILOT_EFFORT || '',
      permission: process.env.COPILOT_PERMISSION || '', cwd: process.env.COPILOT_CWD || '', sandboxToken: mask(process.env.COPILOT_SANDBOX_TOKEN), assistedAllow: process.env.COPILOT_ASSISTED_ALLOW || '', disclose: process.env.COPILOT_DISCLOSE === 'on', sandbox: process.env.COPILOT_SANDBOX || 'off', domains: process.env.COPILOT_DOMAINS || '', readHosts: process.env.COPILOT_READ_HOSTS || '', read: process.env.COPILOT_READ || '', vmImages: process.env.COPILOT_VM_IMAGES || '', gateRules: process.env.COPILOT_GATE_RULES || '', vmCpus: process.env.COPILOT_VM_CPUS || '', vmMemoryGb: process.env.COPILOT_VM_MEMORY_GB || '', vmMax: process.env.COPILOT_VM_MAX || '', builds: process.env.COPILOT_BUILDS || '', nudges: process.env.COPILOT_NUDGES || '', nudgeMinutes: process.env.COPILOT_NUDGE_MINUTES || '', stuckMinutes: process.env.COPILOT_STUCK_MINUTES || '', creditUsd: process.env.COPILOT_CREDIT_USD || '', currency: process.env.CLEARSKY_CURRENCY || '', fxRate: process.env.CLEARSKY_FX_RATE || '', fxLive: process.env.CLEARSKY_FX_LIVE === 'on', vmDefault: vmDefaults(), readDefault: READ_DEFAULT.join(', '),
      defaultDomains: DEFAULT_DOMAINS.join(', '), unmounted: unmounted(process.env.COPILOT_FOLDERS) },
  };
}

// Start `gh auth login --web` and hand back its one-time code; gh then opens the browser.
export function githubLogin() {
  return new Promise((resolve, reject) => {
    const child = spawn('gh', ['auth', 'login', '--web', '--hostname', 'github.com', '--git-protocol', 'https'], {
      stdio: ['pipe', 'pipe', 'pipe'], env: loginEnv(),
    });
    let buf = '', done = false;
    const finish = (fn, v) => { if (!done) { done = true; clearTimeout(timer); fn(v); } };
    const timer = setTimeout(() => finish(reject, new Error('gh did not print a login code')), 20_000);
    const onData = (d) => {
      buf += d;
      const code = buf.match(/one-time code: ([A-Z0-9]{4}-[A-Z0-9]{4})/)?.[1];
      if (code) {
        child.stdin.write('\n'); // "Press Enter to open github.com in your browser"
        finish(resolve, { code, url: 'https://github.com/login/device' });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => finish(reject, e.code === 'ENOENT' ? new Error('gh is not installed') : e));
    child.on('exit', (c) => finish(reject, new Error(`gh exited (${c}): ${buf.trim().slice(-200)}`)));
  });
}

// `acli jira auth login --web` opens the Atlassian login in the browser by itself.
export function jiraLogin(acliBin) {
  return new Promise((resolve, reject) => {
    const child = spawn(acliBin, ['jira', 'auth', 'login', '--web'], { stdio: ['ignore', 'pipe', 'pipe'], env: loginEnv() });
    let buf = '';
    const collect = (d) => { buf += d; };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (e) => reject(e.code === 'ENOENT' ? new Error('acli is not installed') : e));
    // Give it a moment to fail fast (e.g. bad flags); otherwise the browser flow is running.
    setTimeout(() => resolve({ started: true, url: buf.match(/https:\/\/\S+/)?.[0] || null }), 2500);
    child.on('exit', (c) => {
      if (!c) return;
      const said = buf.trim().slice(-200), hint = acliLoginHint(said);
      reject(new Error(`acli exited (${c}): ${said}${hint ? ` ${hint}` : ''}`));
    });
  });
}

// In Clearsky's container, Copilot's folders that the container doesn't mount (docker-compose
// decides what's there, not Settings): they'd be missing in chats.
export function unmounted(folders, { inContainer = process.env.CLEARSKY_IN_CONTAINER === '1', exists = existsSync, home = homedir() } = {}) {
  if (!inContainer) return [];
  return (folders || '~/dev').split(',').map((f) => f.trim()).filter(Boolean)
    .filter((f) => !exists(f.startsWith('~') ? join(home, f.slice(1)) : f));
}
