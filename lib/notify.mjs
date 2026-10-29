// Things that need you, and desktop notifications when a new one turns up.

import { spawn } from 'node:child_process';

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
      if (out.trim() === 'open' && /^https:\/\//.test(item.url || '')) spawn(open, [item.url], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
      resolve(true);
    });
  });
}
