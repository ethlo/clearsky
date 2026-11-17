import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mavenServers, serverHosts, sandboxSettingsXml, mavenSandbox, withSandboxProxy, pomHosts, forgetHosts, PROXY_TOKEN_ENV } from '../lib/maven.mjs';
import { mavenSettings, mavenExports } from '../lib/vm.mjs';
import { vmMaven } from '../bin/clearsky.mjs';
import { srtSettings } from '../lib/sandbox.mjs';

const XML = `<settings>
  <servers>
    <server><id>acme</id><username>alex</username><password>s3cret</password></server>
    <server><id>enc</id><username>alex</username><password>{AbC=}</password></server>
  </servers>
  <mirrors><mirror><id>acme</id><mirrorOf>*</mirrorOf><url>https://artifacts.acme.example/repo</url></mirror></mirrors>
</settings>`;

test('Maven logins become a header with a variable, without the password', () => {
  const s = mavenServers(XML);
  assert.deepEqual(s.map((x) => x.id), ['acme']);
  assert.deepEqual(serverHosts(XML, 'acme'), ['artifacts.acme.example']);
  const out = sandboxSettingsXml(XML, [{ ...s[0], env: 'CLEARSKY_M2_0' }]);
  assert.ok(!out.includes('s3cret'));
  assert.ok(!/<id>acme<\/id><username>/.test(out));
  assert.match(out, /<value>Basic \$\{env\.CLEARSKY_M2_0\}<\/value>/);
  assert.match(out, /<password>\{AbC=\}<\/password>/);
});

test('the sandbox gets the copy; srt adds the login only for the repository host', () => {
  const home = mkdtempSync(join(tmpdir(), 'm2-'));
  mkdirSync(join(home, '.m2'));
  writeFileSync(join(home, '.m2', 'settings.xml'), XML);
  const ran = [];
  const run = (cmd, args) => { ran.push(cmd); const i = args.indexOf('-out'); if (i >= 0) { writeFileSync(args[i + 1], 'cert'); writeFileSync(args[args.indexOf('-keyout') + 1], 'key'); } const k = args.indexOf('-keystore'); if (k >= 0) writeFileSync(args[k + 1], 'p12'); };
  const m = mavenSandbox({ home, out: join(home, 'out'), keep: join(home, 'keep'), run });
  assert.equal(Buffer.from(m.env.CLEARSKY_M2_0, 'base64').toString(), 'alex:s3cret');
  assert.ok(!readFileSync(m.settings, 'utf8').includes('s3cret'));
  assert.ok(existsSync(m.trust) && ran.includes('openssl'));
  const r = srtSettings({ cwd: join(home, 'w'), home, maven: m, exists: () => true });
  assert.ok(r.network.allowedDomains.includes('artifacts.acme.example'));
  assert.ok(!r.network.tlsTerminate.excludeDomains.includes('artifacts.acme.example'));
  assert.ok(r.network.tlsTerminate.excludeDomains.includes('github.com'));
  assert.deepEqual(r.credentials.envVars, [{ name: 'CLEARSKY_M2_0', mode: 'mask', injectHosts: ['artifacts.acme.example'] }]);
});

test('settings with no plain login still get a copy for the sandbox, without secrets', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const home = mkdtempSync(join(tmpdir(), 'cs-m2-'));
  mkdirSync(join(home, '.m2'));
  writeFileSync(join(home, '.m2', 'settings.xml'), '<settings><servers><server><id>x</id><username>u</username><password>{ENC}</password></server></servers><mirrors><mirror><id>m</id><url>https://repo.example.com</url></mirror></mirrors></settings>');
  const m = mavenSandbox({ home, out: join(home, 'out'), keep: join(home, 'keep'), run: () => {} });
  assert.deepEqual(m.credentials, []);
  const copy = readFileSync(m.settings, 'utf8');
  assert.ok(!copy.includes('<password>') && copy.includes('repo.example.com'));
});

