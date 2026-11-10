// Team packs: a team's shared Clearsky setup in a file or git repo the team owns, so a new
// colleague runs `clearsky join <repo>` (or pastes it on the welcome page) and is set up.
//
//   clearsky-team.json
//   {
//     "name": "Payments team",
//     "settings": { "GITHUB_ORGS": "acme", "CLEARSKY_STANDUP_TIME": "09:45", "COPILOT_DOMAINS": "repo.acme.example" },
//     "links": [{ "name": "Team", "links": [{ "title": "Board", "url": "https://…" }] }],
//     "skills": "skills",           // a folder of Copilot skills next to the file (git repo or folder)
//     "plugins": [                  // plugins the team uses, offered to you (never added unseen)
//       "github:someone/clearsky-weather#v1.2.0",
//       { "from": "./plugins/deploys", "note": "Our deploy board" }   // a folder in the pack's own repo
//     ],
//     "jira": { "site": "acme.atlassian.net" },   // where to log in to Jira with acli
//     "gate": { "suggest": ["repo:acme/docs", "jira:PAY"] }   // offered under Settings → Copilot
//   }
//
// `clearsky team init` (lib/team-scaffold.mjs) writes a new pack repo from your own settings.
//
// Plugins: each one is offered, and you add it the usual way (Settings → Plugins or `clearsky
// add --team`), seeing what it reaches first. A pin in the pack (#v1.3.0) is the team's
// version: when the pack moves it, you're offered the update. A plugin can say which of its
// settings a team may set (`"team": true` in its manifest; never a secret); the pack's values
// for those are filled in once the plugin is added, the same way as the settings above.
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
import { parseSpec, sourceKey, ghCredential } from './plugins.mjs';
import { RULES } from './advice.mjs';

// Gate rules a team may suggest: the named kinds, a repo's everyday changes, a Jira project's tickets.
export const okRule = (r) => !!RULES[r] || /^repo:[\w.-]+\/[\w.-]+$/.test(r) || /^jira:[A-Z][A-Z0-9_]+$/.test(r);

const execFileP = promisify(execFile);

export const PACK_FILE = 'clearsky-team.json';

