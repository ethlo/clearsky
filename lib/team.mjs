// Team packs: a team's shared Clearsky setup in a file or git repo the team owns, so a new
// colleague runs `clearsky join <repo>` (or pastes it on the welcome page) and is set up.
//
//   clearsky-team.json
//   {
//     "name": "Payments team",
//     "settings": { "GITHUB_ORGS": "acme", "CLEARSKY_STANDUP_TIME": "09:45", "COPILOT_DOMAINS": "repo.acme.example" },
//     "links": [{ "name": "Team", "links": [{ "title": "Board", "url": "https://…" }] }],
//     "skills": "skills"            // a folder of Copilot skills next to the file (git repo or folder)
//   }
//
// The pack lives with the team, never in Clearsky, so company details stay out of this repo.
// Only the settings in TEAM_KEYS are taken: never a secret, never something personal (your
// calendar, your folders' trust decisions). A pack value fills a setting you haven't set, or
// one the pack set before; a value you changed yourself is kept. Git packs are fetched with
// your own git login; there's no token.

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, readdirSync, cpSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mergeLinks, normalize } from './links.mjs';

const execFileP = promisify(execFile);

export const PACK_FILE = 'clearsky-team.json';

// What a team may set for you. The sandbox's doors (Never ask before, the "always" rules) and
// tokens stay yours; extra hosts for the sandbox are allowed but called out when you join.
export const TEAM_KEYS = [
  'GITHUB_ORGS', 'GITHUB_BUILD_REPOS', 'CLEARSKY_STANDUP_TIME', 'CLEARSKY_WORKDAYS', 'CLEARSKY_WORKDAY_END', 'CLEARSKY_MENTION_DAYS',
  'COPILOT_MODEL', 'COPILOT_REVIEW_MODEL', 'COPILOT_EFFORT', 'COPILOT_PERMISSION', 'COPILOT_SANDBOX', 'COPILOT_FOLDERS', 'COPILOT_DISCLOSE',
  'COPILOT_DOMAINS', 'COPILOT_VM_IMAGES', 'GRAFANA_INSTANCES', 'GRAFANA_ASK', 'VPN_CHECK', 'VPN_NEEDED_BY',
];
// Settings that let the sandbox reach more: listed on their own when you join.
export const WIDENS = new Set(['COPILOT_DOMAINS', 'COPILOT_VM_IMAGES']);

