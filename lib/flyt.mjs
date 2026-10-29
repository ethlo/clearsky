// Visma Flyt Skole, the guardian portal at https://foresatt.visma.no: what the school sends
// you about your children. There is no public API. This talks to the one the portal itself
// uses, as observed and documented by skolectl (https://github.com/langtind/skolectl, MIT).
// Read-only: it never replies, marks as read or answers anything.
//
// The login is three cookies from a browser login with ID-porten (see flyt-login.mjs). The
// access token lasts five minutes; sending the session id and the refresh token gets a new
// one. The login is kept in the GNOME keyring (secret-tool), or in a private file without it.

import { readFileSync, writeFileSync, mkdirSync, rmSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';

export const API = 'https://api.foresatt.visma.no';
export const PORTAL = 'https://foresatt.visma.no';
export const COOKIES = { access: 'CookieAccessToken', refresh: 'CookieRefreshToken', session: 'GwebId' };

export class FlytAuthError extends Error {
  constructor(msg = 'Log in to Visma Flyt Skole again') { super(msg); this.auth = true; }
}

// --- Where the login is kept -------------------------------------------------------------

function secretTool(args, input) {
  return new Promise((resolve, reject) => {
    const child = execFile('secret-tool', args, { timeout: 10_000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
    if (input != null) child.stdin.end(input); else child.stdin.end();
  });
}

const ATTRS = ['service', 'clearsky', 'account', 'visma-flyt-skole'];

export function keyringStore({ tool = secretTool } = {}) {
  return {
    where: 'GNOME keyring',
    async get() {
      // lookup exits 1 when nothing is stored; a missing secret-tool or keyring throws.
      const s = (await tool(['lookup', ...ATTRS]).catch((e) => { if (e.code === 1) return ''; throw e; })).trim();
      return s ? JSON.parse(s) : null;
    },
    async set(v) { await tool(['store', '--label=Clearsky: Visma Flyt Skole login', ...ATTRS], JSON.stringify(v)); },
    async clear() { await tool(['clear', ...ATTRS]).catch(() => {}); },
  };
}

export function fileStore(path = join(homedir(), '.config', 'clearsky', 'flyt-session.json')) {
  return {
    where: path,
    async get() { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } },
    async set(v) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, JSON.stringify(v), { mode: 0o600 });
      chmodSync(path, 0o600);
    },
    async clear() { rmSync(path, { force: true }); },
  };
}

// The keyring when secret-tool works here, else the file.
export async function defaultStore() {
  const ring = keyringStore();
  try { await ring.get(); return ring; } catch { return fileStore(); }
}

// --- Login and renewal -------------------------------------------------------------------

export function jwtExpiry(token) {
  try { return new Date(JSON.parse(Buffer.from(token.split('.')[1], 'base64url')).exp * 1000).toISOString(); } catch { return null; }
}

// A login from the cookies a browser got for the API host: [{ name, value, domain }].
export function sessionFromCookies(cookies, host = new URL(API).hostname) {
  const pick = (name) => cookies.find((c) => c.name === name && c.domain.replace(/^\./, '') === host)?.value;
  const s = { access: pick(COOKIES.access), refresh: pick(COOKIES.refresh), session: pick(COOKIES.session) };
  if (!s.access || !s.refresh || !s.session) return null;
  return { ...s, expires: jwtExpiry(s.access), customerKey: pick('CookieCustomerKey') || null, loggedInAt: new Date().toISOString() };
}

const cookieHeader = (pairs) => Object.entries(pairs).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join('; ');