// What a team may set for you. The sandbox's doors (Never ask before, the "always" rules) and
// tokens stay yours; extra hosts for the sandbox are allowed but called out when you join.
export const TEAM_KEYS = [
  'GITHUB_ORGS', 'GITHUB_BUILD_REPOS', 'CLEARSKY_STANDUP_TIME', 'CLEARSKY_WORKDAYS', 'CLEARSKY_WORKDAY_END', 'CLEARSKY_MENTION_DAYS',
  'COPILOT_MODEL', 'COPILOT_REVIEW_MODEL', 'COPILOT_EFFORT', 'COPILOT_PERMISSION', 'COPILOT_SANDBOX', 'COPILOT_FOLDERS', 'COPILOT_DISCLOSE',
  'COPILOT_CREDIT_USD', 'CLEARSKY_CURRENCY', 'CLEARSKY_FX_LIVE',
  'COPILOT_DOMAINS', 'COPILOT_VM_IMAGES', 'VPN_CHECK', 'VPN_NEEDED_BY', 'JIRA_STARRED_PROJECTS',
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
    if (same) await git([...ghCredential(from), '-C', root, 'pull', '--ff-only', '-q']);
    else {
      rmSync(root, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      try { await git([...ghCredential(from), 'clone', '--depth', '1', '-q', from, root]); }
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
  // `other`: settings that aren't Clearsky's own team settings. A plugin's setting it lets a team
  // set is taken from there when you join (or once you add the plugin); the rest is ignored.
  const settings = {}, other = {}, ignored = [];
  for (const [k, v] of Object.entries(p.settings || {})) {
    const ok = typeof v === 'string' || typeof v === 'number';
    if (TEAM_KEYS.includes(k) && ok) settings[k] = String(v);
    else { ignored.push(k); if (ok && /^[A-Z][A-Z0-9_]+$/.test(k)) other[k] = String(v); }
  }
  const links = normalize({ groups: (Array.isArray(p.links) ? p.links : []).map((g) => ({ ...g, area: 'work' })) });
  const skills = typeof p.skills === 'string' && /^[\w./-]+$/.test(p.skills) && !p.skills.split('/').includes('..') ? p.skills : null;
  const plugins = (Array.isArray(p.plugins) ? p.plugins : []).slice(0, 50).map((x) => (typeof x === 'string' ? { from: x } : x && typeof x === 'object' ? x : null))
    .filter((x) => x && typeof x.from === 'string' && x.from.trim())
    .map((x) => ({ from: x.from.trim(), ...(typeof x.note === 'string' && x.note.trim() && { note: x.note.trim().slice(0, 200) }) }));
  // Kinds of change the team lets through without asking: only ever offered, never applied.
  const suggest = (Array.isArray(p.gate?.suggest) ? p.gate.suggest : []).filter((r) => typeof r === 'string' && okRule(r.trim())).map((r) => r.trim()).slice(0, 50);
  const site = typeof p.jira?.site === 'string' && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(p.jira.site.trim()) ? p.jira.site.trim().toLowerCase() : null;
  return { name, settings, other, ignored, links, skills, plugins, gate: { suggest: [...new Set(suggest)] }, ...(site && { jira: { site } }) };
}

// The pack's plugins as places to add them from. "./folder" is a folder in the pack itself: in
// its git repo (fetched like any git plugin, with your login) or next to its file.
export function packPlugins(pack, from) {
  const kind = packKind(from), out = [], bad = [];
  for (const p of pack.plugins || []) {
    let f = p.from;
    const rel = f.match(/^\.\/([\w./-]+?)\/?(#[\w./-]+)?$/);
    if (rel) {
      if (rel[1].split('/').includes('..')) { bad.push(p.from); continue; }
      if (kind === 'git') f = `${from.replace(/\/+$/, '').replace(/(\.git)?$/, '.git')}/${rel[1]}${rel[2] || ''}`;
      else if (kind === 'file') {
        const at = resolve(from.replace(/^~(?=\/|$)/, process.env.HOME || ''));
        f = join(existsSync(at) && statSync(at).isDirectory() ? at : dirname(at), rel[1]);
      } else { bad.push(p.from); continue; }
    }
    try { parseSpec(f); out.push({ ...p, from: f, ...(f !== p.from && { inPack: p.from }) }); } catch { bad.push(p.from); }
  }
  return { plugins: out, bad };
}

// Each of the team's plugins next to what you have: added (that very version), another
// version of it added (the team moved its pin, or you picked another), or not added.
export function pluginOffers(list, added = {}) {
  return (list || []).map((p) => {
    const key = (() => { try { return sourceKey(p.from); } catch { return null; } })();
    const exact = Object.entries(added).find(([, e]) => e.from === p.from);
    if (exact) return { ...p, state: 'added', name: exact[0] };
    const other = key && Object.entries(added).find(([, e]) => { try { return sourceKey(e.from) === key; } catch { return false; } });
    if (other) return { ...p, state: 'other-version', name: other[0], yours: other[1].from, version: other[1].version };
    return { ...p, state: 'new' };
  });
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
// `teamKey(k)` says whether an added plugin lets a team set k (its manifest's "team": true);
// `known(k)` whether Clearsky knows the setting at all. A plugin setting from the pack that
// Clearsky doesn't know yet waits in team.json until you add that plugin (applyWaiting).
// `added()` is your plugins.json list, to say which of the team's plugins you have.
export async function joinPack(from, { confDir, skillsDir, readEnv, writeEnv, validate, readLinks, saveLinks, fetchImpl,
  teamKey = () => false, known = () => true, added = () => ({}) } = {}) {
  const stateFile = join(confDir, 'team.json');
  const before = readTeam(confDir);
  const same = before?.from === from;
  const { pack, root } = await fetchPack(from, { dir: join(confDir, 'team'), fetchImpl });
  const forPlugins = Object.fromEntries(Object.entries(pack.other || {}).filter(([k]) => teamKey(k)));
  const waiting = Object.fromEntries(Object.entries(pack.other || {}).filter(([k]) => !known(k)));
  const plan = planSettings({ ...pack, settings: { ...pack.settings, ...forPlugins } }, readEnv(), same ? before.applied || {} : {});
  const write = validate(plan.write);
  if (Object.keys(write).length) writeEnv(write);
  const { plugins, bad } = packPlugins(pack, from);
  const count = (d) => d.groups.reduce((n, g) => n + g.links.length, 0);
  let linksAdded = 0;
  if (count(pack.links)) {
    const had = readLinks(), merged = mergeLinks(had, pack.links);
    linksAdded = count(merged) - count(normalize(had));
    if (linksAdded) saveLinks(merged);
  }
  const skills = installSkills(root, pack.skills, skillsDir, same ? before.skills || [] : []);
  const applied = Object.fromEntries(Object.entries({ ...(same ? before.applied : {}), ...write }).filter(([k, v]) => v && (k in pack.settings || k in forPlugins)));
  const state = { from, name: pack.name, at: new Date().toISOString(), applied, skills: [...new Set([...(same ? before.skills || [] : []), ...skills.installed])],
    ...(plugins.length && { plugins }), ...(Object.keys(waiting).length && { waiting }),
    ...(pack.gate.suggest.length && { gate: pack.gate }), ...(pack.jira && { jira: pack.jira }) };
  mkdirSync(confDir, { recursive: true, mode: 0o700 });
  writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  const ignored = pack.ignored.filter((k) => !(k in forPlugins) && !(k in waiting));
  return { name: pack.name, written: Object.keys(write), kept: plan.kept, widens: plan.widens, ignored, links: linksAdded, skills, write,
    plugins: pluginOffers(plugins, added()), badPlugins: bad, waiting: Object.keys(waiting), gate: pack.gate, ...(pack.jira && { jira: pack.jira }) };
}

// After a plugin is added (at the next start, once its settings are known): the pack's values
// for the settings it lets a team set, filled in the same way joining does. Returns what it wrote.
export function applyWaiting(confDir, { teamKey, readEnv, writeEnv, validate }) {
  const state = readTeam(confDir);
  const now = Object.fromEntries(Object.entries(state?.waiting || {}).filter(([k]) => teamKey(k)));
  if (!Object.keys(now).length) return [];
  const plan = planSettings({ settings: now }, readEnv(), {});
  const write = validate(plan.write);
  if (Object.keys(write).length) writeEnv(write);
  const waiting = Object.fromEntries(Object.entries(state.waiting).filter(([k]) => !(k in now)));
  const next = { ...state, applied: { ...state.applied, ...Object.fromEntries(Object.entries(write).filter(([, v]) => v)) } };
  if (Object.keys(waiting).length) next.waiting = waiting; else delete next.waiting;
  writeFileSync(join(confDir, 'team.json'), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  return Object.keys(write);
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
  const offers = r.plugins || [];
  const fresh = offers.filter((p) => p.state === 'new'), moved = offers.filter((p) => p.state === 'other-version');
  if (fresh.length) parts.push(`offers ${fresh.length} plugin${fresh.length === 1 ? '' : 's'} to add (${fresh.map((p) => p.from).join(', ')})`);
  if (moved.length) parts.push(`uses another version of ${moved.map((p) => p.name).join(', ')}`);
  if (r.waiting?.length) parts.push(`has settings for plugins you haven't added (${r.waiting.join(', ')}), filled in once you add them`);
  if (r.badPlugins?.length) parts.push(`skipped plugins it can't add from (${r.badPlugins.join(', ')})`);
  if (r.gate?.suggest?.length) parts.push(`suggests letting ${r.gate.suggest.join(', ')} through without asking (yours to take, under Settings → Copilot)`);
  if (r.jira) parts.push(`Jira is at ${r.jira.site} (log in with acli jira auth login --web)`);
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