test("Maven in the sandbox goes through srt's proxy with its login, not a proxy of yours", () => {
  const mine = '<settings>\n  <proxies><proxy><id>office</id><host>proxy.example.org</host><port>8080</port></proxy></proxies>\n  <localRepository>/r</localRepository>\n</settings>\n';
  const out = withSandboxProxy(mine, { port: 3128 });
  assert.ok(!out.includes('proxy.example.org'));
  assert.equal(out.match(/<proxies>/g).length, 1);
  assert.match(out, /<host>localhost<\/host><port>3128<\/port><username>srt<\/username><password>\$\{env\.CLEARSKY_PROXY_TOKEN\}<\/password>/);
  assert.equal(PROXY_TOKEN_ENV, 'CLEARSKY_PROXY_TOKEN');
  assert.match(out, /<localRepository>\/r<\/localRepository>/);
  assert.match(out, /<\/proxies>\n<\/settings>\n$/);
  // The same again (a second chat) leaves one proxy.
  assert.equal(withSandboxProxy(out, { port: 3128 }), out);
  // No settings of yours, or an empty one; a proxy without a login.
  assert.match(withSandboxProxy('', { port: 9 }), /^<settings>\n  <proxies>.*<port>9<\/port><username>srt<\/username>/);
  assert.ok(!withSandboxProxy('', { port: 9, token: false }).includes('<password>'));
  assert.match(withSandboxProxy('<settings xmlns="x"/>', { port: 9 }), /^<settings xmlns="x">\n  <proxies>[\s\S]*<\/settings>$/);
  // Something after the root element: your settings stay, and so does it.
  const tail = withSandboxProxy('<settings><localRepository>/r</localRepository></settings><!-- managed -->\n', { port: 9 });
  assert.match(tail, /<localRepository>\/r<\/localRepository>\n  <proxies>[\s\S]*<\/proxies>\n<\/settings><!-- managed -->\n$/);
});

test("the copy with logins also gets srt's proxy, still without the password", () => {
  const home = mkdtempSync(join(tmpdir(), 'm2-'));
  mkdirSync(join(home, '.m2'));
  writeFileSync(join(home, '.m2', 'settings.xml'), XML);
  const run = (cmd, args) => { const i = args.indexOf('-out'); if (i >= 0) { writeFileSync(args[i + 1], 'cert'); writeFileSync(args[args.indexOf('-keyout') + 1], 'key'); } const k = args.indexOf('-keystore'); if (k >= 0) writeFileSync(args[k + 1], 'p12'); };
  const m = mavenSandbox({ home, out: join(home, 'out'), keep: join(home, 'keep'), run });
  assert.match(m.javaOptions, /-Djavax\.net\.ssl\.trustStore=/);
  const copy = withSandboxProxy(readFileSync(m.settings, 'utf8'), { port: 3128 });
  assert.ok(!copy.includes('s3cret') && copy.includes('CLEARSKY_M2_0') && copy.includes('clearsky-sandbox'));
});

// The recurring one: settings.xml has only the login (under the repository's id) and the project's
// pom names the repository. Then the sandbox had no login, the host wasn't allowed (the host door
// asked), and the VM's Maven had nothing but the proxy.
const LOGIN_ONLY = `<settings>
  <localRepository>/var/cache/m2/repository</localRepository>
  <servers><server><id>acme-releases</id><username>alex</username><password>\${env.ACME_PW}</password></server></servers>
  <mirrors><mirror><id>central-mirror</id><mirrorOf>central</mirrorOf><url>https://mirror.example.net/maven2</url></mirror></mirrors>
</settings>`;
const POM = `<project><repositories><repository><id>acme-releases</id><url>https://artifacts.acme.example/releases</url></repository></repositories>
  <distributionManagement><snapshotRepository><id>acme-snapshots</id><url>https://snapshots.acme.example/s</url></snapshotRepository></distributionManagement></project>`;
const fakeRun = (cmd, args) => { const i = args.indexOf('-out'); if (i >= 0) { writeFileSync(args[i + 1], 'cert'); writeFileSync(args[args.indexOf('-keyout') + 1], 'key'); } const k = args.indexOf('-keystore'); if (k >= 0) writeFileSync(args[k + 1], 'p12'); };
function loginOnlyHome() {
  forgetHosts();
  const home = mkdtempSync(join(tmpdir(), 'm2-'));
  mkdirSync(join(home, '.m2'));
  writeFileSync(join(home, '.m2', 'settings.xml'), LOGIN_ONLY);
  const repo = join(home, 'repo');
  mkdirSync(join(repo, 'module', 'target'), { recursive: true });
  writeFileSync(join(repo, 'module', 'pom.xml'), POM);
  writeFileSync(join(repo, 'module', 'target', 'pom.xml'), POM.replace(/artifacts\.acme\.example/g, 'stale.example'));
  return { home, repo };
}

