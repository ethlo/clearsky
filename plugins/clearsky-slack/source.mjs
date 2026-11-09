// Slack: messages that @mention you, as rows that need you, reminders, and "Reply to …" in
// Now / Next. What it reaches and keeps is in clearsky-plugin.json; this is what it does.

import { fetchMentions } from './lib/slack.mjs';

const recent = (iso, hours, now = Date.now()) => now - Date.parse(iso) < hours * 36e5;
const ago = (iso) => { const m = Math.max(1, Math.round((Date.now() - Date.parse(iso)) / 6e4)); return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`; };

export default {
  async fetch(ctx) {
    return fetchMentions({
      token: ctx.env.SLACK_TOKEN,
      // Clearsky's own settings, read here because Slack ships with it and runs inside it.
      api: process.env.SLACK_API_URL || 'https://slack.com/api',
      days: Math.max(1, Number(process.env.CLEARSKY_MENTION_DAYS) || 14),
    });
  },

  items: (d) => (d.mentions || []).map((m) => ({
    key: m.url, stamp: m.stamp, url: m.url, at: m.at, ref: m.channel,
    kind: 'mention', next: 'reply', open: 'Open in Slack', quoteLabel: 'Message',
    title: `${m.by} in ${m.channel}`, quote: m.excerpt, meta: m.excerpt,
    why: `${m.by} mentioned you in ${m.channel}.`,
  })),

  attention: (d) => (d.mentions || []).map((m) => ({ key: m.url, stamp: m.stamp, at: m.at, url: m.url, title: `${m.by} in ${m.channel}`, body: m.excerpt })),

  // Mentions from the last day are worth five minutes between meetings.
  plan: (d) => (d.mentions || []).filter((m) => recent(m.at, 24))
    .map((m) => ({ key: m.url, title: `Reply to ${m.by} in ${m.channel}`, detail: m.excerpt, url: m.url, stamp: m.stamp, minutes: 5, why: 'Slack mention' })),

  // The markdown summary (`clearsky`, `--md`): one line each.
  markdown: (d) => ({ title: 'Slack mentions', lines: (d.mentions || []).map((m) => `[${m.channel}](${m.url}) ${m.by}, ${ago(m.at)}: "${m.excerpt}"`) }),
};
