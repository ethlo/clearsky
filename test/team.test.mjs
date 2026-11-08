// Team packs: a team's shared setup, joined from a git repo, a link or a file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { packKind, parsePack, planSettings, joinPack, joinSummary, exportPack } from '../lib/team.mjs';
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
