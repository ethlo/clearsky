// Slack: messages that @mention you, through search.messages with your user token.

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

// The messages from the last `days` days that mention you, newest first. `api` is Slack's Web API
// address (tests and the demo point it elsewhere).
export async function fetchMentions({ token, api = 'https://slack.com/api', days = 14, now = Date.now(), fetchImpl = fetch }) {
  async function slack(method, params = {}) {
    const url = new URL(`${api.replace(/\/$/, '')}/${method}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} from ${url.host}`);
    const body = await res.json();
    if (!body.ok) throw Object.assign(new Error(`Slack ${method}: ${body.error}${body.needed ? ` (needs scope ${body.needed})` : ''}`),
      /invalid_auth|token_revoked|not_authed|account_inactive/.test(body.error || '') ? { auth: true } : {});
    return body;
  }
  const auth = await slack('auth.test');
  const me = auth.user_id;
  // Slack's `after:` is exclusive, so go one day further back to cover the whole window.
  const after = new Date(now - (days + 1) * 864e5).toISOString().slice(0, 10);
  const res = await slack('search.messages', { query: `<@${me}> after:${after}`, sort: 'timestamp', sort_dir: 'desc', count: 50 });
  const cutoff = now - days * 864e5;
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
