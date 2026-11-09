import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { scaffoldPack, writeScaffold, nextSteps, packPluginList } from '../lib/team-scaffold.mjs';
import { parsePack, joinPack, joinSummary, readTeam } from '../lib/team.mjs';

const tmp = (p) => mkdtempSync(join(tmpdir(), `clearsky-${p}-`));
const env = {
  GITHUB_ORGS: 'acme', CLEARSKY_STANDUP_TIME: '09:45', COPILOT_DOMAINS: 'repo.acme.example', GRAFANA_INSTANCES: 'test=https://grafana.test.acme.example',
  GITHUB_TOKEN: 'ghp_abcdefghijneverleavesthismachine0000', SLACK_TOKEN: 'xoxp-1-2', CALENDAR_EMAIL: 'me@acme.example',
  COPILOT_GATE_RULES: 'merge-ready, repo:acme/docs, repo:someone/hobby, jira:PAY',
  DEPLOYS_URL: 'https://deploys.acme.example', VPN_CHECK: 'https://u:hunter2@vpn.acme.example',
};
const registry = {
  slack: { from: 'slack', kind: 'bundled', run: 'inside' },
  weather: { from: 'github:someone/clearsky-weather#v1.2.0', kind: 'git', pin: 'ref' },
  edge: { from: 'github:someone/clearsky-edge', kind: 'git', pin: 'default' },
  mine: { from: '/home/me/dev/mine', kind: 'folder' },
};

test('a team pack from your settings: team settings only, no secrets, pinned plugins, your rules as suggestions', () => {
  const { pack, files, warnings } = scaffoldPack({ name: 'Payments team', repo: 'https://github.com/acme/clearsky-team', jiraSite: 'https://acme.atlassian.net/', env,
    teamKeys: ['DEPLOYS_URL'], registry, catalogFrom: (n) => (n === 'slack' ? 'github:ethlo/clearsky-slack-mcp#v1.0.0' : null) });
  assert.deepEqual(Object.keys(pack.settings).sort(), ['CLEARSKY_STANDUP_TIME', 'COPILOT_DOMAINS', 'DEPLOYS_URL', 'GITHUB_ORGS', 'GRAFANA_INSTANCES']);
  const all = Object.values(files).join('\n');
  for (const secret of ['ghp_', 'xoxp-', 'me@acme.example', 'hunter2']) assert.ok(!all.includes(secret), `${secret} stays out`);
  assert.ok(warnings.some((w) => /left out VPN_CHECK/.test(w)), 'a value with a password in it is named, not written');
  assert.deepEqual(pack.jira, { site: 'acme.atlassian.net' });
  assert.deepEqual(pack.plugins, ['github:ethlo/clearsky-slack-mcp#v1.0.0', 'github:someone/clearsky-edge', 'github:someone/clearsky-weather#v1.2.0']);
  assert.ok(warnings.some((w) => /mine: added from a folder/.test(w) || /left out mine/.test(w)));
  assert.ok(warnings.some((w) => /edge follows a branch/.test(w)));
  // Your own projects' rules stay yours.
  assert.deepEqual(pack.gate.suggest, ['merge-ready', 'repo:acme/docs', 'jira:PAY']);
  assert.ok(warnings.some((w) => /repo:someone\/hobby/.test(w)));
  assert.match(files['README.md'], /clearsky join https:\/\/github\.com\/acme\/clearsky-team/);
  assert.match(files['README.md'], /acme\.atlassian\.net/);
  assert.match(files['README.md'], /No secrets/);
  assert.ok(files['skills/README.md'] && files['plugins/README.md'] && files['.gitignore'].includes('.env'));
  // What it writes is a pack Clearsky reads back the same.
  const back = parsePack(files['clearsky-team.json']);
  assert.equal(back.name, 'Payments team');
  assert.deepEqual(back.gate.suggest, pack.gate.suggest);
  assert.deepEqual(back.jira, { site: 'acme.atlassian.net' });
  assert.throws(() => scaffoldPack({ jiraSite: 'not a host' }), /host name/);
});

test('written to a new folder only, then joined: suggestions are offered, never applied', async () => {
  const dir = join(tmp('pack'), 'clearsky-team');
  const { files } = scaffoldPack({ name: 'Acme', env, registry: {} });
  const w = writeScaffold(dir, files);
  assert.deepEqual(w.written.sort(), ['.gitignore', 'README.md', 'clearsky-team.json', 'plugins/README.md', 'skills/README.md']);
  assert.throws(() => writeScaffold(dir, files), /already has a clearsky-team\.json/);
  const other = tmp('busy');
  writeFileSync(join(other, 'notes.txt'), 'x');
  assert.throws(() => writeScaffold(other, files), /isn't empty/);
  assert.ok(writeScaffold(dir, files, { force: true }).written.length);

  const conf = tmp('conf');
  let mine = { COPILOT_GATE_RULES: '' };
  const r = await joinPack(dir, { confDir: conf, skillsDir: join(conf, 'skills'), readEnv: () => mine, writeEnv: (v) => { mine = { ...mine, ...v }; }, validate: (x) => x,
    readLinks: () => ({ groups: [] }), saveLinks: () => {} });
  assert.equal(mine.COPILOT_GATE_RULES, '', 'the gate is never set by a pack');
  assert.deepEqual(readTeam(conf).gate.suggest, ['merge-ready', 'repo:acme/docs', 'jira:PAY']);
  assert.match(joinSummary(r), /suggests letting merge-ready, repo:acme\/docs, jira:PAY through without asking/);
});

test('next steps name the repo, and a pack can be pushed as it is', () => {
  assert.deepEqual(nextSteps('/x', 'https://github.com/acme/clearsky-team.git').slice(2), ['gh repo create acme/clearsky-team --private --source . --push', 'Then colleagues run: clearsky join https://github.com/acme/clearsky-team.git']);
  assert.match(nextSteps('/x', '')[2], /<org>\/clearsky-team/);
  assert.deepEqual(packPluginList({ a: { from: 'a', kind: 'bundled' } }).skipped, ['a']);
  // A pack's gate list only takes rules Clearsky knows.
  assert.deepEqual(parsePack(JSON.stringify({ gate: { suggest: ['merge-ready', 'repo:acme/x', 'rm -rf', 'jira:pay', 42] } })).gate.suggest, ['merge-ready', 'repo:acme/x']);
});

test('clearsky team init writes the pack from your settings file', () => {
  const home = tmp('home');
  mkdirSync(join(home, '.config', 'clearsky'), { recursive: true });
  writeFileSync(join(home, '.config', 'clearsky', '.env'), 'GITHUB_ORGS=acme\nGITHUB_TOKEN=ghp_abcdefghijneverleavesthismachine0000\n');
  const dir = join(home, 'dev', 'clearsky-team');
  const out = execFileSync(process.execPath, [join(import.meta.dirname, '..', 'bin', 'clearsky.mjs'), 'team', 'init', dir, '--name', 'Acme', '--repo', 'https://github.com/acme/clearsky-team'],
    { env: { PATH: process.env.PATH, HOME: home, CLEARSKY_PLUGINS_DIR: join(home, 'plugins') }, cwd: home }).toString();
  assert.match(out, /Wrote Acme's team pack/);
  assert.match(out, /gh repo create acme\/clearsky-team --private/);
  const pack = JSON.parse(readFileSync(join(dir, 'clearsky-team.json'), 'utf8'));
  assert.deepEqual(pack.settings, { GITHUB_ORGS: 'acme' });
  assert.ok(existsSync(join(dir, 'README.md')));
});
