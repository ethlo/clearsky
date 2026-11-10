// Start a team pack: the repo a company keeps its own Clearsky setup in, made from your settings.
//
//   clearsky team init ~/dev/clearsky-team --name "Payments team" --repo https://github.com/acme/clearsky-team
//
// It writes a folder that's ready to push to a private repo (lib/team.mjs has what joining does):
//
//   clearsky-team.json   organizations, stand-up, Copilot's folders and hosts, Grafana, the VPN
//                        check, the plugins you use with their pins, kinds of change the team
//                        suggests letting through, and optionally your work links
//   README.md            for colleagues: install Clearsky, log in, join, what joining changes
//   skills/              Copilot skills the team shares (each a folder with a SKILL.md)
//   plugins/             plugins only the company uses
//   .gitignore           keeps settings files and keys out
//
// Only settings a team may set are taken (TEAM_KEYS, and plugin settings marked "team"), never a
// secret; a value that still looks like a token is left out and named. Nothing is pushed.

import { existsSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { exportPack, TEAM_KEYS, PACK_FILE, okRule } from './team.mjs';
import { parseRules, ruleLabel } from './advice.mjs';

// Values that look like a login, whatever setting they're in.
const SECRETISH = /\b(gh[pousr]_|github_pat_|xox[abprs]-|glsa_|ATATT)[\w-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY|:\/\/[^/\s:@]+:[^/\s@]+@/;
const HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

// Each plugin you added as the pack lists it: where it comes from, pinned. Folders and your own
// files can't be fetched by a colleague, so they're named instead.
export function packPluginList(registry = {}, { catalogFrom = () => null } = {}) {
  const plugins = [], skipped = [], unpinned = [];
  for (const [name, e] of Object.entries(registry)) {
    let from = e.from;
    if (e.kind === 'bundled') from = catalogFrom(name);
    if (!from || e.kind === 'folder' || e.kind === 'local') { skipped.push(name); continue; }
    if (e.pin === 'default' || (e.kind === 'git' && !String(from).includes('#'))) unpinned.push(name);
    plugins.push(from);
  }
  return { plugins: [...new Set(plugins)].sort(), skipped, unpinned };
}

export function scaffoldPack({ name = 'Team', repo = '', jiraSite = '', env = process.env, teamKeys = TEAM_KEYS, links = null,
  registry = {}, catalogFrom, clearskyRepo = 'https://github.com/ethlo/clearsky' } = {}) {
  const warnings = [];
  const keys = [...new Set([...TEAM_KEYS, ...teamKeys])];
  const base = exportPack({ name, env: {}, links });
  // Clearsky's team settings, and plugin settings a team may set.
  const settings = Object.fromEntries(keys.filter((k) => env[k]).map((k) => [k, String(env[k])]));
  for (const [k, v] of Object.entries(settings)) if (SECRETISH.test(v)) { delete settings[k]; warnings.push(`left out ${k}: it looks like it holds a login`); }
  const site = String(jiraSite || '').trim().replace(/^https:\/\//, '').replace(/\/.*$/, '');
  if (site && !HOST.test(site)) throw new Error('the Jira site should be a host name, like acme.atlassian.net');
  const { plugins, skipped, unpinned } = packPluginList(registry, { catalogFrom });
  if (skipped.length) warnings.push(`left out ${skipped.join(', ')}: added from a folder here, so colleagues can't fetch it. Put it under plugins/ in the pack and list it as "./plugins/<name>".`);
  if (unpinned.length) warnings.push(`${unpinned.join(', ')} follow${unpinned.length === 1 ? 's' : ''} a branch: pin a tag (#v1.2.0) so everyone runs the same code`);
  // Your "always" rules, minus repos outside the team's organizations (your own projects).
  const orgs = new Set(String(settings.GITHUB_ORGS || '').split(/[\s,]+/).filter(Boolean).map((o) => o.toLowerCase()));
  const mine = [...parseRules(env.COPILOT_GATE_RULES)].filter(okRule);
  const suggest = mine.filter((r) => !r.startsWith('repo:') || !orgs.size || orgs.has(r.slice(5).split('/')[0].toLowerCase()));
  if (suggest.length < mine.length) warnings.push(`left out rules for repos outside ${[...orgs].join(', ')}: ${mine.filter((r) => !suggest.includes(r)).join(', ')}`);
  const pack = {
    name: String(name).slice(0, 80),
    ...(site && { jira: { site } }),
    settings,
    ...(base.links?.length && { links: base.links }),
    skills: 'skills',
    plugins,
    gate: { suggest },
  };
  const files = {
    [PACK_FILE]: `${JSON.stringify(pack, null, 2)}\n`,
    'README.md': readme({ pack, repo, clearskyRepo }),
    'skills/README.md': SKILLS_README,
    'plugins/README.md': PLUGINS_README,
    '.gitignore': '.env\n*.env\n.env.*\n*.pem\n*.key\nnode_modules/\n',
  };
  return { pack, files, warnings };
}

// Write it into `dir` (a new or empty folder, or one with a pack in it when `force`).
export function writeScaffold(dir, files, { force = false } = {}) {
  const to = resolve(String(dir).replace(/^~(?=\/|\\|$)/, homedir()));
  if (existsSync(join(to, PACK_FILE)) && !force) throw new Error(`${to} already has a ${PACK_FILE}; pick another folder (or --force to write over it)`);
  if (existsSync(to) && !force && readdirSync(to).some((n) => n !== '.git')) throw new Error(`${to} isn't empty; pick a new folder`);
  const written = [];
  for (const [rel, text] of Object.entries(files)) {
    const file = join(to, ...rel.split('/'));
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, text);
    written.push(rel);
  }
  return { dir: to, written };
}

// What to do next, in a terminal.
export function nextSteps(dir, repo) {
  const slug = String(repo || '').match(/github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/)?.[1];
  return [
    `cd ${dir}`,
    'git init -b main && git add -A && git commit -m "Our Clearsky setup"',
    slug ? `gh repo create ${slug} --private --source . --push` : 'gh repo create <org>/clearsky-team --private --source . --push',
    `Then colleagues run: clearsky join ${repo || 'https://github.com/<org>/clearsky-team'}`,
  ];
}

const list = (xs) => xs.map((x) => `- ${x}`).join('\n');
function readme({ pack, repo, clearskyRepo }) {
  const s = pack.settings;
  const join = repo || 'https://github.com/<org>/clearsky-team';
  const what = [
    s.GITHUB_ORGS && `GitHub organizations: ${s.GITHUB_ORGS}`,
    pack.jira && `Jira: ${pack.jira.site}`,
    s.CLEARSKY_STANDUP_TIME && `Stand-up: ${s.CLEARSKY_STANDUP_TIME}${s.CLEARSKY_WORKDAYS ? ` on ${s.CLEARSKY_WORKDAYS}` : ''}`,
    s.COPILOT_FOLDERS && `Folders Copilot may use: ${s.COPILOT_FOLDERS}`,
    s.COPILOT_DOMAINS && `Extra hosts the sandbox may reach: ${s.COPILOT_DOMAINS}`,
    s.GRAFANA_INSTANCES && `Grafana environments: ${s.GRAFANA_INSTANCES}`,
    pack.links?.length && `Links: ${pack.links.map((g) => g.name).join(', ')}`,
    Object.keys(s).some((k) => !TEAM_KEYS.includes(k)) && `Plugin settings, filled in once you add the plugin: ${Object.keys(s).filter((k) => !TEAM_KEYS.includes(k)).join(', ')}`,
  ].filter(Boolean);
  return `# ${pack.name}: Clearsky setup

Our shared setup for [Clearsky](${clearskyRepo}), the local work dashboard with a sandboxed Copilot next to it. This repo holds settings and links only: no tokens, no passwords, no keys. Everyone logs in with their own accounts, and those logins stay on their own laptop.

## Get started

1. Install Clearsky (Node 22+ and git needed):

   \`\`\`sh
   git clone ${clearskyRepo} && cd clearsky
   sh scripts/install.sh
   \`\`\`

2. Log in with your own accounts: \`gh auth login\` for GitHub${pack.jira ? `, and \`acli jira auth login --web\` for Jira (pick ${pack.jira.site})` : ', and `acli jira auth login --web` for Jira'}. The welcome page at http://127.0.0.1:7777 has a button for each.
3. Join this setup:

   \`\`\`sh
   clearsky join ${join}
   \`\`\`

   or paste the link on the welcome page, or in Settings → General → Team pack. Your git (and gh) login fetches it, so no token is needed.

## What joining gives you

${what.length ? list(what) : '- (nothing set yet)'}
${pack.plugins.length ? `- Plugins, offered to you to look at and add (Settings → Plugins → From ${pack.name}, or \`clearsky add --team\`):\n${pack.plugins.map((p) => `  - \`${p}\``).join('\n')}` : ''}
${pack.gate.suggest.length ? `- Kinds of change we let through without asking, offered under Settings → Copilot → Let through without asking:\n${pack.gate.suggest.map((r) => `  - ${ruleLabel(r)} (\`${r}\`)`).join('\n')}` : ''}
- Copilot skills from \`skills/\`, copied to \`~/.copilot/skills\`.

A setting you changed yourself is kept. Your tokens, your calendar and the sandbox's doors are never taken from here: plugins and the suggested rules are offered, and you decide.

## Updating

Settings → General → Team pack → **Update**, or \`clearsky join\` again. To change the setup, open a pull request here. Pin plugins to a tag (\`#v1.2.0\`) and move the pin in a pull request when the team takes a new version.

## Rules for this repo

- No secrets: tokens, passwords, cookies and keys stay on each laptop. Before you push, \`node <your Clearsky>/scripts/leak-check.mjs .\` looks for them.
- Plugins only the company uses go in \`plugins/<name>/\` and are listed as \`"./plugins/<name>"\` in \`clearsky-team.json\`.
- Personal things (your voice profile, your calendar, your memory notes) don't belong here.
`;
}

const SKILLS_README = `# Skills

Copilot skills the team shares. Each is a folder with a \`SKILL.md\`:

\`\`\`
skills/
  release-notes/SKILL.md
\`\`\`

Joining copies them to \`~/.copilot/skills\`, so Copilot has them in every repo. A skill someone already has with the same name is left alone.
`;
const PLUGINS_README = `# Plugins

Clearsky plugins only this company uses. Each is a folder with a \`clearsky-plugin.json\` and its code (see Clearsky's docs/plugins.md). List each in \`clearsky-team.json\`:

\`\`\`json
"plugins": ["./plugins/deploys#v1.0.0"]
\`\`\`

Colleagues are offered it with the rest, fetched from this repo with their own login.
`;