test("a login whose repository is in the project's pom gets its host (allowed, read, login added)", () => {
  const { home, repo } = loginOnlyHome();
  assert.deepEqual(pomHosts([repo]).get('acme-releases'), ['artifacts.acme.example']);
  const m = mavenSandbox({ home, out: join(home, 'out'), keep: join(home, 'keep'), run: fakeRun, dirs: [repo], env: { ACME_PW: 'pw' } });
  assert.deepEqual(m.hosts, ['artifacts.acme.example']);
  assert.deepEqual(m.unmatched, []);
  // ${env.…} in the login is what Maven would send.
  assert.equal(Buffer.from(m.env.CLEARSKY_M2_0, 'base64').toString(), 'alex:pw');
  const r = srtSettings({ cwd: repo, home, maven: m, exists: () => true });
  assert.ok(r.network.allowedDomains.includes('artifacts.acme.example'));
  assert.ok(!r.network.tlsTerminate.excludeDomains.includes('artifacts.acme.example'));
  assert.deepEqual(r.credentials.envVars, [{ name: 'CLEARSKY_M2_0', mode: 'mask', injectHosts: ['artifacts.acme.example'] }]);
  // A chat started elsewhere later keeps that host (srt has one config for all chats).
  const again = mavenSandbox({ home, out: join(home, 'out'), keep: join(home, 'keep'), run: fakeRun, dirs: [join(home, 'elsewhere')] });
  assert.deepEqual(again.hosts, ['artifacts.acme.example']);
});

test('a login with no host anywhere is reported, not silently dropped', () => {
  const { home } = loginOnlyHome();
  const m = mavenSandbox({ home, out: join(home, 'out'), keep: join(home, 'keep'), run: fakeRun });
  assert.deepEqual(m.unmatched, ['acme-releases']);
  assert.deepEqual(m.credentials, []);
});

test("the VM's Maven gets your settings with the logins, the VM's proxy and the settings in MAVEN_ARGS", () => {
  const { home, repo } = loginOnlyHome();
  const m = mavenSandbox({ home, out: join(home, 'out'), keep: join(home, 'keep'), run: fakeRun, dirs: [repo], env: { ACME_PW: 'pw' } });
  // As the sandbox's copy is after Clearsky added srt's proxy to it.
  writeFileSync(m.settings, withSandboxProxy(readFileSync(m.settings, 'utf8'), { port: 3128 }));
  const masked = (creds) => Object.fromEntries(creds.map((c) => [c.name, `fake_value_${c.name}`]));
  const v = vmMaven(m, { masked });
  assert.deepEqual(v.env, { CLEARSKY_M2_0: 'fake_value_CLEARSKY_M2_0' });
  assert.equal(String(v.trust), 'p12');
  const xml = mavenSettings({ port: 1, url: 'http://' }, v.xml);
  // The login as a header with the variable, never the password; the mirror kept.
  assert.match(xml, /<id>acme-releases<\/id><configuration><httpHeaders><property><name>Authorization<\/name><value>Basic \$\{env\.CLEARSKY_M2_0\}<\/value>/);
  assert.ok(!xml.includes('pw') && !xml.includes('ACME_PW') && xml.includes('mirror.example.net'));
  // Only the VM's proxy (not the sandbox's), and not this machine's local repository path.
  assert.equal(xml.match(/<proxy>/g).length, 1);
  assert.match(xml, /<host>10\.0\.2\.100<\/host><port>3128<\/port><nonProxyHosts>/);
  assert.ok(!xml.includes('CLEARSKY_PROXY_TOKEN') && !xml.includes('<localRepository>'));
  // The command: settings named in MAVEN_ARGS, the stand-ins, and the CA trusted.
  const ex = mavenExports({ env: { ...v.env, PATH: '/x', CLEARSKY_M2_1: '' }, trust: true });
  assert.match(ex, /MAVEN_ARGS="\$\{MAVEN_ARGS:\+\$MAVEN_ARGS \}--settings \/home\/clearsky\/\.m2\/settings\.xml -Dmaven\.repo\.local\.tail=\/host\/m2"/);
  assert.match(ex, / CLEARSKY_M2_0='fake_value_CLEARSKY_M2_0'/);
  assert.ok(!ex.includes('PATH=') && !ex.includes('CLEARSKY_M2_1'));
  assert.match(ex, /MAVEN_OPTS="[^"]*-Djavax\.net\.ssl\.trustStore=\/home\/clearsky\/\.m2\/clearsky-truststore\.p12/);
  assert.doesNotMatch(mavenExports({}), /MAVEN_OPTS|CLEARSKY_M2/);
  // No settings of yours: the VM still gets one, with just the proxy.
  assert.equal(vmMaven(null), null);
  assert.match(mavenSettings({ port: 1, url: 'http://' }), /^<settings>\n  <proxies>/);
});
