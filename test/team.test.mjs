// Team packs: a team's shared setup, joined from a git repo, a link or a file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { packKind, parsePack, planSettings, joinPack, joinSummary, exportPack, packPlugins, pluginOffers, applyWaiting, readTeam } from '../lib/team.mjs';
import { readEnvFile, writeEnvFile, validate } from '../lib/settings.mjs';
import { readLinks, saveLinks } from '../lib/links.mjs';

const PACK = {
  name: 'Payments team',
  settings: { GITHUB_ORGS: 'acme', CLEARSKY_STANDUP_TIME: '09:30', COPILOT_DOMAINS: 'repo.acme.example', GITHUB_TOKEN: 'nope', COPILOT_ASSISTED_ALLOW: 'git push' },
  links: [{ name: 'Team', links: [{ title: 'Board', url: 'https://acme.atlassian.net/jira/boards/1' }, { title: 'bad', url: 'javascript:alert(1)' }] }],
  skills: 'skills',
};

test('where a pack comes from', () => {
  assert.equal(packKind('https://github.com/acme/clearsky-team'), 'git');
  assert.equal(packKind('git@github.com:acme/clearsky-team.git'), 'git');
  assert.equal(packKind('https://example.com/clearsky-team.json'), 'url');
  assert.equal(packKind('http://example.com/clearsky-team.json'), null);
  assert.equal(packKind('~/team/clearsky-team.json'), 'file');
});

test('a pack never carries tokens or the sandbox doors, and only safe links', () => {
  const p = parsePack(JSON.stringify(PACK));
  assert.deepEqual(Object.keys(p.settings).sort(), ['CLEARSKY_STANDUP_TIME', 'COPILOT_DOMAINS', 'GITHUB_ORGS']);
  assert.deepEqual(p.ignored.sort(), ['COPILOT_ASSISTED_ALLOW', 'GITHUB_TOKEN']);
  assert.equal(p.links.groups[0].links.length, 1);
});

test('your own values win; what the pack set before follows the pack', () => {
  const pack = parsePack(JSON.stringify({ settings: { GITHUB_ORGS: 'acme', CLEARSKY_STANDUP_TIME: '09:30' } }));
  const first = planSettings(pack, { GITHUB_ORGS: '', CLEARSKY_STANDUP_TIME: '10:00' });
  assert.deepEqual(first.write, { GITHUB_ORGS: 'acme' });
  assert.deepEqual(first.kept, ['CLEARSKY_STANDUP_TIME']);
  const next = parsePack(JSON.stringify({ settings: { GITHUB_ORGS: 'acme,acme-labs' } }));
  const upd = planSettings(next, { GITHUB_ORGS: 'acme', CLEARSKY_STANDUP_TIME: '09:30' }, { GITHUB_ORGS: 'acme', CLEARSKY_STANDUP_TIME: '09:30' });
  assert.deepEqual(upd.write, { GITHUB_ORGS: 'acme,acme-labs', CLEARSKY_STANDUP_TIME: '' });
});

test('joining from a git repo sets settings, links and skills, and joining again updates', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'clearsky-team-'));
  const src = join(tmp, 'src'), conf = join(tmp, 'conf'), skillsDir = join(tmp, 'skills');
  mkdirSync(join(src, 'skills', 'release-notes'), { recursive: true });
  writeFileSync(join(src, 'clearsky-team.json'), JSON.stringify(PACK));
  writeFileSync(join(src, 'skills', 'release-notes', 'SKILL.md'), '---\nname: release-notes\n---\nWrite release notes.\n');
  const g = (...a) => execFileSync('git', a, { cwd: src, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@example.com', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@example.com' } });
  g('init', '-q', '-b', 'main'); g('add', '-A'); g('commit', '-qm', 'pack');
  execFileSync('git', ['clone', '-q', '--bare', src, join(tmp, 'team.git')]);

  const envFile = join(conf, '.env'), linksFile = join(conf, 'links.json');
  writeEnvFile(envFile, { CLEARSKY_STANDUP_TIME: '10:00' });
  const opts = { confDir: conf, skillsDir, readEnv: () => readEnvFile(envFile), writeEnv: (v) => writeEnvFile(envFile, v), validate,
    readLinks: () => readLinks(linksFile), saveLinks: (d) => saveLinks(linksFile, d) };
  const r = await joinPack(join(tmp, 'team.git'), opts);
  assert.equal(r.name, 'Payments team');
  const env = readEnvFile(envFile);
  assert.equal(env.GITHUB_ORGS, 'acme');
  assert.equal(env.CLEARSKY_STANDUP_TIME, '10:00', 'your own stand-up time stays');
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.ok(existsSync(join(skillsDir, 'release-notes', 'SKILL.md')));
  assert.equal(readLinks(linksFile).groups[0].links[0].title, 'Board');
  assert.match(joinSummary(r), /kept your own CLEARSKY_STANDUP_TIME/);
  assert.match(joinSummary(r), /sandbox may now also reach repo\.acme\.example/);

  // The team changes its pack; joining again brings the change.
  writeFileSync(join(src, 'clearsky-team.json'), JSON.stringify({ ...PACK, settings: { ...PACK.settings, GITHUB_ORGS: 'acme,acme-labs' } }));
  g('commit', '-qam', 'more orgs'); execFileSync('git', ['push', '-q', join(tmp, 'team.git'), 'main'], { cwd: src, stdio: 'ignore' });
  const r2 = await joinPack(join(tmp, 'team.git'), opts);
  assert.equal(readEnvFile(envFile).GITHUB_ORGS, 'acme,acme-labs');
  assert.equal(r2.links, 0, 'links are not added twice');
  assert.equal(JSON.parse(readFileSync(join(conf, 'team.json'), 'utf8')).from, join(tmp, 'team.git'));
});

