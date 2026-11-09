import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, appendFileSync, existsSync, readFileSync, readdirSync, cpSync, rmSync } from "node:fs";
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { parseManifest, parseSpec, addPlugin, removePlugin, listPlugins, loadPlugins, migrateBundled, readRegistry, fetchPlugin, readManifest, codeDir, BUNDLED, treeHash,
  sourceKey, withRef, pinOf, ghCredential, remoteRefs, checkPlugin, updatePlugin, preparePlugin, reachChanges, versionOf, readCatalog, bundledDir } from '../lib/plugins.mjs';
import { sandboxedSource, runPlugin, pluginSrtSettings, cleanEnv, srtWrap } from '../lib/plugin-sandbox.mjs';
import { hook, asList } from '../lib/sources.mjs';

const tmp = (p) => mkdtempSync(join(tmpdir(), `clearsky-${p}-`));
const paths = () => { const d = tmp('plugins'); return { root: join(d, 'plugins'), registry: join(d, 'conf', 'plugins.json') }; };
// Runs the plugin's process as it is, for tests: the real one goes through srt.
const plain = async (argv) => ({ bin: argv[0], args: argv.slice(1) });

function pluginFolder(manifest, code) {
  const dir = tmp('src');
  writeFileSync(join(dir, 'clearsky-plugin.json'), JSON.stringify({ clearsky: 1, entry: 'source.mjs', ...manifest }));
  writeFileSync(join(dir, 'source.mjs'), code);
  return dir;
}

const WEATHER = `export default {
  async fetch(ctx) {
    const r = await ctx.json(ctx.env.WEATHER_URL);
    let other = null;
    try { await ctx.fetch('https://example.org/'); } catch (e) { other = e.message; }
    return { rain: r.rain, env: Object.keys(process.env).sort(), settings: Object.keys(ctx.env), other, dataDir: ctx.dataDir };
  },
  items: (d) => [{ key: 'today', title: d.rain ? 'Rain today' : 'Dry today', detail: true }],
  attention: (d) => (d.rain ? [{ key: 'rain', title: 'Take the bus' }] : []),
  events: () => [{ uid: 'w1', title: 'Rain', start: '2026-11-09T07:00:00Z', end: '2026-11-09T09:00:00Z', fyi: true }],
  standup: (d, since) => ({ today: ['since ' + since.toISOString().slice(0, 10)] }),
  detail: (key, ctx, data) => ({ title: key, messages: [{ text: 'rain: ' + data.rain + ', items kept back: ' + (data.items?.length ?? 'none') }] }),
};`;

test('the manifest is checked before anything runs', () => {
  const m = parseManifest({ name: 'weather', hosts: ['api.example.com', '*.example.net'], settings: { WEATHER_URL: { label: 'URL' } }, enabledWhen: ['WEATHER_URL'] });
  assert.equal(m.area, 'personal');
  assert.equal(m.entry, 'source.mjs');
  assert.deepEqual(m.hosts, ['api.example.com', '*.example.net']);
  assert.throws(() => parseManifest({ name: 'Bad' }), /lowercase/);
  assert.throws(() => parseManifest({ name: 'ok', clearsky: 99 }), /plugin API 99/);
  assert.throws(() => parseManifest({ name: 'ok', entry: '../x.mjs' }), /entry/);
  assert.throws(() => parseManifest({ name: 'ok', hosts: ['http://x.com/'] }), /host names/);
  assert.throws(() => parseManifest({ name: 'ok', settings: { lower: {} } }), /UPPER_CASE/);
  assert.throws(() => parseManifest({ name: 'ok', outside: ' ' }), /why/);
  assert.throws(() => parseManifest('{nope'), /valid JSON/);
  assert.throws(() => parseManifest({ name: 'ok', panel: { zone: 'track', page: false } }), /page can be false/);
  assert.equal(parseManifest({ name: 'ok', panel: { zone: 'needs', page: false } }).panel.page, false);
  assert.throws(() => parseManifest({ name: 'ok', doors: [{ name: 'weather', about: 'x' }] }), /outside/);
  assert.throws(() => parseManifest({ name: 'ok', outside: 'why', doors: [{ name: 'git', about: 'x' }] }), /doors/);
  assert.deepEqual(parseManifest({ name: 'ok', outside: 'why', doors: [{ name: 'weather', about: 'x' }] }).doors.map((d) => d.name), ['weather']);
});