function setCookies(res) {
  const out = {};
  for (const line of res.headers.getSetCookie?.() || []) {
    const m = line.match(/^([^=;\s]+)=([^;]*)/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const HEADERS = { Accept: 'application/json', 'Requested-By': 'XMLHttpRequest' };

// Any request with the session id and the refresh token is answered with new cookies. The
// access token is left out: sent one that still works, the service hands out no new one.
export async function renew(session, { api = API, fetch = globalThis.fetch } = {}) {
  const res = await fetch(`${api}/v1/session`, {
    headers: { ...HEADERS, Cookie: cookieHeader({ [COOKIES.session]: session.session, [COOKIES.refresh]: session.refresh }) },
    redirect: 'manual',
  });
  if (res.status === 401 || res.status === 403) throw new FlytAuthError();
  if (!res.ok) throw new Error(`Visma Flyt Skole: ${res.status} renewing the login`);
  const got = setCookies(res);
  if (!got[COOKIES.access]) throw new FlytAuthError();
  return { ...session, access: got[COOKIES.access], refresh: got[COOKIES.refresh] || session.refresh, expires: jwtExpiry(got[COOKIES.access]) };
}

// A client over a stored login. It renews ahead of time and once more on a 401, and saves
// each renewal. Several calls at once share one renewal.
export function client({ store, api = API, fetch = globalThis.fetch, now = () => Date.now() } = {}) {
  let session = null, renewing = null;
  const load = async () => {
    session ??= await store.get();
    if (!session?.session || !session.refresh) throw new FlytAuthError('Not logged in to Visma Flyt Skole');
    if (session.expiredAt) throw new FlytAuthError();
    return session;
  };
  const refresh = () => (renewing ??= (async () => {
    try {
      session = await renew(await load(), { api, fetch });
      await store.set(session);
      return session;
    } catch (e) {
      // Remember that the login is gone, so Settings can say so and we stop asking.
      if (e.auth && session) await store.set({ ...session, expiredAt: new Date(now()).toISOString() }).catch(() => {});
      throw e;
    } finally { renewing = null; }
  })());
  const fresh = async () => {
    const s = await load();
    return s.access && s.expires && Date.parse(s.expires) - now() > 30_000 ? s : refresh();
  };
  const send = (s, path) => fetch(`${api}/${path}`, {
    headers: { ...HEADERS, Cookie: cookieHeader({ [COOKIES.session]: s.session, [COOKIES.access]: s.access }) },
    redirect: 'manual',
  });
  const answer = async (path) => {
    let res = await send(await fresh(), path);
    if (res.status === 401) res = await send(await refresh(), path);
    if (res.status === 401) throw new FlytAuthError();
    return res;
  };
  return {
    async get(path, { optional = false } = {}) {
      const res = await answer(path);
      // An area the school has turned off answers 403.
      if (optional && (res.status === 403 || res.status === 404)) return null;
      if (!res.ok) throw new Error(`Visma Flyt Skole: ${res.status} on ${path.replace(/\d{3,}/g, '…')}`);
      const text = await res.text();
      return text ? JSON.parse(text) : null;
    },
    // A file, such as an attachment: its bytes and type.
    async file(path, { maxBytes = 25 * 1024 * 1024 } = {}) {
      const res = await answer(path);
      if (!res.ok) throw new Error(`Visma Flyt Skole: ${res.status} fetching the file`);
      if (+res.headers.get('content-length') > maxBytes) throw new Error('The file is too large to show here; open it in the portal');
      const data = Buffer.from(await res.arrayBuffer());
      if (data.length > maxBytes) throw new Error('The file is too large to show here; open it in the portal');
      return { data, type: (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase() };
    },
    session: () => session,
  };
}

// --- What we read ------------------------------------------------------------------------

// Times on messages, notices and forms have no zone; they are Oslo time.
export function osloTime(s) {
  if (!s) return null;
  if (/[zZ]|[+-]\d\d:?\d\d$/.test(s)) return new Date(s).toISOString();
  const m = s.match(/^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)(?::(\d\d)(?:\.(\d+))?)?/);
  if (!m) return null;
  const asUtc = Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0), +((m[7] || '0') + '00').slice(0, 3));
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Oslo', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(asUtc)).map((p) => [p.type, p.value]));
  const offset = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - Math.floor(asUtc / 1000) * 1000;
  return new Date(asUtc - offset).toISOString();
}

const list = (v) => (Array.isArray(v) ? v : []);
const clip = (s, n = 160) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

// Everything waiting for you, for each child: unread messages and notices, open forms and
// consents. Areas a school doesn't use come back empty.
export async function collectFlyt({ store, api = API, fetch = globalThis.fetch, now = () => Date.now() } = {}) {
  const c = client({ store: store || await defaultStore(), api, fetch, now });
  const kids = list((await c.get('v2/children'))?.children).map((k) => ({
    pupilId: k.school?.pupilId, name: k.firstName, school: k.school?.organizationName,
  })).filter((k) => k.pupilId);

  const children = await Promise.all(kids.map(async (kid) => {
    const p = `vfs/v1/pupils/${kid.pupilId}`;
    const [direct, group, notices, announcements, forms, consents] = await Promise.all([
      c.get(`${p}/messages/direct`, { optional: true }),
      c.get(`${p}/messages/group`, { optional: true }),
      c.get(`${p}/notifications/0`, { optional: true }),
      c.get(`${p}/notifications/1`, { optional: true }),
      c.get(`${p}/digital-forms`, { optional: true }),
      c.get(`${p}/consents`, { optional: true }),
    ]);
    const threads = [
      ...list(direct).map((t) => ({ id: `direct:${kid.pupilId}:${t.employeeId}`, kind: 'direct', title: t.title, from: t.sender,
        preview: clip(t.messageText), at: osloTime(t.sentDate), unread: t.unreadCount || 0 })),
      ...list(group).map((t) => ({ id: `group:${kid.pupilId}:${t.conversationId}`, kind: 'group', title: t.title, from: t.lastMessage?.sentBy,
        preview: clip(t.lastMessage?.message), at: osloTime(t.lastMessageDate), unread: t.unreadMessageCount || 0 })),
    ];
    return {
      ...kid,
      threads,
      notices: [...list(notices).map((n) => ({ ...n, kind: 'notice' })), ...list(announcements).map((n) => ({ ...n, kind: 'announcement' }))]
        .map((n) => ({ id: `notice:${n.idMessage}`, kind: n.kind, title: n.title, from: n.sender, preview: clip(n.messageText), text: n.messageText || '', at: osloTime(n.sentDate), unread: !!n.isUnread })),
      forms: list(forms).map((f) => ({ id: `form:${kid.pupilId}:${f.id}`, title: f.title, deadline: osloTime(f.deadline), at: osloTime(f.lastModifiedOn || f.publishedOn),
        answered: !!f.isAnswered, closed: !!f.isDeadlinePassed })),
      consents: list(consents?.consents).map((x) => ({ id: `consent:${x.id}`, title: x.title, text: x.content || '', at: osloTime(x.modifiedOn), answered: x.status !== 0 })),
    };
  }));
  return { children, customerKey: c.session()?.customerKey || null, checkedAt: new Date(now()).toISOString() };
}

// The things that need you: unread threads and notices, and forms and consents to answer.
export function waiting(data) {
  const out = [];
  for (const kid of list(data?.children)) {
    for (const t of kid.threads) if (t.unread) out.push({ child: kid.name, key: `flyt:${t.id}`, stamp: `${t.at}|${t.unread}`, at: t.at,
      title: t.title || (t.kind === 'direct' ? `Message from ${t.from}` : 'Group message'), from: t.from, body: t.preview, what: 'message', count: t.unread });
    for (const n of kid.notices) if (n.unread) out.push({ child: kid.name, key: `flyt:${n.id}`, stamp: n.at, at: n.at, title: n.title, from: n.from, body: n.preview, what: n.kind });
    for (const f of kid.forms) if (!f.answered && !f.closed) out.push({ child: kid.name, key: `flyt:${f.id}`, stamp: f.at, at: f.at, title: f.title, deadline: f.deadline, what: 'form' });
    for (const x of kid.consents) if (!x.answered) out.push({ child: kid.name, key: `flyt:${x.id}`, stamp: x.at, at: x.at, title: x.title, what: 'consent' });
  }
  return out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

// --- Reading one thing in full ----------------------------------------------------------

// A key from waiting(), taken apart. Ids go into API paths, so only plain ones pass.
export function parseKey(key) {
  const m = String(key).replace(/^flyt:/, '').match(/^(direct|group|form|notice|consent):(?:(\d+):)?([\w-]+)$/);
  if (!m || (['direct', 'group', 'form'].includes(m[1]) && !m[2])) throw new Error('Not a Visma Flyt Skole item');
  return { kind: m[1], pupil: m[2], id: m[3] };
}

const attachmentOf = (a) => ({
  id: String(a.attachmentId ?? a.idAttachment ?? a.id ?? ''), name: a.fileName || a.name || a.title || 'Attachment',
  type: a.contentType || null, bytes: a.contentLength ?? a.size ?? null,
});

function findItem(data, key) {
  const id = String(key).replace(/^flyt:/, '');
  for (const kid of list(data?.children)) {
    for (const x of [...kid.threads, ...kid.notices, ...kid.forms, ...kid.consents]) if (x.id === id) return { kid, item: x };
  }
  return {};
}

// The whole thread, notice or form, oldest message first. Reading it here does not mark
// anything as read at the school.
export async function readFlyt(key, data, { store, api = API, fetch = globalThis.fetch, now = () => Date.now() } = {}) {
  const { kind, pupil, id } = parseKey(key);
  const { kid, item } = findItem(data, key);
  const base = { title: item?.title || '', child: kid?.name || null, kind };
  if (kind === 'notice' || kind === 'consent') {
    if (!item) throw new Error('That is no longer in the list; refresh and try again');
    return { ...base, messages: [{ from: item.from || 'The school', at: item.at, text: item.text || item.preview || '', attachments: [] }] };
  }
  const c = client({ store: store || await defaultStore(), api, fetch, now });
  if (kind === 'direct') {
    const t = await c.get(`vfs/v2/pupils/${pupil}/messages/direct/${id}`);
    const messages = list(t?.messages).map((m) => ({
      from: m.participantType === 2 ? 'You' : item?.from || 'The school', mine: m.participantType === 2, at: osloTime(m.sentDate),
      title: m.title || null, text: m.messageText || '', attachments: list(m.attachments).map(attachmentOf).filter((a) => a.id),
    }));
    return { ...base, title: base.title || messages.find((m) => m.title)?.title || `Message from ${item?.from || 'school'}`, messages: messages.sort((a, b) => String(a.at).localeCompare(String(b.at))) };
  }
  if (kind === 'group') {
    const t = await c.get(`vfs/v1/pupils/${pupil}/messages/group/${encodeURIComponent(id)}`);
    const messages = list(t?.messages).filter((m) => !m.isRemovalMessage).map((m) => ({
      from: m.sentByMe ? 'You' : m.sentBy || 'Someone', mine: !!m.sentByMe, at: osloTime(m.sentOn),
      text: m.message || '', attachments: list(m.attachments).map(attachmentOf).filter((a) => a.id),
    }));
    return { ...base, title: t?.title || base.title, meta: list(t?.participants).join(', ') || null,
      messages: messages.sort((a, b) => String(a.at).localeCompare(String(b.at))) };
  }
  const f = await c.get(`vfs/v1/pupils/${pupil}/digital-forms/${id}`);
  const choices = list(f?.alternatives).sort((a, b) => a.order - b.order).map((a) => `• ${a.text}`).join('\n');
  const text = [f?.publishText, f?.furtherInformation, choices && `Choices:\n${choices}`].filter(Boolean).join('\n\n');
  return { ...base, title: f?.title || base.title, meta: f?.deadline ? `Answer by ${osloTime(f.deadline)}` : null,
    messages: [{ from: f?.lastModifiedBy || 'The school', at: osloTime(f?.publishedOn), text,
      // Files on a form can only be opened in the portal for now.
      attachments: list(f?.attachments).map((a) => ({ ...attachmentOf(a), id: null })) }] };
}

// One attachment from a thread. It is looked up in the thread first, so only files that
// belong to it can be fetched, and so the file has its name.
export async function flytFile(key, attachmentId, opts = {}) {
  const { kind, pupil, id } = parseKey(key);
  if (kind !== 'direct' && kind !== 'group') throw new Error('No files here');
  const thread = await readFlyt(key, null, opts);
  const meta = thread.messages.flatMap((m) => m.attachments).find((a) => a.id === String(attachmentId));
  if (!meta) throw new Error('No such attachment');
  const c = client({ store: opts.store || await defaultStore(), api: opts.api || API, fetch: opts.fetch || globalThis.fetch, now: opts.now || (() => Date.now()) });
  const path = kind === 'group'
    ? `vfs/v1/pupils/${pupil}/messages/group/${encodeURIComponent(id)}/attachment/${encodeURIComponent(meta.id)}`
    // Seen in the web client's code, not yet with a real file.
    : `vfs/v1/pupils/${pupil}/messages/direct/${id}/attachment/${encodeURIComponent(meta.id)}`;
  const file = await c.file(path);
  return { ...file, type: file.type || meta.type || 'application/octet-stream', name: meta.name };
}

export const portalUrl = (key) => (key ? `${PORTAL}/${encodeURIComponent(key)}` : PORTAL);
