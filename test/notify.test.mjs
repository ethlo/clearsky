import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { attentionItems, diffAttention, desktopNotify, DbusNotifier, notifyArgs, parseSignal } from '../lib/notify.mjs';

const data = {
  github: {
    reviewRequested: [{ url: 'https://github.com/acme/api/pull/7', stamp: 'u1', requestedAt: 's1', repo: 'acme/api', number: 7, title: 'Fix', author: 'anna' }],
    myPrs: [
      { url: 'https://github.com/acme/api/pull/1', repo: 'acme/api', number: 1, title: 'Mine', status: { owner: 'me', label: 'Changes requested' } },
      { url: 'https://github.com/acme/api/pull/2', repo: 'acme/api', number: 2, title: 'Waiting', status: { owner: 'others', label: 'Waiting for review' } },
    ],
    mentions: [],
  },
  jiraMentions: { tickets: [{ dismissKey: 'jira-mention:OPS-2', stamp: 'c9', key: 'OPS-2', people: ['Anna'], excerpt: 'can you check?', url: 'https://x.atlassian.net/browse/OPS-2' }] },
  slack: { error: 'not configured' },
};

test('only things that need you count, and only new ones notify', () => {
  const items = attentionItems(data);
  assert.deepEqual(items.map((i) => i.kind), ['review', 'pr', 'mention'], 'PRs waiting on others are not your move');

  // First run: remember everything, notify nothing.
  let r = diffAttention(items, {}, { first: true });
  assert.equal(r.fresh.length, 0);
  assert.equal(Object.keys(r.seen).length, 3);

  // A new comment on the Jira ticket, a re-requested review that you dismissed, and a muted PR.
  const later = attentionItems({ ...data, jiraMentions: { tickets: [{ ...data.jiraMentions.tickets[0], stamp: 'c10' }] },
    github: { ...data.github, reviewRequested: [{ ...data.github.reviewRequested[0], requestedAt: 's2' }],
      myPrs: [{ ...data.github.myPrs[0], status: { owner: 'me', label: 'Merge conflict' } }] } });
  r = diffAttention(later, r.seen, { dismissed: { 'https://github.com/acme/api/pull/7': 's2' }, muted: { 'https://github.com/acme/api/pull/1': '2099-01-01' } });
  assert.deepEqual(r.fresh.map((i) => i.key), ['jira-mention:OPS-2']);
  // Nothing changed: nothing new.
  assert.equal(diffAttention(later, r.seen).fresh.length, 0);
});

test('a busy PR or a flapping status does not notify again and again', () => {
  const pr = (o) => ({ github: { ...data.github, ...o } });
  let r = diffAttention(attentionItems(data), {}, { first: true });
  // Pushes and comments on a PR you were asked to review, or on a thread you were mentioned in.
  const busy = attentionItems(pr({ reviewRequested: [{ ...data.github.reviewRequested[0], stamp: 'u2' }],
    mentions: [{ url: 'https://github.com/acme/web/issues/3', stamp: 'u1', repo: 'acme/web', number: 3, title: 'Help' }] }));
  r = diffAttention(busy, r.seen);
  assert.deepEqual(r.fresh.map((i) => i.kind), ['mention'], 'the mention once, the busy review not at all');
  const busier = attentionItems(pr({ mentions: [{ url: 'https://github.com/acme/web/issues/3', stamp: 'u9', repo: 'acme/web', number: 3, title: 'Help' }] }));
  assert.equal(diffAttention(busier, r.seen).fresh.length, 0);
  // CI failing, then fixed (waiting on others), then failing again: told once.
  const mine = (label, owner = 'me') => attentionItems(pr({ myPrs: [{ ...data.github.myPrs[0], status: { owner, label } }] }));
  r = diffAttention(mine('CI failing'), r.seen);
  assert.equal(r.fresh.length, 1);
  r = diffAttention(mine('Waiting for review', 'others'), r.seen);
  r = diffAttention(mine('CI failing'), r.seen);
  assert.equal(r.fresh.length, 0);
});

