// Setting Clearsky up: logins that sources start from Settings, joining and making a team pack,
// what this machine has (doctor and the welcome page), and what the settings page shows.
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import * as settings from '../settings.mjs';
import { vmSupport } from '../vm.mjs';
import { makeContext, asList } from '../sources.mjs';
import { readRegistry, catalogEntry } from '../plugins.mjs';
import { findBrowser } from '../browser.mjs';
import { wslInfo } from '../wsl.mjs';
import { readLinks, saveLinks } from '../links.mjs';
import { logEvent } from '../event-log.mjs';
import { isDemo } from '../demo.mjs';
import { checks as doctorChecks } from '../doctor.mjs';
import { edsCalendars } from '../eds.mjs';
import { joinPack, readTeam, TEAM_KEYS, applyWaiting, pluginOffers } from '../team.mjs';
import { scaffoldPack, writeScaffold, nextSteps } from '../team-scaffold.mjs';
import { TRACKERS } from '../tracker.mjs';
import { appDir, userEnvFile, config, tracker, backend, applySettings, saveSettings, pluginDirs, plugins } from './config.mjs';
import { linksFile, sourceCache } from './work.mjs';
import { copilotFolders } from './chat-env.mjs';

// Logins that extra sources start from Settings, such as BankID in a browser window. They
// can take minutes, so they run in the background and Settings polls for the outcome.
const sourceLogins = new Map();

async function loginStatus() {
  const many = [...plugins.sources.values()].filter((p) => p.logins?.list).map((p) => {
    let list = [];
    try { list = asList(p.logins.list(makeContext(p).env)); } catch { /* shows none */ }
    return { name: p.name, label: p.label, many: list.map((l) => ({ id: String(l.id), label: String(l.label || l.id), loggedIn: !!l.loggedIn, detail: String(l.detail || ''), canLogOut: !!l.canLogOut })) };
  });
  return [...many, ...await Promise.all([...plugins.sources.values()].filter((p) => p.login).map(async (p) => {
    let st = {};
    try { st = (await p.login.status?.(makeContext(p).env)) || {}; } catch (e) { st = { detail: e.message }; }
    const run = sourceLogins.get(p.name);
    return { name: p.name, label: p.label, button: p.login.label || 'Log in', loggedIn: !!st.loggedIn, detail: st.detail || '',
      running: run?.state === 'running', error: run?.state === 'error' ? run.message : null };
  }))];
}

// Join a team pack (lib/team.mjs): settings through the settings file, links and skills too.
// A plugin's settings it lets a team set (manifest "team": true) count as team settings; the
// pack's values for plugins you haven't added wait until you add them (teamWaiting).
const teamKey = (k) => !!settings.FIELDS[k]?.team;
const teamIo = () => ({
  readEnv: () => Object.fromEntries([...TEAM_KEYS, ...Object.keys(settings.FIELDS).filter(teamKey)].map((k) => [k, process.env[k] || ''])),
  writeEnv: (v) => { settings.writeEnvFile(userEnvFile, v); applySettings(v); }, // already checked by the caller
  validate: (w) => settings.validate(Object.fromEntries(Object.entries(w).filter(([k]) => settings.FIELDS[k]))),
});
export function joinTeam(from) {
  return joinPack(from, {
    confDir: dirname(userEnvFile), skillsDir: backend().personalSkills(), ...teamIo(),
    readLinks: () => readLinks(linksFile()), saveLinks: (d) => saveLinks(linksFile(), d),
    teamKey, known: (k) => !!settings.FIELDS[k], added: () => readRegistry(pluginDirs.registry).plugins,
  });
}
export function teamWaiting() {
  try { const w = applyWaiting(dirname(userEnvFile), { teamKey, ...teamIo() }); if (w.length) logEvent(`team pack settings filled in for a plugin you added: ${w.join(', ')}`); }
  catch (e) { console.error(`clearsky: team pack settings: ${e.message}`); }
}
// A new team pack repo from your own settings (lib/team-scaffold.mjs): `clearsky team init` and Settings.
export function makeTeamPack({ dir, name, repo, jiraSite, links = false, force = false }) {
  if (!dir) throw new Error('say which folder to write it to');
  const env = Object.fromEntries(Object.keys(settings.FIELDS).filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
  const { pack, files, warnings } = scaffoldPack({ name: name || 'Team', repo, jiraSite, env, teamKeys: Object.keys(settings.FIELDS).filter(teamKey),
    links: links ? readLinks(linksFile()) : null, registry: readRegistry(pluginDirs.registry).plugins, catalogFrom: (n) => catalogEntry(n)?.from || null });
  const w = writeScaffold(dir, files, { force });
  return { ...w, pack, warnings, next: nextSteps(w.dir, repo) };
}
// The team pack's plugins next to yours, for Settings → Plugins.
export const teamPlugins = () => { const t = readTeam(dirname(userEnvFile)); return t?.plugins?.length ? { name: t.name, plugins: pluginOffers(t.plugins, readRegistry(pluginDirs.registry).plugins) } : null; };

// `clearsky doctor` and the welcome page: what this machine has for Clearsky.
export const machineChecks = () => doctorChecks({ acliBin: config.jira.acli, tracker: tracker(), agent: backend(), copilotBin: backend().find(),
  calendars: () => (process.platform === 'linux' && !wslInfo() ? edsCalendars() : []), browser: () => { try { return findBrowser(process.env, { windows: true }); } catch { return null; } },
  vm: () => vmSupport(), folders: [appDir, ...copilotFolders()] });
// Nothing set up yet: no settings file of your own and no organizations from anywhere else.
export const firstRun = () => !existsSync(userEnvFile) && !process.env.GITHUB_ORGS && !isDemo();

export const settingsStatus = async () => {
  const st = await settings.status(config, { path: userEnvFile });
  return { ...st, tracker: { ...st.tracker, now: TRACKERS[tracker()] }, logins: await loginStatus() };
};

export function startSourceLogin(p) {
  if (sourceLogins.get(p.name)?.state === 'running') return;
  sourceLogins.set(p.name, { state: 'running' });
  Promise.resolve().then(() => p.login.start(makeContext(p).env)).then((r) => {
    // Only the source's own settings, e.g. a school key learned from the login.
    const own = Object.fromEntries(Object.entries(r?.settings || {}).filter(([k, v]) => Object.hasOwn(p.settings || {}, k) && v));
    if (Object.keys(own).length) saveSettings(own);
    sourceLogins.delete(p.name);
    sourceCache.delete(p.name);
  }).catch((e) => sourceLogins.set(p.name, { state: 'error', message: e.message }));
}