test('export makes a pack from your settings, without secrets or personal links', () => {
  const p = exportPack({ name: 'Acme', env: { GITHUB_ORGS: 'acme', GITHUB_TOKEN: 'secret', CALENDAR_EMAIL: 'me@acme.example' },
    links: { groups: [{ name: 'Daily', area: 'work', links: [{ title: 'Board', url: 'https://example.com/b' }] }, { name: 'Home', area: 'personal', links: [{ title: 'Bank', url: 'https://bank.example' }] }] } });
  assert.deepEqual(p.settings, { GITHUB_ORGS: 'acme' });
  assert.deepEqual(p.links.map((g) => g.name), ['Daily']);
});

test('a pack lists plugins; a folder in the pack is fetched from the pack\'s own repo', () => {
  const pack = parsePack(JSON.stringify({ plugins: ['github:someone/clearsky-weather#v1.2.0', { from: './plugins/deploys', note: 'Deploy board' }, './../escape', 'not a plugin', { nope: 1 }, 'slack'] }));
  assert.equal(pack.plugins.length, 5);
  const git = packPlugins(pack, 'https://github.com/acme/clearsky-team');
  assert.deepEqual(git.plugins.map((p) => p.from), ['github:someone/clearsky-weather#v1.2.0', 'https://github.com/acme/clearsky-team.git/plugins/deploys', 'slack']);
  assert.equal(git.plugins[1].note, 'Deploy board');
  assert.equal(git.plugins[1].inPack, './plugins/deploys');
  assert.deepEqual(git.bad, ['./../escape', 'not a plugin']);
  assert.equal(packPlugins(pack, 'git@github.com:acme/clearsky-team.git').plugins[1].from, 'git@github.com:acme/clearsky-team.git/plugins/deploys');
  assert.equal(packPlugins(pack, '/home/u/team/clearsky-team.json').plugins[1].from, '/home/u/team/plugins/deploys');
  assert.ok(packPlugins(pack, 'https://example.com/clearsky-team.json').bad.includes('./plugins/deploys'), 'a pack behind a plain link has no folder to take plugins from');
});

test('the team\'s plugins next to yours: added, another version, or new', () => {
  const offers = pluginOffers([{ from: 'github:a/weather#v1.1.0' }, { from: 'github:a/deploys' }, { from: 'github:a/notes#v2' }], {
    weather: { from: 'github:a/weather#v1.0.0', version: '1.0.0' }, notes: { from: 'github:a/notes#v2' } });
  assert.deepEqual(offers.map((o) => [o.from, o.state, o.name || null]), [['github:a/weather#v1.1.0', 'other-version', 'weather'], ['github:a/deploys', 'new', null], ['github:a/notes#v2', 'added', 'notes']]);
  assert.match(joinSummary({ written: [], kept: [], links: 0, skills: { installed: [], skipped: [] }, widens: [], ignored: [], plugins: offers, waiting: [] }), /offers 1 plugin to add \(github:a\/deploys\); uses another version of weather/);
});

test('a plugin\'s team settings: set when you join if you have it, else once you add it; never a secret', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'clearsky-team-'));
  const conf = join(tmp, 'conf'), envFile = join(conf, '.env'), packFile = join(tmp, 'clearsky-team.json');
  writeFileSync(packFile, JSON.stringify({ name: 'Ops', settings: { DEPLOYS_URL: 'https://deploys.acme.example', DEPLOYS_TOKEN: 'nope', WEATHER_PLACE: 'Oslo' }, plugins: ['./plugins/deploys'] }));
  // Clearsky knows weather (added; WEATHER_PLACE is a team setting) and DEPLOYS_TOKEN (a secret); deploys isn't added yet.
  let fields = { WEATHER_PLACE: { team: true }, DEPLOYS_TOKEN: { secret: true } };
  const io = { readEnv: () => readEnvFile(envFile), writeEnv: (v) => writeEnvFile(envFile, v), validate: (w) => w };
  const teamKey = (k) => !!fields[k]?.team, known = (k) => !!fields[k];
  const r = await joinPack(packFile, { confDir: conf, skillsDir: join(tmp, 'skills'), ...io, readLinks: () => ({ groups: [] }), saveLinks: () => {}, teamKey, known });
  assert.deepEqual(r.written, ['WEATHER_PLACE']);
  assert.deepEqual(r.waiting, ['DEPLOYS_URL']);
  assert.deepEqual(r.ignored, ['DEPLOYS_TOKEN']);
  assert.deepEqual(r.plugins.map((p) => [p.from, p.state]), [[join(tmp, 'plugins', 'deploys'), 'new']]);
  assert.equal(readEnvFile(envFile).DEPLOYS_URL, undefined);
  // You add deploys; at the next start its settings are known, and the pack's value is filled in.
  fields = { ...fields, DEPLOYS_URL: { team: true } };
  assert.deepEqual(applyWaiting(conf, { teamKey, ...io }), ['DEPLOYS_URL']);
  assert.equal(readEnvFile(envFile).DEPLOYS_URL, 'https://deploys.acme.example');
  assert.equal(readTeam(conf).waiting, undefined);
  assert.equal(readTeam(conf).applied.DEPLOYS_URL, 'https://deploys.acme.example');
  assert.deepEqual(applyWaiting(conf, { teamKey, ...io }), []);
});
