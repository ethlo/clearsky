// Things that need you, and desktop notifications when a new one turns up.

import { spawn } from 'node:child_process';

// One entry per thing that needs you now. `stamp` changes when there's something new on it.
export function attentionItems({ github, jiraMentions, slack } = {}) {
  const out = [];
  const ok = (s) => s && !s.error;
  if (ok(github)) {
    for (const p of github.reviewRequested || []) {
      out.push({ key: p.url, stamp: p.stamp, kind: 'review', title: `Review requested: ${p.repo}#${p.number}`, body: `${p.title} (${p.author})`, url: p.url });
    }
    for (const p of github.myPrs || []) {
      // Only when the ball moves to you, not on every update.
      if (p.status?.owner === 'me' && !p.draft) out.push({ key: p.url, stamp: p.status.label, kind: 'pr', title: `${p.status.label}: ${p.repo}#${p.number}`, body: p.title, url: p.url });
    }
    for (const m of github.mentions || []) out.push({ key: m.url, stamp: m.stamp, kind: 'mention', title: `Mentioned in ${m.repo}#${m.number}`, body: m.title, url: m.url });
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
// The first run only records what's there, so you aren't flooded on start-up.
export function diffAttention(items, seen, { dismissed = {}, muted = {}, first = false, now = new Date() } = {}) {
  const next = { ...seen };
  const fresh = [];
  for (const it of items) {
    const prev = seen[it.key];
    if (prev && prev.stamp === String(it.stamp ?? '')) continue;
    next[it.key] = { stamp: String(it.stamp ?? ''), at: now.toISOString() };
    if (first || muted[it.key] || dismissed[it.key] === String(it.stamp ?? '')) continue;
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
      if (out.trim() === 'open' && /^https:\/\//.test(item.url || '')) spawn(open, [item.url], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
      resolve(true);
    });
  });
}
