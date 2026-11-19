// The sandbox's network door. srt's proxy lets through only the hosts on its list; for any other
// host it asks Clearsky (srt's ask callback) and holds the connection meanwhile. Clearsky then
// asks you in the chat: allow for this turn, for this chat, or always (Settings), or deny. The
// proxy stays the fence: nothing here looks at commands, only at the host the proxy is asked for.
//
// A host you allow here is for reading. Where Clearsky reads the sandbox's HTTPS (it does when it
// adds a login on the way out), a request that sends data there (POST, PUT…) asks again, once,
// and that card shows the request: method, address, headers, size and the start of the body.
//
// What the first card can show: the proxy is asked at the CONNECT, before a byte of the request,
// and for HTTPS that byte would be encrypted anyway. So it says which host and port, which of the
// agent's steps was running then (its fetch with the address, its command), and says plainly
// that the request itself is only seen once the connection is let through.

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Headers a card shows only as hidden: logins and cookies. (Inside the sandbox they are srt's
// stand-ins, not the real values, but a card is no place for either.)
const SECRET_HEADER = /^(authorization|cookie)$|api[-_]?key|token|secret|session|password|signature/i;
// Headers that say nothing about what is sent (proxy-authorization is the sandbox's login to srt's
// proxy, which doesn't go on).
const PLAIN_HEADERS = new Set(['host', 'proxy-authorization', 'proxy-connection', 'connection', 'content-length', 'accept-encoding', 'transfer-encoding', 'te', 'keep-alive']);
const BODY_PREVIEW = 600, HEADERS_SHOWN = 16;
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);
const bytes = (n) => (n < 1024 ? `${n} bytes` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

// The start of a request's body, without waiting for all of it: up to `max` bytes, or what came
// within `ms`. { text, read, done }: `done` when that was the whole body.
async function bodyStart(req, max = 4096, ms = 2000) {
  if (!req.body) return null;
  const reader = req.body.getReader();
  const parts = [];
  let read = 0, done = false, timer;
  const late = new Promise((r) => { timer = setTimeout(() => r({ late: true }), ms); });
  try {
    while (read < max) {
      const r = await Promise.race([reader.read(), late]);
      if (r.late) break;
      if (r.done) { done = true; break; }
      parts.push(r.value); read += r.value.length;
    }
  } catch { /* the client went away: show what came */ } finally { clearTimeout(timer); reader.cancel().catch(() => {}); }
  return { buf: Buffer.concat(parts), read, done };
}
// The bytes as text, when they are UTF-8 without NULs (the last character may be cut in two); else null.
function asText(buf) {
  try { return buf.includes(0) ? null : new TextDecoder('utf-8', { fatal: true }).decode(buf, { stream: true }); } catch { return null; }
}

// A request as a card shows it: what it is, what it sends, and the start of that.
export async function describeRequest(req) {
  const u = new URL(req.url);
  const lines = [`${req.method.toUpperCase()} ${clip(`${u.protocol === 'http:' ? 'http://' : ''}${u.host}${u.pathname}${u.search}`, 400)}`];
  const length = Number(req.headers.get('content-length')) || null;
  const type = req.headers.get('content-type');
  const body = await bodyStart(req);
  const size = length ?? (body?.done ? body.read : null);
  if (body?.read || length) {
    lines.push(`Sends ${size != null ? bytes(size) : `at least ${bytes(body.read)}`}${type ? ` (${type.split(';')[0]})` : ''}`);
  } else lines.push('Sends no body: what goes there is the address and the headers.');
  const headers = [...req.headers].filter(([k]) => !PLAIN_HEADERS.has(k.toLowerCase()));
  if (headers.length) {
    lines.push('Headers:');
    for (const [k, v] of headers.slice(0, HEADERS_SHOWN)) lines.push(`  ${k}: ${SECRET_HEADER.test(k) ? `(hidden, ${v.length} characters)` : clip(v, 160)}`);
    if (headers.length > HEADERS_SHOWN) lines.push(`  …and ${headers.length - HEADERS_SHOWN} more`);
  }
  if (body?.read) {
    const text = asText(body.buf);
    const whole = body.done && text != null && text.length <= BODY_PREVIEW;
    lines.push(text == null ? `Body: not text (${type || 'no type given'}), not shown.`
      : whole ? `Body:\n${text}` : `Body (the start):\n${text.slice(0, BODY_PREVIEW)}\n…`);
  }
  return lines.join('\n');
}

// `host` or `host:port` as a rule: the port only when it isn't the web's own.
export const hostRule = (host, port) => {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  return port && port !== 443 && port !== 80 ? `${h}:${port}` : h;
};
// Whether a rule (`example.org`, `*.example.org`, `example.org:8443`) covers this host and port.
export function ruleMatches(rule, host, port) {
  const m = String(rule).toLowerCase().match(/^(.+?)(?::(\d+))?$/);
  if (!m) return false;
  const [, pattern, rulePort] = m;
  if (rulePort ? Number(rulePort) !== port : port && port !== 443 && port !== 80) return false;
  const h = String(host).toLowerCase().replace(/\.$/, '');
  return pattern.startsWith('*.') ? h.endsWith(pattern.slice(1)) && h.length > pattern.length - 1 : h === pattern;
}

// The agent's running steps, as the first card names them: the step that names this host first
// (Copilot's fetch with its address, a command with it), else the others that were running.
// `steps`: [{ title, kind, input }] from the chat's tool calls; `agent`: the agent's name.
export function stepLines(steps, host, agent = 'The agent') {
  const h = String(host).toLowerCase();
  const said = (st) => {
    const i = st.input && typeof st.input === 'object' ? st.input : {};
    const named = [i.url, i.uri, i.command, i.query, ...(Array.isArray(i.urls) ? i.urls : [])].filter((x) => typeof x === 'string');
    const what = named.find((x) => x.toLowerCase().includes(h)) || named[0];
    const title = clip(String(st.title || st.kind || 'a step').replace(/\s+/g, ' '), 160);
    return what && !title.includes(what) ? `${title}: ${clip(what.replace(/\s+/g, ' '), 300)}` : title;
  };
  const text = (st) => JSON.stringify([st.title, st.input]).toLowerCase();
  const naming = steps.filter((st) => text(st).includes(h));
  if (naming.length) return naming.slice(0, 3).map((st) => `${agent}'s step that names it: ${said(st)}`);
  if (!steps.length) return [];
  return [`${agent}'s step${steps.length > 1 ? 's' : ''} running then (none names this host):`, ...steps.slice(-3).map((st) => `  ${said(st)}`)];
}

export class HostDoor {
  // ask(card) → Promise of the chosen option id, shown in `chats` (the working sandboxed chats,
  // from chats()): the proxy can't tell which one a request comes from, so each of them asks and
  // the first answer counts. always() → the rules from Settings; addAlways(rule) saves one.
  // readable() → whether Clearsky reads the sandbox's HTTPS (and so can keep a host read only).
  // late(chats, rule) → the answer came after the request gave up: tell the chats to try again.
  // Copilot's own fetch gives up after about 10 s, so `late` counts from lateMs (8 s).
  // steps(chats, host) → lines on what the chats were doing (their running steps), for the card.
  // seen(chats, line) → a request read from a host allowed here, for the chats' activity.
  constructor({ chats, ask, always = () => [], addAlways = () => {}, readable = () => true, late = () => {}, steps = () => [], seen = () => {}, holdMs = 5 * 6e4, lateMs = 8_000, now = Date.now }) {
    Object.assign(this, { chats, ask, always, addAlways, readable, late, steps, seen, holdMs, lateMs, now });
    this.state = new Map(); // chat id → { turn, chat, denied: Set of rules } (turn and denied: this turn only)
    this.asking = new Map(); // rule → Promise<boolean>, so many connections to one host make one card
  }
  of(id) {
    if (!this.state.has(id)) this.state.set(id, { turn: new Set(), chat: new Set(), denied: new Set() });
    return this.state.get(id);
  }
  allowedIn(id, host, port) {
    const s = this.state.get(id);
    return !!s && [...s.turn, ...s.chat].some((r) => ruleMatches(r, host, port));
  }
  allowedAlways(host, port) { return this.always().some((r) => ruleMatches(r, host, port)); }
  // A chat's turn ended: what you allowed for that turn is over.
  turnEnded(id) { const s = this.state.get(id); s?.turn.clear(); s?.denied.clear(); s?.seen?.clear(); }
  forget(id) { this.state.delete(id); }

  // srt's ask callback: true lets the connection through.
  async decide({ host, port }) {
    if (this.allowedAlways(host, port)) return true;
    const chats = this.chats();
    if (!chats.length) return false; // nobody to ask (no chat working): stays blocked
    if (chats.every((c) => c.mode === 'full' || this.allowedIn(c.id, host, port))) return true;
    const rule = hostRule(host, port);
    // Denied this turn: no new card for each retry.
    if (chats.every((c) => this.state.get(c.id)?.denied.has(rule))) return false;
    if (!this.asking.has(rule)) {
      const p = this.#askAll(rule, host, port, chats).finally(() => this.asking.delete(rule));
      this.asking.set(rule, p);
    }
    return this.asking.get(rule);
  }

  async #askAll(rule, host, port, chats) {
    const readOnly = this.readable();
    const web = port === 443 ? 'https' : port === 80 ? 'http' : null;
    let steps = [];
    try { steps = this.steps(chats, host) || []; } catch { /* the card goes without them */ }
    const card = {
      title: 'Reach a host outside the sandbox',
      // What is known, as facts; then, in words, what Clearsky can and can't see.
      detail: [`${rule}${web ? ` (${web})` : ' (not the web\'s own port: may not be HTTP at all)'}`,
        ...(steps.length ? steps : ['No step was running: this comes from the agent itself (its own service, an update, telemetry) or a program it started.'])].join('\n'),
      note: [web === 'http'
        ? 'Clearsky can\'t see the request yet: the proxy is asked before the request is sent.'
        : `Clearsky can't see the request yet: the proxy is asked when the connection opens, before anything is sent${web ? ', and HTTPS is encrypted' : ''}.`,
      readOnly && web ? 'Once allowed, Clearsky reads each request there: what is read shows in this chat, and sending data asks again with what it sends.'
        : 'Clearsky can\'t read what goes there, so this allows sending as well as reading.',
      'It isn\'t on the sandbox\'s host list. The request waits here for your answer; if it gives up first, Allow still counts and the agent is told to try again.'].join(' '),
      options: [
        { id: 'allow', name: 'Allow', kind: 'allow_once' },
        { id: 'chat', name: 'Allow in this chat', kind: 'allow_always' },
        { id: 'always', name: 'Always allow', kind: 'allow_always' },
        { id: 'deny', name: 'Deny', kind: 'reject_once' },
      ],
    };
    const asked = this.now();
    let timer;
    const answer = this.ask(card, chats, { rule, host, port });
    const held = await Promise.race([answer, new Promise((r) => { timer = setTimeout(() => r('timeout'), this.holdMs); })]);
    clearTimeout(timer);
    if (held === 'timeout') {
      // The request goes back blocked, but the card stays: a later Allow still counts.
      answer.then((late) => { if (this.#apply(late, rule, chats)) this.late(chats, rule); }, () => {});
      return false;
    }
    const ok = this.#apply(held, rule, chats);
    if (ok && this.now() - asked > this.lateMs) this.late(chats, rule);
    return ok;
  }

  #apply(choice, rule, chats) {
    // Nobody answered before the chat's turn ended (the card was taken down): not a Deny, so
    // the next turn asks again.
    if (choice === 'expired') return false;
    if (choice === 'always') { this.addAlways(rule); return true; }
    if (choice === 'chat') { for (const c of chats) this.of(c.id).chat.add(rule); return true; }
    if (choice === 'allow') { for (const c of chats) this.of(c.id).turn.add(rule); return true; }
    for (const c of chats) this.of(c.id).denied.add(rule);
    return false;
  }

  // Part of srt's filterRequest (it sees only what Clearsky reads): a request that sends data to a
  // host allowed here asks first. null: not one of these hosts, or only reading.
  async check(req, { listed = () => false } = {}) {
    const u = new URL(req.url);
    const host = u.hostname.toLowerCase(), port = Number(u.port) || (u.protocol === 'http:' ? 80 : 443);
    if (listed(host, port)) return null;
    const chats = this.chats();
    const ours = this.allowedAlways(host, port) || chats.some((c) => this.allowedIn(c.id, host, port));
    if (!ours) return null;
    const what = `${req.method.toUpperCase()} ${host}${u.pathname}`;
    if (READ_METHODS.has(req.method.toUpperCase())) {
      // Reading goes through; you see what was read in the chat (once per address in a turn).
      const line = `${req.method.toUpperCase()} ${clip(`${host}${u.pathname}${u.search}`, 300)}`;
      const fresh = chats.filter((c) => { const s = this.of(c.id); s.seen ||= new Set(); return !s.seen.has(line) && s.seen.add(line); });
      if (fresh.length) { try { this.seen(fresh, line); } catch { /* only a note */ } }
      return null;
    }
    if (chats.length && chats.every((c) => c.mode === 'full')) return null;
    const choice = chats.length ? await this.ask({
      title: 'Send data to a host outside the sandbox',
      detail: await describeRequest(req),
      note: `You allowed reading ${hostRule(host, port)}; this sends data there.`,
      options: [{ id: 'allow', name: 'Allow', kind: 'allow_once' }, { id: 'deny', name: 'Deny', kind: 'reject_once' }],
    }, chats, { rule: hostRule(host, port), host, port, write: true }) : 'deny';
    if (choice === 'allow') return { action: 'allow' };
    return { action: 'deny', reason: `The user declined: ${what}. Reading ${host} is allowed; ask them before sending anything there.` };
  }
}
