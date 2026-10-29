// Things that need you, and desktop notifications when a new one turns up.

import { spawn, execFile } from 'node:child_process';

// One entry per thing that needs you now. `stamp` changes only when there's a new reason to
// tell you: a (re-)request, a status that moves to you, a new comment. Not on every update, or
// each push or comment on a PR you were once asked to review would notify you again.
export function attentionItems({ github, jiraMentions, slack } = {}) {
  const out = [];
  const ok = (s) => s && !s.error;
  if (ok(github)) {
    for (const p of github.reviewRequested || []) {
      out.push({ key: p.url, stamp: p.requestedAt || '', kind: 'review', title: `Review requested: ${p.repo}#${p.number}`, body: `${p.title} (${p.author})`, url: p.url });
    }
    for (const p of github.myPrs || []) {
      // Only when the ball moves to you, not on every update.
      if (p.status?.owner === 'me' && !p.draft) out.push({ key: p.url, stamp: p.status.label, kind: 'pr', title: `${p.status.label}: ${p.repo}#${p.number}`, body: p.title, url: p.url });
    }
    // GitHub search only says the thread changed, not that you were mentioned again: once per thread.
    for (const m of github.mentions || []) out.push({ key: m.url, stamp: '', kind: 'mention', title: `Mentioned in ${m.repo}#${m.number}`, body: m.title, url: m.url });
  }
  if (ok(jiraMentions)) {
    for (const t of jiraMentions.tickets || []) {
      out.push({ key: t.dismissKey, stamp: t.stamp, kind: 'mention', title: `${t.people.join(', ')} mentioned you in ${t.key}`, body: t.excerpt || t.summary, url: t.url });
    }
  }
  if (ok(slack)) for (const m of slack.mentions || []) out.push({ key: m.url, stamp: m.stamp, kind: 'mention', title: `${m.by} in ${m.channel}`, body: m.excerpt, url: m.url });
  return out.filter((x) => x.key);
}

// Compare with what was seen before: returns the updated map and the items that are new.
// The first run only records what's there, so you aren't flooded on start-up. Each key keeps
// its last few stamps, so a status that flips back and forth (CI failing, running, failing)
// doesn't tell you the same thing again. Entries from before this scheme (no `v`) are taken
// as seen, so changing what a stamp means doesn't re-send everything.
const STAMP_VERSION = 2;
export function diffAttention(items, seen, { dismissed = {}, muted = {}, first = false, now = new Date() } = {}) {
  const next = { ...seen };
  const fresh = [];
  for (const it of items) {
    const stamp = String(it.stamp ?? '');
    const prev = seen[it.key];
    if (prev && prev.stamp === stamp && prev.v === STAMP_VERSION) continue;
    const legacy = prev && prev.v !== STAMP_VERSION;
    const known = !legacy && (prev?.stamps || [prev?.stamp]).includes(stamp);
    next[it.key] = { stamp, v: STAMP_VERSION, stamps: [...new Set([stamp, ...(legacy ? [] : prev?.stamps || [])])].slice(0, 5), at: known || legacy ? prev.at : now.toISOString() };
    if (first || legacy || known || muted[it.key] || dismissed[it.key] === stamp) continue;
    fresh.push(it);
  }
  return { seen: next, fresh };
}

// A desktop notification through notify-send (libnotify), with an Open button.
export function desktopNotify(item, { bin = 'notify-send', open = 'xdg-open' } = {}) {
  return new Promise((resolve) => {
    let out = '';
    const child = spawn(bin, ['--app-name=Clearsky', '--icon=dialog-information', '-A', 'open=Open', '--', item.title, item.body || ''], { stdio: ['ignore', 'pipe', 'ignore'] });
    const timer = setTimeout(() => child.kill(), 15 * 6e4);
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => { clearTimeout(timer); resolve(false); });
    child.on('close', () => {
      clearTimeout(timer);
      if (out.trim() === 'open' && openable(item.url)) spawn(open, [item.url], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
      resolve(true);
    });
  });
}

// Desktop notifications straight over D-Bus with gdbus. Ubuntu's AppArmor profile for
// notify-send blocks the calls it needs to wait for a click, so its Open button did nothing.
// Here one long-running `gdbus monitor` hears the clicks (and the activation token GNOME sends
// with them, so the browser may come to the front on Wayland), and each item replaces its own
// earlier banner instead of stacking a second one.
const gv = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;
const PATH = ['--session', '--dest', 'org.freedesktop.Notifications', '--object-path', '/org/freedesktop/Notifications'];

export function notifyArgs(item, replaceId = 0) {
  return ['call', ...PATH, '--method', 'org.freedesktop.Notifications.Notify',
    gv('Clearsky'), `uint32 ${replaceId}`, gv('dialog-information'), gv(item.title), gv(item.body || ''),
    "['default', 'Open', 'open', 'Open']", '@a{sv} {}', 'int32 -1'];
}

export function parseSignal(line) {
  const m = line.match(/org\.freedesktop\.Notifications\.(ActionInvoked|ActivationToken|NotificationClosed) \(uint32 (\d+)(?:, '((?:[^'\\]|\\.)*)')?/);
  return m && { signal: m[1], id: Number(m[2]), value: m[3] ?? null };
}

const openable = (url) => /^https:\/\//.test(url || '') || /^http:\/\/(127\.0\.0\.1|localhost):\d+\//.test(url || '');

export class DbusNotifier {
  constructor({ bin = 'gdbus', open = 'xdg-open', run = spawn, call = execFile } = {}) {
    Object.assign(this, { bin, open, run, call, byId: new Map(), byKey: new Map(), tokens: new Map(), monitor: null });
  }
  start() {
    if (this.monitor) return;
    this.monitor = this.run(this.bin, ['monitor', ...PATH], { stdio: ['ignore', 'pipe', 'ignore'] });
    let buf = '';
    this.monitor.stdout.on('data', (d) => {
      buf += d;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const l of lines) this.onSignal(parseSignal(l));
    });
    this.monitor.on('error', () => {});
    this.monitor.on('close', () => { this.monitor = null; setTimeout(() => this.start(), 5000).unref?.(); });
  }
  onSignal(s) {
    if (!s) return;
    if (s.signal === 'ActivationToken') this.tokens.set(s.id, s.value);
    else if (s.signal === 'ActionInvoked') {
      const url = this.byId.get(s.id)?.url;
      if (openable(url)) {
        const env = { ...process.env, ...(this.tokens.get(s.id) && { XDG_ACTIVATION_TOKEN: this.tokens.get(s.id) }) };
        this.run(this.open, [url], { stdio: 'ignore', detached: true, env }).on('error', () => {}).unref?.();
      }
    } else if (s.signal === 'NotificationClosed') {
      // The click comes just before the close; give it a moment.
      setTimeout(() => { this.byId.delete(s.id); this.tokens.delete(s.id); }, 2000).unref?.();
    }
  }
  notify(item) {
    this.start();
    const replace = (item.key && this.byKey.get(item.key)) || 0;
    return new Promise((resolve) => {
      this.call(this.bin, notifyArgs(item, replace), { timeout: 10_000 }, (err, stdout) => {
        const id = Number(String(stdout || '').match(/uint32 (\d+)/)?.[1]);
        if (err || !id) return resolve(false);
        this.byId.set(id, { url: item.url, key: item.key });
        if (item.key) this.byKey.set(item.key, id);
        resolve(true);
      });
    });
  }
  stop() { this.monitor?.removeAllListeners('close'); this.monitor?.kill(); this.monitor = null; }
}