test('where a plugin comes from', () => {
  assert.deepEqual(parseSpec('github:someone/clearsky-weather'), { kind: 'git', url: 'https://github.com/someone/clearsky-weather.git', sub: '', ref: null, from: 'github:someone/clearsky-weather' });
  assert.deepEqual(parseSpec('github:someone/plugins/weather#v1.2'), { kind: 'git', url: 'https://github.com/someone/plugins.git', sub: 'weather', ref: 'v1.2', from: 'github:someone/plugins/weather#v1.2' });
  assert.equal(parseSpec('https://git.example.com/me/plug.git#main').ref, 'main');
  assert.equal(parseSpec('git@example.com:me/plug.git').kind, 'git');
  assert.deepEqual(parseSpec('npm:@acme/clearsky-weather@1.2.0'), { kind: 'npm', pkg: '@acme/clearsky-weather@1.2.0', from: 'npm:@acme/clearsky-weather@1.2.0' });
  assert.equal(parseSpec('./here').kind, 'folder');
  // A name from the catalog is its own repo, at the pinned version.
  const school = parseSpec('visma-flyt');
  assert.deepEqual([school.kind, school.catalog, school.ref], ['git', 'flyt', 'v1.0.0']);
  assert.match(school.url, /\/clearsky-visma-flyt\.git$/);
  assert.equal(parseSpec('flyt').url, school.url);
  // A folder in plugins/ that isn't in the catalog is found by its manifest's name.
  const here = tmp('bundled');
  mkdirSync(join(here, 'clearsky-weather'));
  writeFileSync(join(here, 'clearsky-weather', 'clearsky-plugin.json'), JSON.stringify({ name: 'weather' }));
  writeFileSync(join(here, 'clearsky-weather', 'source.mjs'), 'export default {};');
  assert.deepEqual(parseSpec('weather', { bundled: here }), { kind: 'bundled', dir: join(here, 'clearsky-weather'), from: 'weather' });
  assert.throws(() => parseSpec('http://example.com/x.git'), /plain http/);
  assert.throws(() => parseSpec('nosuchplugin'), /ships with Clearsky/);
});

test('a plugin from a git repo is pinned to its commit, and only its folder is taken', async () => {
  const repo = tmp('repo');
  mkdirSync(join(repo, 'weather'));
  writeFileSync(join(repo, 'weather', 'clearsky-plugin.json'), JSON.stringify({ name: 'weather' }));
  writeFileSync(join(repo, 'weather', 'source.mjs'), 'export default { fetch() { return {}; } };');
  const g = (...a) => execFileSync('git', ['-C', repo, ...a], { env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } }).toString().trim();
  g('init', '-q'); g('add', '.'); g('commit', '-qm', 'one');
  const into = tmp('into');
  const got = await fetchPlugin({ kind: 'git', url: repo, sub: 'weather', ref: null }, into);
  assert.equal(got.commit, g('rev-parse', 'HEAD'));
  assert.equal(readManifest(got.dir).name, 'weather');
  assert.ok(!existsSync(join(into, 'repo', '.git')));
});

