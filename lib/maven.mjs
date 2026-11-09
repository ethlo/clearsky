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
  mkdirSync(out, { recursive: true, mode: 0o700 });
  // No login to add on the way out: still a copy (Maven won't run when it can't read your
  // settings, and the sandbox can't), with any secret in it taken out.
  if (!servers.length) return plainMaven(xml, out);
  mkdirSync(keep, { recursive: true, mode: 0o700 });
  const settings = join(out, 'maven-settings.xml');
  writeFileSync(settings, sandboxSettingsXml(xml, servers), { mode: 0o600 });
  const ca = sandboxCa(keep, run);
  const trust = join(out, 'maven-truststore.p12');
  if (!existsSync(trust) || statSync(trust).mtimeMs < statSync(ca.cert).mtimeMs) buildTrustStore(trust, ca.cert, run);
  return {
    settings, trust, ca, hosts: [...new Set(servers.flatMap((s) => s.hosts))],
    env: Object.fromEntries(servers.map((s) => [s.env, Buffer.from(`${s.username}:${s.password}`).toString('base64')])),
    credentials: servers.map((s) => ({ name: s.env, mode: 'mask', injectHosts: s.hosts })),
    // In MAVEN_OPTS, not JAVA_TOOL_OPTIONS: srt sets that one itself in the sandbox (its proxy agent).
    javaOptions: `-Djavax.net.ssl.trustStore=${trust} -Djavax.net.ssl.trustStorePassword=changeit -Djavax.net.ssl.trustStoreType=PKCS12`,
  };
}

// Your settings without secrets: passwords, passphrases and private keys removed; mirrors,
// profiles, the local repository and the rest kept.
export const stripSecrets = (xml) => xml.replace(/\s*<(password|passphrase|privateKey)>[\s\S]*?<\/\1>/g, '');
export function plainMaven(xml, out) {
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const settings = join(out, 'maven-settings.xml');
  writeFileSync(settings, stripSecrets(xml), { mode: 0o600 });
  return { settings, trust: null, ca: null, hosts: [], env: {}, credentials: [], javaOptions: '' };
}

// srt's proxy wants its own login (a token in HTTPS_PROXY), and Maven doesn't take a proxy from
// there: the native transport ignores Java's proxy settings and goes direct (no way out of the
// sandbox), and Wagon (Maven 3.8 and older) uses them without the login, so the proxy answers 407
// before it ever looks at the host. Either way the host door never gets to ask. So the copy for
// the sandbox names the proxy itself, with the token from a variable (it stays off the disk). Any
// proxy of your own is left out: inside, the only way out is srt's proxy, which goes on to yours.
export const PROXY_TOKEN_ENV = 'CLEARSKY_PROXY_TOKEN';
export function withSandboxProxy(xml, { host = 'localhost', port, token = true }) {
  const login = token ? `<username>srt</username><password>\${env.${PROXY_TOKEN_ENV}}</password>` : '';
  const proxies = `<proxies><proxy><id>clearsky-sandbox</id><active>true</active><protocol>http</protocol><host>${host}</host><port>${port}</port>${login}<nonProxyHosts>localhost|127.0.0.1</nonProxyHosts></proxy></proxies>`;
  const rest = String(xml || '').replace(/\s*<proxies\s*\/>/g, '').replace(/\s*<proxies>[\s\S]*?<\/proxies>/g, '');
  // Into your root element, keeping whatever follows it (a comment, say).
  const end = rest.lastIndexOf('</settings>');
  if (end >= 0) return `${rest.slice(0, end).replace(/\s*$/, '')}\n  ${proxies}\n${rest.slice(end)}`;
  if (/<settings\b[^>]*\/>/.test(rest)) return rest.replace(/<settings\b([^>]*?)\s*\/>/, `<settings$1>\n  ${proxies}\n</settings>`);
  return `<settings>\n  ${proxies}\n</settings>\n`;
}

// The CA srt's proxy signs with when it reads HTTPS to add a login (Maven's, GitHub's). Its key
// stays in `keep`, a folder the sandbox can't read.
export function sandboxCa(keep, run = execFileSync) {
  mkdirSync(keep, { recursive: true, mode: 0o700 });
  const ca = { cert: join(keep, 'ca.pem'), key: join(keep, 'ca.key') };
  if (!existsSync(ca.cert) || !existsSync(ca.key)) {
    run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', ca.key, '-out', ca.cert, '-days', '3650', '-subj', '/CN=Clearsky sandbox',
      '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign'], { stdio: 'ignore' });
  }
  return ca;
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
