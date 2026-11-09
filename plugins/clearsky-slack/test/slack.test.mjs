import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { fetchMentions, slackText } from '../lib/slack.mjs';
import { core } from './core.mjs';

const { sourceFromDir } = await core('lib/plugins.mjs');
const { hook } = await core('lib/sources.mjs');
const { pluginItems } = await core('lib/items.mjs');

const NOW = Date.parse('2026-11-08T10:00:00Z');
const ts = (h) => String((NOW - h * 36e5) / 1000);
function fakeSlack(seen) {
  return async (url, opts) => {
    seen.push({ url: String(url), auth: opts.headers.Authorization });
    const u = new URL(url);
    const body = u.pathname.endsWith('auth.test') ? { ok: true, user_id: 'U1', user: 'alex', team: 'Acme' }
      : { ok: true, messages: { matches: [
        { ts: ts(1), user: 'U2', username: 'anna', text: '<@U1> can you look at <#C1|deploys>?', channel: { name: 'payments' }, permalink: 'https://acme.slack.com/a/1' },
        { ts: ts(2), user: 'U1', username: 'alex', text: 'my own <@U1>', channel: { name: 'payments' }, permalink: 'https://acme.slack.com/a/2' },
        { ts: ts(30), user: 'U3', username: 'bob', text: 'ping <@U1>', channel: { is_im: true }, permalink: 'https://acme.slack.com/a/3' },
        { ts: ts(24 * 20), user: 'U3', username: 'bob', text: 'old <@U1>', channel: { is_im: true }, permalink: 'https://acme.slack.com/a/4' },
      ] } };
    return new Response(JSON.stringify(body), { status: 200 });
  };
}

test('mentions from Slack search: not your own, not older than the window', async () => {
  const seen = [];
  const d = await fetchMentions({ token: 'xoxp-t', api: 'https://slack.test/api', days: 14, now: NOW, fetchImpl: fakeSlack(seen) });
  assert.deepEqual(d.mentions.map((m) => [m.by, m.channel]), [['anna', '#payments'], ['bob', 'DM']]);
  assert.equal(d.mentions[0].excerpt, '@you can you look at #deploys?');
  assert.equal(seen[0].auth, 'Bearer xoxp-t');
  assert.match(decodeURIComponent(seen[1].url), /query=<@U1>[+ ]after:2026-10-24/);
  assert.equal(slackText('a &amp; <https://x.com|link>', 'U1'), 'a & link');
});

test('a lost token asks you to log in again', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ ok: false, error: 'invalid_auth' }));
  await assert.rejects(fetchMentions({ token: 'x', fetchImpl }), (e) => e.auth === true);
});

test('the plugin: rows that need you with Reply, reminders, plan tasks and a summary section', async () => {
  const s = await sourceFromDir(fileURLToPath(new URL('..', import.meta.url)));
  assert.equal(s.area, 'work');
  assert.equal(s.enabled({}), false);
  const data = { mentions: [{ channel: '#payments', by: 'anna', at: new Date(Date.now() - 36e5).toISOString(), url: 'https://acme.slack.com/a/1', stamp: '1', excerpt: 'hi' },
    { channel: 'DM', by: 'bob', at: new Date(Date.now() - 50 * 36e5).toISOString(), url: 'https://acme.slack.com/a/3', stamp: '3', excerpt: 'ping' }] };
  const rows = pluginItems(s, { ...data, items: hook(s, 'items', data) });
  assert.deepEqual(rows.map((r) => [r.kind, r.next.label, r.data.open]), [['mention', 'Reply', 'Open in Slack'], ['mention', 'Reply', 'Open in Slack']]);
  assert.deepEqual(hook(s, 'attention', data).map((a) => a.key), ['https://acme.slack.com/a/1', 'https://acme.slack.com/a/3']);
  assert.deepEqual(hook(s, 'plan', data).map((t) => t.title), ['Reply to anna in #payments'], 'only the last day');
  assert.equal(hook(s, 'markdown', data).lines.length, 2);
});
