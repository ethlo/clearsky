// The only way out for Copilot's container: an HTTP proxy that lets through only the hosts on
// its list (GitHub, Copilot, your Jira, your build's package repositories, and the hosts in
// Settings → Copilot). Copilot's container is on a network with no route out; this proxy is on
// both. Like srt's filter it goes by host name: an allowed host can be written to as well as read.

import { createServer, connect } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_DOMAINS } from './sandbox.mjs';

// What builds fetch from, besides what Settings and your Maven settings name.
export const BUILD_DOMAINS = ['repo.maven.apache.org', 'repo1.maven.org', 'plugins.gradle.org', 'services.gradle.org', 'downloads.gradle.org', 'registry.npmjs.org'];

export function allowed(host, list) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  return list.some((d) => {
    const p = d.toLowerCase();
    return p.startsWith('*.') ? h.endsWith(p.slice(1)) && h.length > p.length - 1 : h === p;
  });
}

// Hosts your Maven settings fetch from (mirrors, repositories), so a company repository works.
export function mavenHosts(home) {
  let xml = '';
  try { xml = readFileSync(join(home, '.m2', 'settings.xml'), 'utf8'); } catch { return []; }
  return [...new Set([...xml.matchAll(/<url>\s*https?:\/\/([^/:<\s]+)/g)].map((m) => m[1].toLowerCase()))];
}

export function egressList({ extra = [], home }) {
  return [...new Set([...DEFAULT_DOMAINS, ...BUILD_DOMAINS, ...mavenHosts(home), ...extra])];
}

// CONNECT host:port for https, and plain http requests by absolute URL.
export function serveEgress({ port = 3128, host = '0.0.0.0', list, log = () => {} }) {
  const server = createServer((client) => {
    client.once('data', (first) => {
      const head = first.toString('latin1');
      const line = head.slice(0, head.indexOf('\r\n'));
      const [method, target] = line.split(' ');
      let dest, destPort, rest = null;
      if (method === 'CONNECT') {
        [dest, destPort] = target.split(':');
        destPort = Number(destPort) || 443;
      } else {
        try { const u = new URL(target); dest = u.hostname; destPort = Number(u.port) || 80; rest = first; } catch { return client.end('HTTP/1.1 400 Bad Request\r\n\r\n'); }
      }
      if (!allowed(dest, list) || ![80, 443].includes(destPort)) {
        log(`egress: blocked ${dest}:${destPort}`);
        return client.end(`HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\n\r\n${dest} is not on Copilot's list of hosts (Settings → Copilot).\n`);
      }
      const upstream = connect(destPort, dest, () => {
        if (rest) upstream.write(rest); else client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        client.pipe(upstream).pipe(client);
      });
      upstream.on('error', () => client.destroy());
      client.on('error', () => upstream.destroy());
    });
  });
  server.listen(port, host);
  return server;
}
