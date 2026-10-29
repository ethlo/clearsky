// Settings for the local Settings page: reads and writes ~/.config/clearsky/.env,
// reports which integrations are connected, and starts the CLI logins (gh, acli).
// Secret values are never sent back to the page.

import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { edsCalendars, pickCalendars, ownCalendars } from './eds.mjs';

const execFileP = promisify(execFile);

// Keys the page may set, and whether their value is secret.
export const FIELDS = {
  GITHUB_ORGS: { secret: false },
  GITHUB_TOKEN: { secret: true },
  GOOGLE_CALENDAR_ICS: { secret: true },
  CALENDAR_EMAIL: { secret: false },
  EVOLUTION_CALENDARS: { secret: false }, // extra calendars to include, by uid
  CALENDAR_MY_NAMES: { secret: false }, // names that make an event on a shared calendar yours
  SLACK_TOKEN: { secret: true },
  CLEARSKY_WORKDAY_END: { secret: false },
  CLEARSKY_STANDUP_TIME: { secret: false },
  CLEARSKY_WORKDAYS: { secret: false },
  CLEARSKY_MENTION_DAYS: { secret: false },
};

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
    const v = String(raw ?? '').trim();
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
    if (k === 'SLACK_TOKEN' && v && !/^xox[pb]-\S+$/.test(v)) throw new Error('the Slack token should start with xoxp-');
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
    },
    jira: {
      cli: acli.missing ? 'missing' : acli.ok && !/not (logged|authenticated)|no .*account/i.test(acli.out) ? 'logged-in' : 'logged-out',
      site: acliSite,
    },
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
    slack: { token: mask(config.slack.token) },
    workdayEnd: config.workdayEnd,
    standupTime: config.standupTime,
    workdays: process.env.CLEARSKY_WORKDAYS || 'Mon-Fri',
    mentionDays: config.days,
  };
}

// Start `gh auth login --web` and hand back its one-time code; gh then opens the browser.
export function githubLogin() {
  return new Promise((resolve, reject) => {
    const child = spawn('gh', ['auth', 'login', '--web', '--hostname', 'github.com', '--git-protocol', 'https'], {
      stdio: ['pipe', 'pipe', 'pipe'],
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
    const child = spawn(acliBin, ['jira', 'auth', 'login', '--web'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    const collect = (d) => { buf += d; };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (e) => reject(e.code === 'ENOENT' ? new Error('acli is not installed') : e));
    // Give it a moment to fail fast (e.g. bad flags); otherwise the browser flow is running.
    setTimeout(() => resolve({ started: true, url: buf.match(/https:\/\/\S+/)?.[0] || null }), 2500);
    child.on('exit', (c) => { if (c) reject(new Error(`acli exited (${c}): ${buf.trim().slice(-200)}`)); });
  });
}
