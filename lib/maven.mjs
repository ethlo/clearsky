// Maven builds in the sandbox, with your repository logins kept out of it. Copilot's Maven gets
// a copy of ~/.m2/settings.xml whose servers send `Authorization: Basic ${env.CLEARSKY_M2_n}`
// instead of a username and password. srt masks those variables (the sandbox sees only a
// placeholder) and its proxy, outside the sandbox, swaps in the real value on requests to that
// server's hosts and nowhere else. That proxy has to read HTTPS to do so, so it presents
// certificates from Clearsky's own CA, which the sandbox's Java is told to trust.

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, rmSync, renameSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, delimiter } from 'node:path';

const tag = (block, name) => block.match(new RegExp(`<${name}>\\s*([\\s\\S]*?)\\s*</${name}>`))?.[1];
const blocks = (xml, name) => [...xml.matchAll(new RegExp(`<${name}>[\\s\\S]*?</${name}>`, 'g'))].map((m) => m[0]);
const host = (url) => { try { return new URL(url).hostname.toLowerCase(); } catch { return null; } };

// Servers with a plain username and password (an encrypted `{…}` password stays as it is).
export function mavenServers(xml) {
  return blocks(xml, 'server').map((b) => ({ id: tag(b, 'id'), username: tag(b, 'username'), password: tag(b, 'password') }))
    .filter((s) => s.id && s.username != null && s.password != null && !/^\{.*\}$/.test(s.password));
}

// Hosts a server id is used for: mirrors and repositories with that id in settings.xml.
export function serverHosts(xml, id) {
  const urls = ['mirror', 'repository', 'pluginRepository'].flatMap((n) => blocks(xml, n)).filter((b) => tag(b, 'id') === id).map((b) => host(tag(b, 'url')));
  return [...new Set(urls.filter(Boolean))];
}

// The copy for the sandbox: each server's login replaced by the header with a variable.
export function sandboxSettingsXml(xml, servers) {
  let i = 0;
  return xml.replace(/<server>[\s\S]*?<\/server>/g, (b) => {
    const n = servers.findIndex((s) => s.id === tag(b, 'id'));
    if (n < 0) return b;
    i++;
    const header = `<configuration><httpHeaders><property><name>Authorization</name><value>Basic \${env.${servers[n].env}}</value></property></httpHeaders></configuration>`;
    return b.replace(/\s*<username>[\s\S]*?<\/username>/, '').replace(/\s*<password>[\s\S]*?<\/password>/, '')
      .replace(/\s*<configuration>[\s\S]*?<\/configuration>/, '').replace(/<\/server>$/, `${header}</server>`);
  });
}

// Everything srt and the sandboxed Maven need, or null when there's no login to hide.
// `out`: a folder the sandbox can read (the settings copy and the trust store go there);
// `keep`: a folder it can't (the CA's key).
export function mavenSandbox({ home, out, keep, run = execFileSync }) {
  let xml;
  try { xml = readFileSync(join(home, '.m2', 'settings.xml'), 'utf8'); } catch { return null; }
  const servers = mavenServers(xml).map((s, i) => ({ ...s, env: `CLEARSKY_M2_${i}`, hosts: serverHosts(xml, s.id) })).filter((s) => s.hosts.length);
  if (!servers.length) return null;
  mkdirSync(out, { recursive: true, mode: 0o700 });
  mkdirSync(keep, { recursive: true, mode: 0o700 });
  const settings = join(out, 'maven-settings.xml');
  writeFileSync(settings, sandboxSettingsXml(xml, servers), { mode: 0o600 });
  const ca = { cert: join(keep, 'ca.pem'), key: join(keep, 'ca.key') };
  if (!existsSync(ca.cert) || !existsSync(ca.key)) {
    run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', ca.key, '-out', ca.cert, '-days', '3650', '-subj', '/CN=Clearsky sandbox',
      '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign'], { stdio: 'ignore' });
  }
  const trust = join(out, 'maven-truststore.p12');
  if (!existsSync(trust) || statSync(trust).mtimeMs < statSync(ca.cert).mtimeMs) buildTrustStore(trust, ca.cert, run);
  return {
    settings, trust, ca, hosts: [...new Set(servers.flatMap((s) => s.hosts))],
    env: Object.fromEntries(servers.map((s) => [s.env, Buffer.from(`${s.username}:${s.password}`).toString('base64')])),
    credentials: servers.map((s) => ({ name: s.env, mode: 'mask', injectHosts: s.hosts })),
    javaOptions: `-Djavax.net.ssl.trustStore=${trust} -Djavax.net.ssl.trustStorePassword=changeit -Djavax.net.ssl.trustStoreType=PKCS12`,
  };
}

// Java's own trusted roots plus Clearsky's CA (Java ignores the system's trust bundle).
function buildTrustStore(file, caCert, run) {
  const javaHome = findJavaHome();
  const keytool = javaHome && existsSync(join(javaHome, 'bin', 'keytool')) ? join(javaHome, 'bin', 'keytool') : 'keytool';
  const tmp = `${file}.new`;
  rmSync(tmp, { force: true });
  if (javaHome && existsSync(join(javaHome, 'lib', 'security', 'cacerts'))) {
    run(keytool, ['-importkeystore', '-noprompt', '-srckeystore', join(javaHome, 'lib', 'security', 'cacerts'), '-srcstorepass', 'changeit',
      '-destkeystore', tmp, '-deststoretype', 'PKCS12', '-deststorepass', 'changeit'], { stdio: 'ignore' });
  }
  run(keytool, ['-importcert', '-noprompt', '-alias', 'clearsky-sandbox', '-file', caCert, '-keystore', tmp, '-storetype', 'PKCS12', '-storepass', 'changeit'], { stdio: 'ignore' });
  renameSync(tmp, file);
}

function findJavaHome(env = process.env) {
  if (env.JAVA_HOME && existsSync(join(env.JAVA_HOME, 'bin', 'java'))) return env.JAVA_HOME;
  for (const d of (env.PATH || '').split(delimiter)) {
    if (d && existsSync(join(d, 'java'))) return dirname(dirname(realpathSync(join(d, 'java'))));
  }
  return null;
}