test('added, listed, loaded in its sandbox, refused once its files change, removed', async () => {
  const p = paths();
  const srv = createServer((req, res) => res.end(JSON.stringify({ rain: true }))).listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  try {
    const dir = pluginFolder({ name: 'weather', label: 'Weather', hosts: ['127.0.0.1'], panel: { zone: 'track' },
      settings: { WEATHER_URL: { label: 'URL' } }, enabledWhen: ['WEATHER_URL'] }, WEATHER);
    const r = await addPlugin(dir, { paths: p });
    assert.equal(r.run, 'sandbox');
    assert.match(r.hash, /^sha256-/);
    assert.equal(readRegistry(p.registry).plugins.weather.from, dir);
    assert.deepEqual(listPlugins({ paths: p }).added.map((x) => [x.name, x.run]), [['weather', 'sandbox']]);
    assert.ok(listPlugins({ paths: p }).available.some((x) => x.name === 'flyt'));

    // Clearsky never imports a sandboxed plugin; its stand-in runs it in its own process.
    const { sources, errors } = await loadPlugins({ paths: p, makeSandboxed: sandboxedSource({ root: p.root, wrap: plain, standupSince: () => new Date('2026-11-06T08:45:00Z') }) });
    assert.deepEqual(errors, []);
    const s = sources.get('weather');
    assert.equal(s.sandboxed, true);
    assert.equal(s.enabled({}), false);
    const data = await s.fetch({ env: { WEATHER_URL: `http://127.0.0.1:${srv.address().port}/` } });
    assert.equal(data.rain, true);
    assert.deepEqual(data.settings, ['WEATHER_URL']);
    assert.match(data.other, /example\.org is not in its manifest/);
    // Nothing of Clearsky's environment (tokens, settings) gets in.
    const clean = Object.keys(cleanEnv(process.env));
    assert.deepEqual(data.env.filter((k) => !clean.includes(k)), []);
    assert.ok(clean.every((k) => !/TOKEN|SLACK|GITHUB|CLEARSKY|JIRA/.test(k)));
    assert.equal(data.dataDir, join(p.root, 'weather', 'data'));
    assert.deepEqual(asList(hook(s, 'items', data)).map((i) => i.title), ['Rain today']);
    assert.deepEqual(asList(hook(s, 'attention', data)).map((i) => i.key), ['rain']);
    assert.equal(asList(hook(s, 'events', data)).length, 1);
    assert.deepEqual(hook(s, 'standup', data, new Date()).today, ['since 2026-11-06']);
    // Its reader runs in the sandbox too, with what it returned (not what Clearsky added).
    const d = await s.detail('today', { env: {} }, { ...JSON.parse(JSON.stringify(data)), items: [{ added: 'by Clearsky' }] });
    assert.equal(d.messages[0].text, 'rain: true, items kept back: none');
    // The run folders are cleaned up.
    assert.deepEqual(readdir(join(p.root, 'weather', 'runs')), []);

    appendFileSync(join(codeDir(p.root, 'weather'), 'source.mjs'), '\n// changed\n');
    const again = await loadPlugins({ paths: p, makeSandboxed: sandboxedSource({ root: p.root, wrap: plain }) });
    assert.equal(again.sources.size, 0);
    assert.match(again.errors[0], /changed since you added it/);

    removePlugin('weather', { paths: p, data: true });
    assert.deepEqual(readRegistry(p.registry).plugins, {});
    assert.ok(!existsSync(join(p.root, 'weather')));
  } finally { srv.close(); }
});

const readdir = (d) => { try { return readdirSync(d); } catch { return []; } };

test('a failing plugin says so, and a login it lost asks you to log in again', async () => {
  const p = paths();
  await addPlugin(pluginFolder({ name: 'broken' }, 'export default { fetch() { throw Object.assign(new Error("logged out"), { auth: true }); } };'), { paths: p });
  const { sources } = await loadPlugins({ paths: p, makeSandboxed: sandboxedSource({ root: p.root, wrap: plain }) });
  await assert.rejects(sources.get('broken').fetch({ env: {} }), (e) => e.auth === true && /broken: logged out/.test(e.message));
});

test('without srt, a sandboxed plugin doesn\'t run at all', async () => {
  const run = tmp('run');
  // srt is an optional dependency; where it's installed this only checks the command it builds.
  try {
    const { bin, args } = await srtWrap(['node', 'x'], { network: {} }, run);
    assert.equal(bin, process.execPath);
    assert.deepEqual(args.slice(1, 3), ['-s', join(run, 'srt.json')]);
  } catch (e) { assert.match(e.message, /needs the sandbox/); }
});

