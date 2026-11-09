import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJira, sortVersions, starredProjects, jqlText, versionSummary } from '../lib/modules/jira.mjs';
import { validate } from '../lib/settings.mjs';

const execFileP = promisify(execFile);
const settle = (p) => p.catch((e) => ({ error: e.message }));
const fake = fileURLToPath(new URL('./fake-acli.mjs', import.meta.url));

function jira() {
  const log = join(mkdtempSync(join(tmpdir(), 'cs-ver-')), 'acli.log');
  writeFileSync(log, '');
  const env = { ...process.env, FAKE_ACLI_LOG: log };
  const j = createJira({ config: { jira: { acli: fake, url: 'https://acme.atlassian.net' } }, execFileP: (f, a, o) => execFileP(f, a, { ...o, env }), settle });
  return { j, calls: () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) };
}

test('starred projects come from the setting, as keys, once each', () => {
  assert.deepEqual(starredProjects('ops, abc ABC  x-1,,'), ['OPS', 'ABC']);
  assert.deepEqual(starredProjects(undefined), []);
  assert.equal(validate({ JIRA_STARRED_PROJECTS: 'ops abc,OPS' }).JIRA_STARRED_PROJECTS, 'OPS, ABC');
  assert.throws(() => validate({ JIRA_STARRED_PROJECTS: 'OPS, no-way' }), /not a Jira project key: NO-WAY/);
});

test('versions: unreleased first by date, then released newest first, archived left out', () => {
  const v = sortVersions([{ name: '1.0', released: true, releaseDate: '2026-01-01' }, { name: '1.3' }, { name: '1.2', releaseDate: '2026-12-01' },
    { name: '0.9', released: true, releaseDate: '2025-06-01' }, { name: 'old', archived: true }, { name: '1.2' }]);
  assert.deepEqual(v.map((x) => x.name), ['1.2', '1.3', '1.0', '0.9']);
  assert.equal(jqlText('say "hi" \\ there'), 'say \\"hi\\" \\\\ there');
});

test('lists your projects through acli, and a project\'s versions from the project or its tickets', async () => {
  const { j, calls } = jira();
  assert.deepEqual(await j.jiraProjects(), [{ key: 'ABC', name: 'Alpha' }, { key: 'OPS', name: 'Operations' }]);
  assert.deepEqual(calls().find((c) => c[1] === 'project'), ['jira', 'project', 'list', '--paginate', '--json']);
  assert.deepEqual((await j.projectVersions('OPS')).map((v) => [v.name, v.released]), [['1.1', false], ['1.0', true]]);
  // ABC's project has none, so they're gathered from its tickets.
  assert.deepEqual((await j.projectVersions('ABC')).map((v) => [v.name, v.released]), [['2.0', false], ['2.1', true]]);
  const n = calls().length;
  await j.projectVersions('ABC');
  assert.equal(calls().length, n, 'cached');
});

test('one version\'s tickets, with a summary by status', async () => {
  const { j, calls } = jira();
  const d = await j.versionIssues('OPS', '1.1');
  assert.equal(calls().find((c) => c[2] === 'search')[4], 'project = "OPS" AND fixVersion = "1.1" ORDER BY priority DESC, key ASC');
  assert.deepEqual(d.issues.map((i) => [i.key, i.status, i.statusCategory, i.assignee, i.url]), [
    ['OPS-1', 'In Progress', 'indeterminate', 'Alex', 'https://acme.atlassian.net/browse/OPS-1'],
    ['OPS-3', 'Done', 'done', null, 'https://acme.atlassian.net/browse/OPS-3'],
    ['OPS-4', 'To Do', 'new', null, 'https://acme.atlassian.net/browse/OPS-4']]);
  const s = versionSummary(d.issues);
  assert.deepEqual([s.total, s.new, s.indeterminate, s.done], [3, 1, 1, 1]);
  assert.deepEqual(s.statuses.map((x) => x.name), ['To Do', 'In Progress', 'Done']);
});