// Where a pack comes from: a git repo, an https link to the JSON, or a file or folder here.
export function packKind(from) {
  const f = String(from || '').trim();
  if (/^(git@|ssh:\/\/)/.test(f) || /\.git\/?$/.test(f) || /^https:\/\/(github\.com|gitlab\.com|bitbucket\.org)\/[\w.-]+\/[\w.-]+\/?$/.test(f)) return 'git';
  if (/^https:\/\//.test(f)) return 'url';
  if (/^http:\/\//.test(f)) return null; // never over plain http
  return f ? 'file' : null;
}

const git = (args, opts = {}) => execFileP('git', args, { timeout: 60_000, ...opts, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });

// Fetch the pack: its JSON and the folder it sits in (for skills), if any.
export async function fetchPack(from, { dir, fetchImpl = fetch } = {}) {
  const kind = packKind(from);
  if (!kind) throw new Error('give a git repo, an https:// link or a file');
  if (kind === 'url') {
    const r = await fetchImpl(from, { signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`couldn't fetch the pack (${r.status})`);
    return { pack: parsePack(await r.text()), root: null };
  }
  let root;
  if (kind === 'git') {
    root = join(dir, 'repo');
    const same = existsSync(join(root, '.git')) && (await git(['-C', root, 'remote', 'get-url', 'origin']).then((x) => x.stdout.trim(), () => '')) === from;
    if (same) await git(['-C', root, 'pull', '--ff-only', '-q']);
    else {
      rmSync(root, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      try { await git(['clone', '--depth', '1', '-q', from, root]); }
      catch (e) { throw new Error(`git couldn't fetch it: ${String(e.stderr || e.message).trim().split('\n').pop()}`); }
    }
  } else {
    const p = resolve(from.replace(/^~(?=\/|$)/, process.env.HOME || ''));
    if (!existsSync(p)) throw new Error(`no such file: ${from}`);
    root = statSync(p).isDirectory() ? p : dirname(p);
    if (!statSync(p).isDirectory()) return { pack: parsePack(readFileSync(p, 'utf8')), root };
  }
  const file = join(root, PACK_FILE);
  if (!existsSync(file)) throw new Error(`there's no ${PACK_FILE} in it`);
  return { pack: parsePack(readFileSync(file, 'utf8')), root };
}

export function parsePack(text) {
  let p;
  try { p = JSON.parse(text); } catch { throw new Error(`the pack isn't valid JSON`); }
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('the pack should be a JSON object');
  const name = String(p.name || 'Team').slice(0, 80);
  const settings = {}, ignored = [];
  for (const [k, v] of Object.entries(p.settings || {})) {
    if (TEAM_KEYS.includes(k) && (typeof v === 'string' || typeof v === 'number')) settings[k] = String(v);
    else ignored.push(k);
  }
  const links = normalize({ groups: (Array.isArray(p.links) ? p.links : []).map((g) => ({ ...g, area: 'work' })) });
  const skills = typeof p.skills === 'string' && /^[\w./-]+$/.test(p.skills) && !p.skills.split('/').includes('..') ? p.skills : null;
  return { name, settings, ignored, links, skills };
}

// What joining changes, without changing it: settings to write, the ones you set yourself
// (kept), and what widens the sandbox.
export function planSettings(pack, current, previous = {}) {
  const write = {}, kept = [];
  for (const [k, v] of Object.entries(pack.settings)) {
    const now = current[k] || '';
    if (now === v) continue;
    if (!now || previous[k] === now) write[k] = v;
    else kept.push(k);
  }
  // A setting the old pack set, the new one dropped and you never changed: it goes too.
  for (const [k, v] of Object.entries(previous)) if (!(k in pack.settings) && current[k] === v) write[k] = '';
  const widens = Object.keys(write).filter((k) => WIDENS.has(k) && write[k]);
  return { write, kept, widens };
}

// Copy the pack's skills into your personal skills folder (~/.copilot/skills), so Copilot has
// them in every repo. A skill you already have is left alone unless the pack put it there.
export function installSkills(root, sub, skillsDir, mine = []) {
  if (!root || !sub) return { installed: [], skipped: [] };
  const from = join(root, sub);
  if (!existsSync(from)) return { installed: [], skipped: [] };
  const installed = [], skipped = [];
  for (const n of readdirSync(from)) {
    if (!/^[\w.-]+$/.test(n) || !existsSync(join(from, n, 'SKILL.md'))) continue;
    const to = join(skillsDir, n);
    if (existsSync(to) && !mine.includes(n)) { skipped.push(n); continue; }
    mkdirSync(skillsDir, { recursive: true });
    rmSync(to, { recursive: true, force: true });
    cpSync(join(from, n), to, { recursive: true });
    installed.push(n);
  }
  return { installed, skipped };
}

// Join (or update): fetch, then apply settings, links and skills. Returns what happened.
// readEnv/writeEnv/readLinks/saveLinks come from the caller, so the settings file stays the
// one place settings are written.
export async function joinPack(from, { confDir, skillsDir, readEnv, writeEnv, validate, readLinks, saveLinks, fetchImpl } = {}) {
  const stateFile = join(confDir, 'team.json');
  const before = readTeam(confDir);
  const same = before?.from === from;
  const { pack, root } = await fetchPack(from, { dir: join(confDir, 'team'), fetchImpl });
  const plan = planSettings(pack, readEnv(), same ? before.applied || {} : {});
  const write = validate(plan.write);
  if (Object.keys(write).length) writeEnv(write);
  const count = (d) => d.groups.reduce((n, g) => n + g.links.length, 0);
  let linksAdded = 0;
  if (count(pack.links)) {
    const had = readLinks(), merged = mergeLinks(had, pack.links);
    linksAdded = count(merged) - count(normalize(had));
    if (linksAdded) saveLinks(merged);
  }
  const skills = installSkills(root, pack.skills, skillsDir, same ? before.skills || [] : []);
  const applied = Object.fromEntries(Object.entries({ ...(same ? before.applied : {}), ...write }).filter(([k, v]) => v && k in pack.settings));
  const state = { from, name: pack.name, at: new Date().toISOString(), applied, skills: [...new Set([...(same ? before.skills || [] : []), ...skills.installed])] };
  mkdirSync(confDir, { recursive: true, mode: 0o700 });
  writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  return { name: pack.name, written: Object.keys(write), kept: plan.kept, widens: plan.widens, ignored: pack.ignored, links: linksAdded, skills, write };
}

export function readTeam(confDir) {
  try { return JSON.parse(readFileSync(join(confDir, 'team.json'), 'utf8')); } catch { return null; }
}

// One line for people: what joining did.
export function joinSummary(r) {
  const parts = [];
  parts.push(r.written.length ? `set ${r.written.length} setting${r.written.length === 1 ? '' : 's'} (${r.written.join(', ')})` : 'no settings to change');
  if (r.kept.length) parts.push(`kept your own ${r.kept.join(', ')}`);
  if (r.links) parts.push(`added ${r.links} link${r.links === 1 ? '' : 's'}`);
  if (r.skills.installed.length) parts.push(`installed skills ${r.skills.installed.join(', ')}`);
  if (r.skills.skipped.length) parts.push(`left your own skills ${r.skills.skipped.join(', ')}`);
  if (r.widens.length) parts.push(`the sandbox may now also reach ${r.widens.map((k) => r.write[k]).join(', ')}`);
  if (r.ignored.length) parts.push(`ignored ${r.ignored.join(', ')} (not something a team sets)`);
  return `${parts.join('; ')}.`;
}

// A pack from your own settings, to share with your team: `clearsky team export`.
export function exportPack({ name = 'Team', env = process.env, links = null } = {}) {
  const settings = Object.fromEntries(TEAM_KEYS.filter((k) => env[k]).map((k) => [k, env[k]]));
  const out = { name, settings };
  if (links) out.links = normalize(links).groups.filter((g) => g.area !== 'personal').map((g) => ({ name: g.name, links: g.links.map((l) => ({ title: l.title, url: l.url })) }));
  return out;
}