test('the sandbox: its hosts only, its own folders only, no secrets', () => {
  const home = '/home/u';
  const s = pluginSrtSettings({ code: '/home/u/.local/share/clearsky/plugins/w/code', data: '/home/u/.local/share/clearsky/plugins/w/data', run: '/home/u/.local/share/clearsky/plugins/w/runs/x', hosts: ['api.example.com'], home, node: '/home/u/.nvm/versions/node/v22/bin/node', platform: 'linux', uid: 1000 });
  assert.deepEqual(s.network.allowedDomains, ['api.example.com']);
  assert.ok(s.filesystem.denyRead.includes(home) && s.filesystem.denyRead.includes('/home/u/.ssh') && s.filesystem.denyRead.includes('/home/u/.config/clearsky') && s.filesystem.denyRead.includes('/run/user/1000'));
  assert.deepEqual(s.filesystem.allowWrite, ['/home/u/.local/share/clearsky/plugins/w/data', '/home/u/.local/share/clearsky/plugins/w/runs/x']);
  assert.ok(s.filesystem.allowRead.includes('/home/u/.nvm/versions/node/v22'));
  assert.ok(!s.filesystem.allowRead.some((x) => x === home || x.includes('/dev')));
  assert.deepEqual(Object.keys(cleanEnv({ PATH: '/bin', GITHUB_TOKEN: 'x', SLACK_TOKEN: 'y', HOME: home, CLEARSKY_SOME: 'z' })).sort(), ['HOME', 'NODE_USE_ENV_PROXY', 'PATH']);
});

test('a plugin that must run outside the sandbox is added only when you trust it', async () => {
  const p = paths();
  const dir = pluginFolder({ name: 'bank', outside: 'It opens a browser to log in.' }, 'export default (lends) => ({ fetch() { return { api: lends.api, browser: typeof lends.findBrowser }; } });');
  await assert.rejects(addPlugin(dir, { paths: p }), /runs outside the sandbox.*--trust/);
  assert.equal((await addPlugin(dir, { paths: p, trust: true })).run, 'inside');
  const { sources } = await loadPlugins({ paths: p });
  assert.deepEqual(await sources.get('bank').fetch({}), { api: 1, browser: 'function' });
});

test('names are one each, and Clearsky\'s own can\'t be taken', async () => {
  const p = paths();
  await addPlugin(pluginFolder({ name: 'dup' }, 'export default { fetch() {} };'), { paths: p });
  await assert.rejects(addPlugin(pluginFolder({ name: 'dup' }, 'export default { fetch() {} };'), { paths: p }), /already added/);
  await addPlugin(pluginFolder({ name: 'github' }, 'export default { fetch() {} };'), { paths: p });
  const { errors } = await loadPlugins({ paths: p, makeSandboxed: sandboxedSource({ root: p.root, wrap: plain }) });
  assert.ok(errors.some((e) => /built-in source/.test(e)));
});

test('School, once part of Clearsky, is a plugin now: added for you if it was set up', () => {
  const p = paths();
  assert.deepEqual(migrateBundled({ FLYT_SCHOOL_KEY: 'eksempel' }, { paths: p }), ['flyt']);
  assert.deepEqual(readRegistry(p.registry).plugins.flyt.run, 'inside');
  // Once: after that, what you added or removed stays.
  removePlugin('flyt', { paths: p });
  assert.deepEqual(migrateBundled({ FLYT_SCHOOL_KEY: 'eksempel' }, { paths: p }), []);
  const q = paths();
  assert.deepEqual(migrateBundled({}, { paths: q }), []);
  assert.deepEqual(readRegistry(q.registry).plugins, {});
});

