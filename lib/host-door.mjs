// The sandbox's network door. srt's proxy lets through only the hosts on its list; for any other
// host it asks Clearsky (srt's ask callback) and holds the connection meanwhile. Clearsky then
// asks you in the chat: allow for this turn, for this chat, or always (Settings), or deny. The
// proxy stays the fence: nothing here looks at commands, only at the host the proxy is asked for.
//
// A host you allow here is for reading. Where Clearsky reads the sandbox's HTTPS (it does when it
// adds a login on the way out), a request that sends data there (POST, PUT…) asks again, once.

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

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

export class HostDoor {
  // ask(card) → Promise of the chosen option id, shown in `chats` (the working sandboxed chats,
  // from chats()): the proxy can't tell which one a request comes from, so each of them asks and
  // the first answer counts. always() → the rules from Settings; addAlways(rule) saves one.
  // readable() → whether Clearsky reads the sandbox's HTTPS (and so can keep a host read only).
  // late(chats, rule) → the answer came after the request gave up: tell the chats to try again.
  constructor({ chats, ask, always = () => [], addAlways = () => {}, readable = () => true, late = () => {}, holdMs = 5 * 6e4, lateMs = 20_000, now = Date.now }) {
    Object.assign(this, { chats, ask, always, addAlways, readable, late, holdMs, lateMs, now });
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
  turnEnded(id) { const s = this.state.get(id); s?.turn.clear(); s?.denied.clear(); }
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
    const card = {
      title: 'Reach a host outside the sandbox',
      detail: `${rule}${port && port !== 443 && port !== 80 ? '' : ` (${port === 80 ? 'http' : 'https'})`}\nIt isn't on the sandbox's host list. Copilot's request waits here for your answer.`
        + (readOnly ? '\nFor reading: sending data there asks again.' : '\nClearsky can\'t see what goes there, so this allows sending as well as reading.'),
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
    if (READ_METHODS.has(req.method.toUpperCase()) || listed(host, port)) return null;
    const chats = this.chats();
    const ours = this.allowedAlways(host, port) || chats.some((c) => this.allowedIn(c.id, host, port));
    if (!ours) return null;
    if (chats.length && chats.every((c) => c.mode === 'full')) return null;
    const what = `${req.method.toUpperCase()} ${host}${u.pathname}`;
    const choice = chats.length ? await this.ask({
      title: 'Send data to a host outside the sandbox',
      detail: `${what}\nYou allowed reading ${hostRule(host, port)}; this sends data there.`,
      options: [{ id: 'allow', name: 'Allow', kind: 'allow_once' }, { id: 'deny', name: 'Deny', kind: 'reject_once' }],
    }, chats, { rule: hostRule(host, port), host, port, write: true }) : 'deny';
    if (choice === 'allow') return { action: 'allow' };
    return { action: 'deny', reason: `The user declined: ${what}. Reading ${host} is allowed; ask them before sending anything there.` };
  }
}
