#!/usr/bin/env node
// clearsky: one view of what needs your attention on GitHub and Jira, and in what plugins add (Slack, School…).
// Zero dependencies, Node 22+. See README.md.
//
//   clearsky              print a Markdown summary
//   clearsky --json       print the raw data as JSON (for Copilot skills / scripts)
//   clearsky serve        serve the dashboard on http://127.0.0.1:7777

import { existsSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { bundledDir, codeDir } from '../lib/plugins.mjs';
import { findBrowser } from '../lib/browser.mjs';
import { loginEnv } from '../lib/wsl.mjs';
import { readLinks } from '../lib/links.mjs';
import { startDemo, demoPort } from '../lib/demo.mjs';
import { doctorText, ready as doctorReady } from '../lib/doctor.mjs';
import { joinSummary, readTeam, exportPack } from '../lib/team.mjs';
import { isBot, openThreads, myPrStatus } from '../lib/modules/github.mjs';
import { userEnvFile, config, pluginDirs } from '../lib/app/config.mjs';
import { jiraDebug } from '../lib/app/services.mjs';
import { SOURCES, linksFile, sourceCache, collect, toMarkdown } from '../lib/app/work.mjs';
import { standup } from '../lib/app/standup.mjs';
import { joinTeam, makeTeamPack, machineChecks } from '../lib/app/setup.mjs';
import { pluginCommand } from '../lib/app/plugin-admin.mjs';
import { restartCommand, openInBrowser, appCommand, dockerCommand } from '../lib/app/commands.mjs';
import { serve } from '../lib/app/server.mjs';
export { userEnvFile, parseWorkdays, tracker, backend, clock, nextStandup, previousStandup } from '../lib/app/config.mjs';
export { prPreview, issuePreview } from '../lib/app/services.mjs';
export { hiddenCalendars, planNow, moduleManifests, source, prReadKey, collect, toMarkdown } from '../lib/app/work.mjs';
export { remoteRepo, findCheckout, worktreeFor } from '../lib/app/chat-env.mjs';
export { JIRA_HINT, buildsWhere, buildsHint, typedPart, validRefs } from '../lib/app/chat-hints.mjs';
export { jiraTargets } from '../lib/app/chat-gate.mjs';
export { vmMaven } from '../lib/app/chat-builds.mjs';
export { sessionTitle, linkSessions, itemSessionName } from '../lib/app/chat-sessions.mjs';
export { standupText, standup } from '../lib/app/standup.mjs';
export { pollAttention, keepAliveDelay } from '../lib/app/attention.mjs';
export { buildPage } from '../lib/app/page.mjs';
export { fileHeaders } from '../lib/app/http.mjs';
export { isBot, openThreads, myPrStatus };

export { findBrowser, SOURCES, sourceCache };

// ---------------------------------------------------------------- main

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const args = process.argv.slice(2);
  if (args.includes('-h') || args.includes('--help')) {
    console.log('usage: clearsky [--json] | clearsky try [--port N] [--no-open] | clearsky doctor [--json] | clearsky join [<team pack>] | clearsky team init <folder> [--name N] [--repo URL] [--links] | clearsky team export [--name N] [--links] | clearsky add <plugin> [--trust] [--yes] | clearsky remove <plugin> [--data] | clearsky plugins | clearsky update [<plugin>] | clearsky standup [--json] | clearsky serve [--port N] | clearsky restart [--now] [--wait MIN] [--port N] | clearsky app [--port N] | clearsky login jira|github | clearsky docker [up|start|down|logs|login|mounts] [--port N] | clearsky school-handover | clearsky jira-debug');
  } else if (args[0] === 'try') {
    // Clearsky with made-up data, in this terminal: Ctrl+C stops it.
    const p = args.indexOf('--port');
    const port = p > -1 ? Number(args[p + 1]) : demoPort();
    const d = await startDemo({ port, foreground: true });
    if (d.already) console.log(`The demo is already running: ${d.url}`);
    if (!args.includes('--no-open')) openInBrowser(d.url);
    if (d.child) await new Promise((r) => d.child.once('exit', r));
  } else if (args[0] === 'join') {
    // clearsky join <git repo | https link | file>; without one, fetch the pack you joined again.
    const from = args[1] || readTeam(dirname(userEnvFile))?.from;
    if (!from) { console.error('usage: clearsky join <git repo | https://…/clearsky-team.json | file>'); process.exitCode = 2; }
    else {
      try {
        const r = await joinTeam(from);
        console.log(`Joined ${r.name}: ${joinSummary(r)}`);
        if (r.plugins.some((p) => p.state !== 'added')) console.log('Look at the team\'s plugins and add them with `clearsky add --team` (or in Settings → Plugins).');
      }
      catch (e) { console.error(`clearsky: ${e.message}`); process.exitCode = 1; }
    }
  } else if (args[0] === 'team' && args[1] === 'init') {
    // clearsky team init <folder> [--name N] [--repo URL] [--jira-site S] [--links] [--force]
    const opt = (f) => { const i = args.indexOf(f); return i > -1 ? args[i + 1] : undefined; };
    const dir = args[2] && !args[2].startsWith('--') ? args[2] : null;
    if (!dir) { console.error('usage: clearsky team init <folder> [--name "Payments team"] [--repo https://github.com/acme/clearsky-team] [--jira-site acme.atlassian.net] [--links] [--force]'); process.exitCode = 2; }
    else {
      try {
        const r = makeTeamPack({ dir, name: opt('--name'), repo: opt('--repo'), jiraSite: opt('--jira-site'), links: args.includes('--links'), force: args.includes('--force') });
        console.log(`Wrote ${r.pack.name}'s team pack to ${r.dir}: ${r.written.join(', ')}`);
        for (const w of r.warnings) console.log(`  note: ${w}`);
        console.log('\nLook through clearsky-team.json, then:\n');
        for (const n of r.next) console.log(`  ${n}`);
      } catch (e) { console.error(`clearsky: ${e.message}`); process.exitCode = 1; }
    }
  } else if (args[0] === 'team' && args[1] === 'export') {
    // A team pack from your own settings (and, with --links, your work links), to share.
    const n = args.indexOf('--name');
    console.log(JSON.stringify(exportPack({ name: n > -1 ? args[n + 1] : 'Team', links: args.includes('--links') ? readLinks(linksFile()) : null }), null, 2));
  } else if (args[0] === 'doctor') {
    const list = await machineChecks();
    console.log(args.includes('--json') ? JSON.stringify(list, null, 2) : doctorText(list));
    process.exitCode = doctorReady(list) ? 0 : 1;
  } else if (args[0] === 'standup') {
    const s = await standup();
    console.log(args.includes('--json') ? JSON.stringify(s, null, 2) : s.text);
  } else if (args[0] === 'restart') {
    const p = args.indexOf('--port');
    if (p > -1) config.port = Number(args[p + 1]);
    await restartCommand(args);
  } else if (args[0] === 'app') {
    const p = args.indexOf('--port');
    if (p > -1) config.port = Number(args[p + 1]);
    await appCommand();
  } else if (args[0] === 'login' && ['jira', 'github'].includes(args[1])) {
    // The Settings logins, in this terminal: same browser handling (Windows browser under WSL).
    const [bin, argv] = args[1] === 'jira' ? [config.jira.acli || 'acli', ['jira', 'auth', 'login', '--web']] : ['gh', ['auth', 'login', '--web', '--hostname', 'github.com', '--git-protocol', 'https']];
    const code = await new Promise((done) => spawn(bin, argv, { stdio: 'inherit', env: loginEnv() }).on('exit', done).on('error', (e) => { console.error(`clearsky: ${e.code === 'ENOENT' ? `${bin} is not installed` : e.message}`); done(1); }));
    if (code && args[1] === 'jira') console.error('\nIf acli said "authentication failed" before any browser opened: run `acli jira auth logout` and try again; `clearsky doctor` says what this machine is missing for the browser.');
    process.exitCode = code || 0;
  } else if (args[0] === 'docker') {
    const p = args.indexOf('--port');
    if (p > -1) { config.port = Number(args[p + 1]); args.splice(p, 2); }
    await dockerCommand(args.slice(1));
  } else if (['add', 'remove', 'plugins', 'update'].includes(args[0])) {
    process.exitCode = await pluginCommand(args);
  } else if (args[0] === 'school-handover') {
    // The School plugin's own code, wherever it is: added from its repo, or its folder here.
    const dir = [codeDir(pluginDirs.root, 'flyt'), bundledDir('flyt')].find((d) => d && existsSync(join(d, 'lib', 'flyt.mjs')));
    if (!dir) { console.error('clearsky: the School plugin isn\'t added here (`clearsky add visma-flyt --trust`)'); process.exitCode = 1; } else {
      const { handOverLogin } = await import(pathToFileURL(join(dir, 'lib', 'flyt.mjs')).href);
      const where = await handOverLogin();
      console.log(where ? `School login moved to ${where}; Clearsky's container takes it from there.` : 'No school login here to hand over.');
    }
  } else if (args[0] === 'jira-debug') {
    await jiraDebug();
  } else if (args[0] === 'serve') {
    const p = args.indexOf('--port');
    if (p > -1) config.port = Number(args[p + 1]);
    serve();
  } else {
    const data = await collect();
    console.log(args.includes('--json') ? JSON.stringify(data, null, 2) : toMarkdown(data));
  }
}