test('a source that becomes a plugin later (Slack) is offered once to lists from before', async () => {
  const p = paths();
  mkdirSync(join(p.registry, '..'), { recursive: true });
  // A list from before `offered`: School was offered then, and you removed it since.
  writeFileSync(p.registry, JSON.stringify({ plugins: {} }));
  assert.deepEqual(migrateBundled({ FLYT_SCHOOL_KEY: 'x', SLACK_TOKEN: 'xoxp-1' }, { paths: p }), ['slack']);
  assert.deepEqual(Object.keys(readRegistry(p.registry).plugins), ['slack']);
  removePlugin('slack', { paths: p });
  assert.deepEqual(migrateBundled({ SLACK_TOKEN: 'xoxp-1' }, { paths: p }), []);
});

test('every plugin in the catalog has its folder here, a valid manifest, a pin on its version, and loads', async () => {
  const p = paths();
  const cat = readCatalog();
  assert.deepEqual(cat.map((c) => c.name).sort(), ['confluence', 'flyt', 'grafana', 'slack', 'slack-mcp']);
  const reg = { plugins: {} };
  for (const c of cat) {
    const dir = bundledDir(c.name);
    assert.equal(dir, join(BUNDLED, c.folder));
    const m = readManifest(dir);
    // The pin is the version in the folder: tag v<version> when the repo is made.
    assert.equal(parseSpec(c.name).ref, `v${m.version}`, `${c.name}: the catalog pins v${m.version}`);
    assert.equal(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version, m.version);
    for (const f of ['README.md', 'LICENSE', 'test/core.mjs']) assert.ok(existsSync(join(dir, f)), `${c.folder}/${f}`);
    reg.plugins[c.name] = { from: c.name, kind: 'bundled', version: m.version, run: 'inside' };
  }
  // Added from its folder before it had a repo: still loads, and is listed as added.
  mkdirSync(dirname(p.registry), { recursive: true });
  writeFileSync(p.registry, JSON.stringify(reg));
  const { sources, errors } = await loadPlugins({ paths: p });
  assert.deepEqual(errors, []);
  assert.equal(sources.get('flyt').panel.title, 'School');
  assert.ok(treeHash(bundledDir('flyt')).startsWith('sha256-'));
  assert.deepEqual(listPlugins({ paths: p }).available, []);
});

test('a plugin added from its folder here moves to its own repo; once the folder is gone it says so', async () => {
  const p = paths(), here = tmp('bundled');
  mkdirSync(join(here, 'clearsky-weather'));
  writeFileSync(join(here, 'clearsky-weather', 'clearsky-plugin.json'), JSON.stringify({ name: 'weather', label: 'Weather' }));
  writeFileSync(join(here, 'clearsky-weather', 'source.mjs'), 'export default { fetch() { return {}; } };');
  // Its repo, with a release.
  const repo = tmp('repo');
  cpSync(join(here, 'clearsky-weather'), repo, { recursive: true });
  const g = (...a) => execFileSync('git', ['-C', repo, ...a], { env: gitEnv }).toString().trim();
  g('init', '-q'); g('add', '.'); g('commit', '-qm', 'one'); g('tag', 'v1.0.0');
  writeFileSync(join(here, 'catalog.json'), JSON.stringify({ plugins: [{ name: 'weather', aka: ['rain'], folder: 'clearsky-weather', from: `file://${repo}/.git#v1.0.0` }] }));
  mkdirSync(dirname(p.registry), { recursive: true });
  writeFileSync(p.registry, JSON.stringify({ plugins: { weather: { from: 'weather', kind: 'bundled', version: '0.0.0', run: 'inside' } } }));
  assert.deepEqual((await loadPlugins({ paths: p, bundled: here })).errors, []);
  await assert.rejects(updatePlugin('weather', { paths: p, bundled: here }), /repo of its own now: `clearsky add rain`/);
  // Gone from here: it tells you where it went.
  rmSync(join(here, 'clearsky-weather'), { recursive: true });
  assert.match((await loadPlugins({ paths: p, bundled: here })).errors[0], /lives in its own repo now/);
  assert.equal(listPlugins({ paths: p, bundled: here }).added[0].problem.includes('clearsky add rain'), true);
  // Adding it by name takes it from the repo, at the pin, in a sandbox of its own.
  const r = await addPlugin('rain', { paths: p, bundled: here });
  assert.deepEqual([r.kind, r.run, r.pin], ['git', 'sandbox', 'ref']);
  assert.equal(readRegistry(p.registry).plugins.weather.commit, g('rev-parse', 'HEAD'));
  assert.deepEqual(listPlugins({ paths: p, bundled: here }).available, []);
});

