// Is the work VPN on? Clearsky doesn't run your VPN (that takes root and your login); it only
// notices when hosts behind it can't be reached, so the page says "VPN off" and pauses what
// needs it instead of showing errors, and Copilot is told why a call failed.
//
// The check: VPN_CHECK (host or host:port, Settings), else the first Grafana environment's host.
// Up = its name resolves and a TCP connection opens within a few seconds.

import { lookup } from 'node:dns/promises';
import { connect } from 'node:net';

export function checkTarget(env = process.env, grafanaUrls = []) {
  const v = String(env.VPN_CHECK || '').trim();
  if (v) {
    const m = v.match(/^(?:https?:\/\/)?([\w.-]+)(?::(\d+))?/);
    return m ? { host: m[1], port: Number(m[2]) || 443 } : null;
  }
  const u = grafanaUrls.map((x) => { try { return new URL(x); } catch { return null; } }).find(Boolean);
  return u ? { host: u.hostname, port: Number(u.port) || (u.protocol === 'http:' ? 80 : 443) } : null;
}

export async function reachable({ host, port }, { timeoutMs = 4000, resolve = lookup, open = connect } = {}) {
  try { await resolve(host); } catch { return { up: false, why: `${host} doesn't resolve` }; }
  return new Promise((done) => {
    const s = open({ host, port, timeout: timeoutMs });
    const end = (r) => { s.destroy(); done(r); };
    s.once('connect', () => end({ up: true }));
    s.once('timeout', () => end({ up: false, why: `${host}:${port} didn't answer` }));
    s.once('error', (e) => end({ up: false, why: `${host}:${port}: ${e.code || e.message}` }));
  });
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
