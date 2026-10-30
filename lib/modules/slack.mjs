// Slack: messages that @mention you, through search.messages with your user token.

import { replyNext } from '../items.mjs';

// What this module holds and reaches (shown in Settings → Modules).
export const manifest = {
  name: 'slack', label: 'Slack', area: 'work',
  secrets: [{ key: 'SLACK_TOKEN', kind: 'token' }],
  hosts: ['slack.com'], clis: [], files: [],
};

export function slackText(text, me) {
  const plain = (text || '')
    .replaceAll(`<@${me}>`, '@you')
    .replace(/<@[A-Z0-9]+(?:\|([^>]+))?>/g, (_, name) => `@${name || 'someone'}`)
    .replace(/<#[A-Z0-9]+\|([^>]*)>/g, '#$1')
    .replace(/<!(here|channel|everyone)[^>]*>/g, '@$1')
    .replace(/<([^|>]+)\|([^>]+)>/g, '$2')
    .replace(/<([^>]+)>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > 220 ? `${plain.slice(0, 217)}...` : plain;
}

// Slack mentions as work items (see lib/items.mjs).
export function workItems(sl) {
  if (!sl || sl.error || sl.disabled) return [];
  return (sl.mentions || []).map((m) => ({ group: 'needs', kind: 'mention', src: 'Slack', k: m.url, url: m.url, stamp: m.stamp, ref: m.channel,
    title: `${m.by} in ${m.channel}`, step: m.excerpt, quote: m.excerpt, glyph: 'ment', label: ['Slack'], at: m.at, next: replyNext(m.url), data: m }));
}

// The parts that call Slack. `config.slack` holds the API address and token, `config.days` how far back.
export function createSlack({ config, http, daysAgoIso }) {
  async function slack(method, params = {}) {
    const url = new URL(`${config.slack.api}/${method}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await http(url, { headers: { Authorization: `Bearer ${config.slack.token}` } });
    if (!res.ok) throw new Error(`Slack ${method}: ${res.error}${res.needed ? ` (needs scope ${res.needed})` : ''}`);
    return res;
  }

  async function fetchSlack() {
    if (!config.slack.token) return { disabled: true };
    const auth = await slack('auth.test');
    const me = auth.user_id;
    // Slack's `after:` is exclusive, so go one day further back to cover the whole window.
    const res = await slack('search.messages', {
      query: `<@${me}> after:${daysAgoIso(config.days + 1)}`, sort: 'timestamp', sort_dir: 'desc', count: 50,
    });
    const cutoff = Date.now() - config.days * 864e5;
    const mentions = (res.messages?.matches || [])
      .filter((m) => m.user !== me && Number(m.ts) * 1000 >= cutoff)
      .map((m) => ({
        channel: m.channel?.is_im ? 'DM' : m.channel?.is_mpim ? 'Group DM' : `#${m.channel?.name || '?'}`,
        by: m.username || 'someone',
        at: new Date(Number(m.ts) * 1000).toISOString(),
        url: m.permalink,
        stamp: m.ts,
        excerpt: slackText(m.text, me),
      }));
    return { user: auth.user, team: auth.team, mentions };
  }

  return { fetch: fetchSlack };
}