// ---------------------------------------------------------------- versions

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
// A plugin's repo with releases: `release(manifest, tag)` commits and tags one.
function pluginRepo() {
  const work = tmp('work'), bare = join(tmp('bare'), 'weather.git');
  const g = (...a) => execFileSync('git', ['-C', work, ...a], { env: gitEnv }).toString().trim();
  g('init', '-q', '-b', 'main');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  g('remote', 'add', 'origin', bare);
  const release = (manifest, tag) => {
    writeFileSync(join(work, 'clearsky-plugin.json'), JSON.stringify({ name: 'weather', clearsky: 1, ...manifest }));
    writeFileSync(join(work, 'source.mjs'), `export default { fetch() { return { v: ${JSON.stringify(manifest.version)} }; } };`);
    g('add', '.'); g('commit', '-q', '--allow-empty', '-m', manifest.version || 'x');
    if (tag) g('tag', '-f', '-a', tag, '-m', tag);
    g('push', '-q', '-f', 'origin', 'main', '--tags');
    return g('rev-parse', 'HEAD');
  };
  return { url: `file://${bare}`, release, g };
}

test('a source at another version is the same plugin; pins are read from the ref', () => {
  assert.deepEqual(parseSpec('https://git.example.com/team/tools.git/plugins/deploys#v1'), { kind: 'git', url: 'https://git.example.com/team/tools.git', sub: 'plugins/deploys', ref: 'v1', from: 'https://git.example.com/team/tools.git/plugins/deploys#v1' });
  assert.throws(() => parseSpec('https://git.example.com/team/tools.git/../x'), /outside the repo/);
  assert.equal(sourceKey('github:acme/weather#v1.0.0'), sourceKey('https://github.com/acme/weather.git#v2.0.0'));
  assert.notEqual(sourceKey('github:acme/weather/a'), sourceKey('github:acme/weather/b'));
  assert.equal(sourceKey('npm:@acme/w@1.0.0'), sourceKey('npm:@acme/w'));
  assert.equal(withRef('github:acme/weather/sub#v1', 'v2'), 'github:acme/weather/sub#v2');
  assert.equal(withRef('github:acme/weather#v1', ''), 'github:acme/weather');
  assert.equal(withRef('npm:@acme/w@1.0.0', '1.1.0'), 'npm:@acme/w@1.1.0');
  assert.throws(() => withRef('./here', 'v1'), /git or npm/);
  assert.equal(pinOf(parseSpec('github:a/b')), 'default');
  assert.equal(pinOf(parseSpec('github:a/b#v1.2.0')), 'ref');
  assert.equal(pinOf(parseSpec(`github:a/b#${'a'.repeat(40)}`)), 'commit');
  assert.equal(pinOf(parseSpec('npm:w@1.2.0')), 'version');
  assert.equal(pinOf(parseSpec('npm:w@^1.2.0')), 'range');
  assert.deepEqual(versionOf('v1.2'), [1, 2, 0]);
  assert.equal(versionOf('nightly'), null);
});

test('a private repo on github.com is fetched with your gh login, nothing else', () => {
  assert.deepEqual(ghCredential('https://github.com/acme/private.git', { has: () => true }), ['-c', 'credential.https://github.com.helper=!gh auth git-credential']);
  assert.deepEqual(ghCredential('https://github.com/acme/private.git', { has: () => false }), []);
  assert.deepEqual(ghCredential('https://git.example.com/acme/private.git', { has: () => true }), []);
});

