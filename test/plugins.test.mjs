import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { parseManifest, parseSpec, addPlugin, removePlugin, listPlugins, loadPlugins, migrateBundled, readRegistry, fetchPlugin, readManifest, codeDir, BUNDLED, treeHash } from '../lib/plugins.mjs';
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
});

test('where a plugin comes from', () => {
  assert.deepEqual(parseSpec('github:someone/clearsky-weather'), { kind: 'git', url: 'https://github.com/someone/clearsky-weather.git', sub: '', ref: null, from: 'github:someone/clearsky-weather' });
  assert.deepEqual(parseSpec('github:someone/plugins/weather#v1.2'), { kind: 'git', url: 'https://github.com/someone/plugins.git', sub: 'weather', ref: 'v1.2', from: 'github:someone/plugins/weather#v1.2' });
  assert.equal(parseSpec('https://git.example.com/me/plug.git#main').ref, 'main');
  assert.equal(parseSpec('git@example.com:me/plug.git').kind, 'git');
  assert.deepEqual(parseSpec('npm:@acme/clearsky-weather@1.2.0'), { kind: 'npm', pkg: '@acme/clearsky-weather@1.2.0', from: 'npm:@acme/clearsky-weather@1.2.0' });
  assert.equal(parseSpec('./here').kind, 'folder');
  assert.equal(parseSpec('flyt').kind, 'bundled');
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

test('every plugin that ships with Clearsky has a valid manifest and loads', async () => {
  const p = paths();
  for (const n of readdirSync(BUNDLED)) {
    await addPlugin(n, { paths: p });
    assert.ok(readFileSync(join(BUNDLED, n, 'clearsky-plugin.json'), 'utf8'));
  }
  const { sources, errors } = await loadPlugins({ paths: p });
  assert.deepEqual(errors, []);
  assert.equal(sources.get('flyt').panel.title, 'School');
  assert.ok(treeHash(join(BUNDLED, 'flyt')).startsWith('sha256-'));
});
