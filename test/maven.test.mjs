import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mavenServers, serverHosts, sandboxSettingsXml, mavenSandbox } from '../lib/maven.mjs';
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
