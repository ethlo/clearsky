import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { attentionItems, diffAttention, desktopNotify } from '../lib/notify.mjs';

const data = {
  github: {
    reviewRequested: [{ url: 'https://github.com/acme/api/pull/7', stamp: 's1', repo: 'acme/api', number: 7, title: 'Fix', author: 'anna' }],
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
    github: { ...data.github, reviewRequested: [{ ...data.github.reviewRequested[0], stamp: 's2' }],
      myPrs: [{ ...data.github.myPrs[0], status: { owner: 'me', label: 'Merge conflict' } }] } });
  r = diffAttention(later, r.seen, { dismissed: { 'https://github.com/acme/api/pull/7': 's2' }, muted: { 'https://github.com/acme/api/pull/1': '2099-01-01' } });
  assert.deepEqual(r.fresh.map((i) => i.key), ['jira-mention:OPS-2']);
  // Nothing changed: nothing new.
  assert.equal(diffAttention(later, r.seen).fresh.length, 0);
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