test('items seen before the stamps changed meaning are not sent again', () => {
  const old = { 'https://github.com/acme/api/pull/7': { stamp: 'u1', at: '2026-10-29T08:00:00Z' } };
  const r = diffAttention(attentionItems(data).filter((i) => i.kind === 'review'), old);
  assert.equal(r.fresh.length, 0);
  assert.equal(r.seen['https://github.com/acme/api/pull/7'].at, '2026-10-29T08:00:00Z');
});

test('a desktop notification opens the item when you click Open', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'clearsky-notify-'));
  const ns = join(dir, 'notify-send'), open = join(dir, 'open'), log = join(dir, 'log');
  writeFileSync(ns, `#!/bin/sh\necho "$@" > ${log}.args\necho open\n`);
  writeFileSync(open, `#!/bin/sh\necho "$1" > ${log}\n`);
  chmodSync(ns, 0o755); chmodSync(open, 0o755);
  assert.equal(await desktopNotify({ title: 'Review requested', body: 'Fix', url: 'https://github.com/acme/api/pull/7' }, { bin: ns, open }), true);
  for (let i = 0; i < 20 && !existsSync(log); i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(readFileSync(log, 'utf8').trim(), 'https://github.com/acme/api/pull/7');
  assert.match(readFileSync(`${log}.args`, 'utf8'), /--app-name=Clearsky .*Review requested Fix/);
});

test('D-Bus banners: one per item, and clicking Open opens the link with the activation token', async () => {
  assert.deepEqual(notifyArgs({ title: "Anna's PR", body: 'a\nb' }, 7).slice(8, 14),
    ["'Clearsky'", 'uint32 7', "'dialog-information'", "'Anna\\'s PR'", "'a\\nb'", "['default', 'Open', 'open', 'Open']"]);
  assert.deepEqual(parseSignal("/org/freedesktop/Notifications: org.freedesktop.Notifications.ActionInvoked (uint32 12, 'open')"),
    { signal: 'ActionInvoked', id: 12, value: 'open' });
  assert.equal(parseSignal('something else'), null);

  const monitor = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), kill() {} });
  const calls = [], opened = [];
  let next = 40;
  const watched = [];
  const run = (bin, args, opts) => {
    if (args[0] === 'monitor') { watched.push(args[3]); return monitor; }
    opened.push({ url: args[0], token: opts.env.XDG_ACTIVATION_TOKEN });
    return Object.assign(new EventEmitter(), { unref() {} });
  };
  const call = (bin, args, opts, cb) => { calls.push(args); cb(null, `(uint32 ${next++},)\n`); };
  const n = new DbusNotifier({ run, call });

  assert.equal(await n.notify({ key: 'review:7', title: 'Review requested', url: 'https://github.com/acme/api/pull/7' }), true);
  assert.equal(await n.notify({ key: 'review:7', title: 'Review requested again', url: 'https://github.com/acme/api/pull/7' }), true);
  assert.equal(calls[0][9], 'uint32 0');
  assert.equal(calls[1][9], 'uint32 40', 'the second banner replaces the first');

  monitor.stdout.emit('data', "/org/freedesktop/Notifications: org.freedesktop.Notifications.ActivationToken (uint32 41, 'tok')\n/org/freedesktop/Notif");
  monitor.stdout.emit('data', "ications: org.freedesktop.Notifications.ActionInvoked (uint32 41, 'open')\n");
  assert.deepEqual(opened, [{ url: 'https://github.com/acme/api/pull/7', token: 'tok' }], 'heard by both watchers, opened once');
  assert.deepEqual(watched, ['org.freedesktop.Notifications', 'org.gnome.Shell'], 'GNOME 50 only passes clicks to the sender, but gnome-shell broadcasts them');

  await n.notify({ key: 'x', title: 'Bad link', url: 'file:///etc/passwd' });
  monitor.stdout.emit('data', "/org/freedesktop/Notifications: org.freedesktop.Notifications.ActionInvoked (uint32 42, 'open')\n");
  assert.equal(opened.length, 1, 'only web links open');
  n.stop();
});
