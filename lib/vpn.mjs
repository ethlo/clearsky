// Is the work VPN on? Clearsky doesn't run your VPN (that takes root and your login); it only
// notices when hosts behind it can't be reached, so the page says "VPN off" and pauses what
// needs it instead of showing errors, and Copilot is told why a call failed.
//
// The check: VPN_CHECK (host, host:port or a URL, Settings), else the first Grafana environment.
// Up = its name resolves, a TCP connection opens, and (for web hosts) an HTTPS request isn't
// refused with 403. Many work hosts are reachable from anywhere and only refuse you at the
// load balancer when you're off the VPN, so a connection alone proves nothing.

import { lookup } from 'node:dns/promises';
import { connect } from 'node:net';

export function checkTarget(env = process.env, grafanaUrls = []) {
  const v = String(env.VPN_CHECK || '').trim();
  if (v) {
    const m = v.match(/^(https?:\/\/)?([\w.-]+)(?::(\d+))?(\/\S*)?/);
    if (!m) return null;
    const port = Number(m[3]) || (m[1] === 'http://' ? 80 : 443);
    const web = m[1] || port === 443 || port === 80;
    return { host: m[2], port, ...(web && { url: `${m[1] || (port === 80 ? 'http://' : 'https://')}${m[2]}${m[3] ? `:${m[3]}` : ''}${m[4] || '/'}` }) };
  }
  const u = grafanaUrls.map((x) => { try { return new URL(x); } catch { return null; } }).find(Boolean);
  return u ? { host: u.hostname, port: Number(u.port) || (u.protocol === 'http:' ? 80 : 443), url: `${u.origin}/api/health` } : null;
}

// What the host answers: 403 is the "not from here" refusal; anything else (even an error page
// or a TLS complaint) means the request reached it.
async function webAnswer(url, timeoutMs) {
  try {
    const r = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    r.body?.cancel().catch(() => {});
    return r.status;
  } catch (e) { return e.name === 'TimeoutError' ? 'timeout' : 'answered'; }
}

export async function reachable({ host, port, url }, { timeoutMs = 4000, resolve = lookup, open = connect, ask = webAnswer } = {}) {
  try { await resolve(host); } catch { return { up: false, why: `${host} doesn't resolve` }; }
  const tcp = await new Promise((done) => {
    const s = open({ host, port, timeout: timeoutMs });
    const end = (r) => { s.destroy(); done(r); };
    s.once('connect', () => end({ up: true }));
    s.once('timeout', () => end({ up: false, why: `${host}:${port} didn't answer` }));
    s.once('error', (e) => end({ up: false, why: `${host}:${port}: ${e.code || e.message}` }));
  });
  if (!tcp.up || !url) return tcp;
  const status = await ask(url, timeoutMs);
  if (status === 403) return { up: false, why: `${host} refuses you (403), as it does off the VPN` };
  if (status === 'timeout') return { up: false, why: `${host} didn't answer` };
  return { up: true };
}

// Keeps the latest state; check() at most every `everyMs` unless forced.
export function vpnWatch({ target, everyMs = 60_000, probe = reachable } = {}) {
  let state = { known: false, up: null, at: null, why: null, host: null }, pending = null;
  async function check(force = false) {
    const t = target();
    if (!t) { state = { known: false, up: null, at: null, why: null, host: null }; return state; }
    if (!force && state.at && Date.now() - Date.parse(state.at) < everyMs && state.host === t.host) return state;
    pending ||= probe(t).then((r) => { state = { known: true, up: r.up, at: new Date().toISOString(), why: r.why || null, host: t.host }; return state; }).finally(() => { pending = null; });
    return pending;
  }
  return { check, get state() { return state; } };
}