test('tags, branches and the default branch, read without fetching code', async () => {
  const sha = (c) => c.repeat(40);
  const run = async () => ({ stdout: [`ref: refs/heads/main\tHEAD`, `${sha('a')}\tHEAD`, `${sha('a')}\trefs/heads/main`, `${sha('b')}\trefs/tags/v1.0.0`, `${sha('c')}\trefs/tags/v1.0.0^{}`, `${sha('d')}\trefs/tags/v1.1.0`].join('\n') });
  const r = await remoteRefs('https://example.com/x.git', { run });
  assert.deepEqual(r, { tags: { 'v1.0.0': sha('c'), 'v1.1.0': sha('d') }, heads: { main: sha('a') }, head: sha('a'), defaultBranch: 'main' });
});

test('pinned to a tag: stays there, newer tags are offered, a moved tag is called out', async () => {
  const p = paths(), repo = pluginRepo();
  const one = repo.release({ version: '1.0.0', hosts: ['api.example.com'] }, 'v1.0.0');
  const r = await addPlugin(`${repo.url}#v1.0.0`, { paths: p });
  assert.equal(r.commit, one);
  assert.equal(r.pin, 'ref');
  repo.release({ version: '1.1.0', hosts: ['api.example.com'] }, 'v1.1.0');
  let c = await checkPlugin('weather', { paths: p });
  assert.equal(c.pin, 'tag');
  assert.deepEqual(c.newer.map((x) => x.tag), ['v1.1.0']);
  assert.equal(c.newer[0].from, `${repo.url}#v1.1.0`);
  assert.equal(c.moved, false);
  // Update without a new pin fetches v1.0.0 again; nothing moves.
  assert.equal((await updatePlugin('weather', { paths: p })).commit, one);
  // Moving the pin: the same plugin at another tag.
  const moved = await updatePlugin('weather', { paths: p, to: 'v1.1.0' });
  assert.equal(moved.from, `${repo.url}#v1.1.0`);
  assert.equal(moved.version, '1.1.0');
  // Someone moves the v1.1.0 tag to other code: checking and updating both say so.
  repo.release({ version: '1.1.0', hosts: ['api.example.com'] }, 'v1.1.0');
  c = await checkPlugin('weather', { paths: p });
  assert.equal(c.moved, true);
  const prep = await preparePlugin(`${repo.url}#v1.1.0`, { paths: p });
  assert.match(prep.warning, /tag v1\.1\.0 now points to other code/);
  prep.discard();
});

test('following the branch: Update takes new commits, but not wider reach unseen', async () => {
  const p = paths(), repo = pluginRepo();
  repo.release({ version: '1.0.0', hosts: ['api.example.com'] });
  await addPlugin(repo.url, { paths: p });
  let c = await checkPlugin('weather', { paths: p });
  assert.equal(c.pin, 'default');
  assert.equal(c.behind, false);
  const two = repo.release({ version: '1.0.1', hosts: ['api.example.com'] });
  c = await checkPlugin('weather', { paths: p });
  assert.equal(c.behind, true);
  assert.equal(c.latest, two);
  assert.equal((await updatePlugin('weather', { paths: p })).commit, two);
  repo.release({ version: '1.1.0', hosts: ['api.example.com', 'tracker.example.net'] });
  await assert.rejects(updatePlugin('weather', { paths: p }), /also reaches tracker\.example\.net/);
  assert.equal(readRegistry(p.registry).plugins.weather.commit, two);
  assert.equal((await updatePlugin('weather', { paths: p, accept: true })).version, '1.1.0');
});

test('what a new version reaches that the old one didn\'t', () => {
  const was = parseManifest({ name: 'ww', hosts: ['a.example.com'], settings: { W_URL: { label: 'u' } } });
  assert.equal(reachChanges(was, was).wider, false);
  const c = reachChanges(was, parseManifest({ name: 'ww', hosts: ['a.example.com', 'b.example.com'], settings: { W_URL: { label: 'u' }, W_KEY: { label: 'k', secret: true } } }));
  assert.deepEqual([c.hosts, c.settings, c.wider], [['b.example.com'], ['W_KEY'], true]);
  assert.equal(reachChanges(was, parseManifest({ name: 'ww', hosts: ['a.example.com'], settings: { W_URL: {}, W_SITE: { label: 's' } } })).wider, false);
});
