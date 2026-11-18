// What needs you since you last looked: polled in the background, shown as desktop banners, with
// what you have read; and logins kept from running out.
import * as localState from '../state.mjs';
import { attentionItems, diffAttention, desktopNotify, DbusNotifier } from '../notify.mjs';
import { makeContext, hook, asList } from '../sources.mjs';
import { wslInfo } from '../wsl.mjs';
import { logEvent } from '../event-log.mjs';
import { stateFile, vpn, config, plugins, atLocalTime, isWorkday } from './config.mjs';
import { execFileP } from './services.mjs';
import { pluginData, source } from './work.mjs';

export const ATTENTION_SOURCES = ['github', 'jiraMentions'];
export const poller = { lastPoll: null, notifier: null, timer: null };

// Desktop banners come from notify-send when it's there; otherwise the open page shows them.
// Desktop banners go over D-Bus with gdbus (clicks work), else through notify-send, else the
// open page shows them. CLEARSKY_NOTIFY=notify-send forces the old way.
let dbusNotifier = null;
function hasNotifySend() {
  if (process.env.CLEARSKY_NOTIFY === 'off') return Promise.resolve('off');
  if (process.env.CLEARSKY_NOTIFY === 'browser') return Promise.resolve('browser');
  // WSL has no desktop of its own to show them on: the page in your Windows browser does.
  if (!process.env.CLEARSKY_NOTIFY && wslInfo()) return Promise.resolve('browser');
  const notifySend = () => execFileP(process.env.NOTIFY_SEND_BIN || 'notify-send', ['--version'], { timeout: 5000 }).then(() => 'desktop', () => 'browser');
  if (process.env.CLEARSKY_NOTIFY === 'notify-send' || process.env.NOTIFY_SEND_BIN) return notifySend();
  const bin = process.env.GDBUS_BIN || 'gdbus';
  return execFileP(bin, ['call', '--session', '--dest', 'org.freedesktop.Notifications', '--object-path', '/org/freedesktop/Notifications',
    '--method', 'org.freedesktop.Notifications.GetServerInformation'], { timeout: 5000 })
    .then(() => { dbusNotifier = new DbusNotifier({ bin }); dbusNotifier.start(); return 'desktop'; }, notifySend);
}
const sendBanner = (item) => (dbusNotifier ? dbusNotifier.notify(item) : desktopNotify(item, { bin: process.env.NOTIFY_SEND_BIN || 'notify-send' }));

// Banners only during working hours on workdays (07:00 until two hours after the workday ends).
function notifyNow(now = new Date()) {
  const end = atLocalTime(now, config.workdayEnd);
  return isWorkday(now) && now.getHours() >= 7 && +now < +end + 2 * 36e5;
}

export async function pollAttention(force = true) {
  // One poll at a time: two overlapping ones would both see the same item as new.
  if (poller.running) return poller.running;
  poller.running = pollOnce(force).finally(() => { poller.running = null; });
  return poller.running;
}

async function pollOnce(force) {
  const data = Object.fromEntries(await Promise.all(ATTENTION_SOURCES.map(async (n) => [n, await source(n, force)])));
  const items = [...attentionItems(data), ...await pluginAttention(force)];
  const before = localState.seen(stateFile);
  const { seen, fresh } = diffAttention(items, before, {
    dismissed: localState.dismissed(stateFile), muted: localState.muted(stateFile), first: !Object.keys(before).length,
    // A plugin you just added (or Slack, now a plugin) starts quiet too: what it already had isn't news.
    quiet: (it) => { const src = String(it.key).split(':')[0]; return plugins.sources.has(src) && !Object.keys(before).some((k) => k.startsWith(`${src}:`)); },
  });
  if (fresh.length || Object.keys(seen).length !== Object.keys(before).length) localState.setSeen(stateFile, seen);
  poller.lastPoll = new Date().toISOString();
  if (fresh.length && poller.notifier === 'desktop' && notifyNow()) {
    // More than two at once (say after the laptop wakes up) become one banner.
    if (fresh.length > 2) sendBanner({ key: 'clearsky:summary', title: `${fresh.length} new things need you`, body: fresh.slice(0, 4).map((x) => x.title).join('\n'), url: `http://127.0.0.1:${config.port}/` });
    else for (const it of fresh) sendBanner(it);
  }
  if (fresh.length) localState.logNotified(stateFile, fresh.map((x) => ({ key: x.key, kind: x.kind, stamp: String(x.stamp ?? ''), title: x.title, body: (x.body || '').slice(0, 200), url: x.url, at: new Date().toISOString(), via: poller.notifier, quiet: !notifyNow() })));
  return { items, seen, fresh };
}

export async function pluginAttention(force) {
  const extra = await pluginData(force);
  const reads = localState.readMarks(stateFile);
  return [...plugins.sources.values()].flatMap((p) => (extra[p.name]?.error || extra[p.name]?.disabled ? []
    : asList(hook(p, 'attention', extra[p.name])).filter((x) => x?.key && x.title).map((x) => ({ kind: p.name, ...x, key: `${p.name}:${x.key}` }))
      // Something you've read here doesn't need you, until there's something new on it.
      .filter((x) => !(x.at && reads[x.key] === String(x.at)))));
}

// A source's items with your read marks applied: `unread` is what's still unread to you,
// `unreadAtSource` what the source itself says.
export function withReads(name, data) {
  if (!plugins.sources.has(name) || !Array.isArray(data?.items)) return data;
  const reads = localState.readMarks(stateFile);
  return { ...data, items: data.items.map((i) => {
    if (!i?.unread) return i;
    const here = i.at != null && reads[`${name}:${i.key}`] === String(i.at);
    return { ...i, unreadAtSource: true, unread: !here, readHere: here };
  }) };
}

// Every CLEARSKY_POLL_MINUTES (3), read again each round so a change in Settings applies at once.
export function startPolling() {
  hasNotifySend().then((n) => { poller.notifier = n; });
  const next = (ms) => { clearTimeout(poller.timer); poller.timer = setTimeout(tick, ms); poller.timer.unref?.(); };
  const tick = () => pollAttention(true).catch((e) => console.error(`clearsky: poll failed: ${e.message}`))
    .finally(() => next(Math.max(1, Number(process.env.CLEARSKY_POLL_MINUTES) || 3) * 6e4));
  next(2000);
}

// Sources with a web login (School) are touched now and then, at random times between 30 minutes
// and 2 hours apart, so their login doesn't run out while Clearsky sits unwatched.
export const keepAliveDelay = (rand = Math.random) => Math.round((30 + rand() * 90) * 6e4);
export function keepLoginsAlive() {
  for (const p of plugins.sources.values()) {
    if (typeof p.keepAlive !== 'function') continue;
    const next = () => setTimeout(async () => {
      if (!p.enabled || p.enabled(process.env)) {
        try { logEvent(`${p.label}: login kept alive (${await p.keepAlive({ ...makeContext(p), vpn: () => vpn.check() })})`, { echo: false }); }
        catch (e) { logEvent(`${p.label}: keeping the login alive failed: ${e.message}`, { echo: false }); }
      }
      next();
    }, keepAliveDelay()).unref?.();
    next();
  }
}
