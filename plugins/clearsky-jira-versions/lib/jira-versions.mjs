// Jira fix versions: Copilot chats add and take off a ticket's fix versions, after you OK the
// change in the chat. acli (Clearsky's way into Jira) can't: `acli jira workitem edit` has no
// fix-version flag and its JSON takes only summary, type, description, assignee and labels. So
// this goes through Atlassian's remote MCP server with your own OAuth login (no API token), the
// same way the Confluence plugin reads Confluence. `jira-versions …` in a chat comes here
// through Clearsky's door (lib/broker.mjs, ../source.mjs); the login never goes in the sandbox.
//
// Narrow by construction: the door reads a ticket and writes only its fixVersions field. A chat
// can't call the server's other tools, so it can't change anything else in Jira this way.
// Everything else (status, comments, labels) stays with acli.
//
// Tool names aren't hard-coded: the server's set changes between versions, so each step picks
// the tool that fits by name and fills in only the arguments its schema has.

export const USAGE = `jira-versions show KEY…                  each ticket's fix versions
jira-versions add VERSION KEY…           add a fix version, keeping the others
jira-versions remove VERSION KEY…        take a fix version off
jira-versions raw KEY                    what Jira's server sends for a ticket, as it is
Several versions: VERSION can be "1.7.0,1.7.1". Changes ask in the chat first, one question
for the whole command, showing each ticket before and after. Status moves stay with acli:
acli jira workitem transition --key KEY --status "Done".`;

export const KEY = /^[A-Z][A-Z0-9_]{0,49}-\d{1,9}$/;
// A version's name as Jira allows it: up to 255 characters, no control characters.
const VERSION = /^[^\u0000-\u001f\u007f,]{1,255}$/;

// The command a chat typed, checked: { cmd, versions?, keys } or { error }.
export function parseCommand(argv) {
  const [cmd = 'help', ...rest] = argv;
  if (rest.some((a) => a.startsWith('--'))) return { error: `unknown option ${rest.find((a) => a.startsWith('--'))}` };
  switch (cmd) {
    case 'help': case '--help': case '-h': return { cmd: 'help' };
    case 'raw': {
      const k = String(rest[0] || '').trim().toUpperCase();
      if (rest.length !== 1 || !KEY.test(k)) return { error: 'raw needs one ticket, like ABC-12' };
      return { cmd, keys: [k] };
    }
    case 'show': {
      const keys = [...new Set(rest.flatMap((a) => a.split(',')).map((k) => k.trim().toUpperCase()).filter(Boolean))];
      if (!keys.length) return { error: 'show needs one or more tickets, like ABC-12' };
      const bad = keys.find((k) => !KEY.test(k));
      if (bad) return { error: `${bad} is not a ticket key, like ABC-12` };
      return { cmd, keys };
    }
    case 'add': case 'remove': {
      const [list = '', ...ks] = rest;
      const versions = [...new Set(list.split(',').map((v) => v.trim()).filter(Boolean))];
      if (!versions.length || KEY.test(list.trim())) return { error: `${cmd} needs a version first, then the tickets: jira-versions ${cmd} 1.7.0 ABC-12 ABC-13` };
      const badV = versions.find((v) => !VERSION.test(v));
      if (badV) return { error: `"${badV}" is not a version name` };
      const keys = [...new Set(ks.flatMap((a) => a.split(',')).map((k) => k.trim().toUpperCase()).filter(Boolean))];
      if (!keys.length) return { error: `${cmd} needs one or more tickets after the version` };
      if (keys.length > 50) return { error: 'at most 50 tickets at a time' };
      const bad = keys.find((k) => !KEY.test(k));
      if (bad) return { error: `${bad} is not a ticket key, like ABC-12` };
      return { cmd, versions, keys };
    }
    default: return { error: `unknown command ${cmd}` };
  }
}

// The tools this door uses, by name: the most specific match first.
const PICK = {
  sites: [/^getAccessibleAtlassianResources$/, /accessible.*resources|atlassian.*(sites|resources)/i],
  read: [/^getJiraIssue$/, /^get.*jira.*issue$/i],
  edit: [/^editJiraIssue$/, /^(edit|update).*jira.*issue$/i],
};
export function pickTool(tools = [], step) {
  for (const re of PICK[step] || []) {
    const t = tools.find((x) => x && typeof x.name === 'string' && re.test(x.name));
    if (t) return t;
  }
  return null;
}

// Arguments for a tool, from what we have, keeping only the names its schema has.
export function argsFor(tool, want) {
  const props = tool?.inputSchema?.properties || {};
  const has = (k) => Object.prototype.hasOwnProperty.call(props, k);
  const out = {};
  const put = (names, v) => { if (v === undefined || v === null) return; const k = names.find(has); if (k) out[k] = v; };
  put(['cloudId'], want.cloudId);
  put(['issueIdOrKey', 'issueKey', 'key'], want.key);
  // fields as the schema wants it: a list, or one comma-separated string.
  if (want.fields && has('fields')) out.fields = Array.isArray(want.fields) && props.fields?.type === 'string' ? want.fields.join(',') : want.fields;
  // JSON rather than Markdown, where the tool lets us pick.
  for (const k of ['responseContentFormat', 'responseFormat', 'contentFormat', 'format']) {
    const e = props[k]?.enum;
    if (want.json && has(k) && Array.isArray(e)) { const pick = e.find((x) => /^json$/i.test(x)) || e.find((x) => /json|adf|raw/i.test(x)); if (pick) out[k] = pick; break; }
  }
  return out;
}

// A tool's answer as text: its text parts joined, else structured content as JSON.
export function resultText(r) {
  const parts = (r?.content || []).map((c) => (c.type === 'text' ? c.text : c.type === 'resource' && c.resource?.text ? c.resource.text : '')).filter(Boolean);
  return parts.length ? parts.join('\n') : r?.structuredContent ? JSON.stringify(r.structuredContent) : '';
}

// JSON in a tool's answer: the whole text, a ```json block in it, or the outermost {…} or […].
export function jsonIn(text) {
  const t = String(text || '').trim();
  const tries = [t, (t.match(/```(?:json)?\s*\n([\s\S]*?)```/) || [])[1]];
  for (const [open, close] of [['{', '}'], ['[', ']']]) { const i = t.indexOf(open), j = t.lastIndexOf(close); if (i > -1 && j > i) tries.push(t.slice(i, j + 1)); }
  for (const x of tries) { if (!x) continue; try { return JSON.parse(x); } catch { /* next */ } }
  return undefined;
}

// The first `fixVersions` anywhere in a JSON value ({ fields }, { issue: { fields } }, a list…).
function findFixVersions(v, depth = 0) {
  if (!v || typeof v !== 'object' || depth > 6) return undefined;
  if (!Array.isArray(v) && Object.prototype.hasOwnProperty.call(v, 'fixVersions')) return v.fixVersions;
  for (const x of Array.isArray(v) ? v : Object.values(v)) { const f = findFixVersions(x, depth + 1); if (f !== undefined) return f; }
  return undefined;
}
const versionList = (list) => list.map((v) => (typeof v === 'string' ? { name: v } : v)).filter((v) => v && typeof v.name === 'string' && v.name.trim())
  .map((v) => ({ ...(v.id != null && { id: String(v.id) }), name: v.name.trim() }));

// A ticket's fix versions from what the server gave back: [{ id?, name }]. From JSON in any
// wrapper, else a "Fix versions: 1.6.0, 1.7.0" line in Markdown. null when neither is there, so
// the door doesn't guess and write over them.
export function fixVersionsOf(r) {
  for (const j of [r?.structuredContent, jsonIn(resultText(r))]) {
    const f = findFixVersions(j);
    if (f === undefined) continue;
    if (f == null) return [];
    if (Array.isArray(f)) return versionList(f);
    if (typeof f === 'string') return versionList(f.split(',').map((x) => x.trim()));
    return null;
  }
  const m = resultText(r).match(/^[\s>*|-]*\**\s*fix\s*versions?\s*\**\s*[:|]\s*\**\s*(.*?)\s*\|?\s*$/im);
  if (!m) return null;
  const line = m[1].replace(/\*\*/g, '').replace(/`/g, '').trim();
  if (!line || /^(none|-|—|n\/a|\[\]|\(none\))$/i.test(line)) return [];
  return versionList(line.split(',').map((x) => x.trim()));
}

// What an answer looks like, with no values in it: for an error, so a chat can say what came back.
export function shapeOf(r) {
  const j = r?.structuredContent ?? jsonIn(resultText(r));
  if (j && typeof j === 'object') {
    const keys = (o) => (Array.isArray(o) ? `a list of ${o.length}` : `keys ${Object.keys(o).slice(0, 15).join(', ')}`);
    const f = j.fields || j.issue?.fields;
    return `JSON with ${keys(j)}${f && typeof f === 'object' ? `; fields has ${keys(f)}` : ''}`;
  }
  const text = resultText(r);
  return text ? `text (not JSON), ${text.split('\n').length} lines` : 'nothing';
}

// The fix versions after the change, and whether anything changed. Names match as Jira's do,
// ignoring case and spaces around them; versions kept are sent by id, new ones by name.
export function change(had, cmd, versions) {
  const same = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();
  const after = cmd === 'add'
    ? [...had, ...versions.filter((v) => !had.some((h) => same(h.name, v))).map((name) => ({ name }))]
    : had.filter((h) => !versions.some((v) => same(h.name, v)));
  return { after, changed: after.length !== had.length };
}

const names = (vs) => (vs.length ? vs.map((v) => v.name).join(', ') : '(none)');

// The site as the server's cloudId: JIRA_MCP_SITE if set ("acme.atlassian.net" or a link), else
// the one the login sees (asked once, then kept with the login).
export function siteFrom(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  try {
    const u = new URL(/^https?:\/\//.test(t) ? t : `https://${t}`);
    return /^[a-z\d][a-z\d.-]*\.[a-z]{2,}$/i.test(u.hostname) ? `https://${u.hostname.toLowerCase()}` : null;
  } catch { return null; }
}

const siteError = (why) => Object.assign(new Error(`${why}. Set Jira site under Settings → Plugins → Jira versions (like acme.atlassian.net), or JIRA_URL for Clearsky's Jira`), { site: true });

// The sites the server's site list names, as https://xyz.atlassian.net: from its structured
// content or JSON text (a list, or { resources }, { sites } …), else any *.atlassian.net
// address in the text. Each site once.
export function sitesOf(r) {
  const out = new Set();
  const walk = (v, depth = 0) => {
    if (!v || typeof v !== 'object' || depth > 4) return;
    if (Array.isArray(v)) return v.forEach((x) => walk(x, depth + 1));
    const u = typeof v.url === 'string' ? siteFrom(v.url) : null;
    if (u) { out.add(u); return; }
    for (const x of Object.values(v)) walk(x, depth + 1);
  };
  walk(r?.structuredContent);
  const text = resultText(r);
  if (!out.size) { try { walk(JSON.parse(text)); } catch { /* not JSON */ } }
  if (!out.size) for (const m of text.matchAll(/\b[a-z\d][a-z\d-]*\.atlassian\.net\b/gi)) out.add(`https://${m[0].toLowerCase()}`);
  return [...out];
}

// Runs a checked command with an MCP client ({ listTools(), callTool(name, args) }).
// `ask(detail)` resolves true when you allowed the change in the chat.
export function createVersions({ client, site = () => null, clearskySite = () => null, keepSite = () => {} }) {
  let toolsAt = 0, tools = null;
  const list = async () => {
    if (!tools || Date.now() - toolsAt > 10 * 60_000) { tools = await client.listTools(); toolsAt = Date.now(); }
    return tools;
  };
  const need = (ts, step) => {
    const t = pickTool(ts, step);
    if (!t) throw new Error(`the server offers no tool to ${step === 'edit' ? 'edit' : 'read'} a Jira ticket to this login (does the login have Jira? log in again under Settings → Plugins → Jira versions)`);
    return t;
  };
  // The site: JIRA_MCP_SITE, else the Jira site Clearsky already uses (JIRA_URL, or the one acli
  // is logged in to), else the one site the login sees. The server takes the site's address as
  // its cloudId. Without one, nothing is sent: Jira would only answer with a validation error.
  const cloudId = async (ts) => {
    const s = site() || siteFrom(await Promise.resolve(clearskySite()).catch(() => null));
    if (s) return s;
    const t = pickTool(ts, 'sites');
    if (!t) throw siteError('the server offers no tool to list the sites this login sees');
    const r = await client.callTool(t.name, {});
    if (r?.isError) throw siteError(`the server wouldn't list your sites (${said(r)})`);
    const found = sitesOf(r);
    if (found.length > 1) throw siteError(`this login sees ${found.length} sites (${found.map((x) => new URL(x).host).join(', ')})`);
    if (!found.length) throw siteError('couldn\'t find a Jira site in what the server sent');
    keepSite(found[0]);
    return found[0];
  };
  const said = (r) => resultText(r).replace(/\s+/g, ' ').trim().slice(0, 600) || 'an error';

  return {
    // { code, stdout, stderr, decided, target }
    async run(c, ask) {
      if (c.cmd === 'help') return { code: 0, stdout: USAGE, stderr: '', decided: 'read' };
      const ts = await list();
      const read = need(ts, 'read');
      const edit = c.cmd === 'show' || c.cmd === 'raw' ? null : need(ts, 'edit');
      const id = read.inputSchema?.properties?.cloudId || edit?.inputSchema?.properties?.cloudId ? await cloudId(ts) : null;
      // Each ticket as it is now.
      const now = [];
      const target = c.keys.join(', ');
      // What the server sends for one ticket, as it is: to see why a read fails.
      if (c.cmd === 'raw') {
        const r = await client.callTool(read.name, argsFor(read, { cloudId: id, key: c.keys[0], fields: ['fixVersions'], json: true }));
        const text = resultText(r) || JSON.stringify(r?.structuredContent ?? r ?? null);
        return { code: r?.isError ? 1 : 0, stdout: `${read.name} ${JSON.stringify(Object.keys(read.inputSchema?.properties || {}))}\n${text.length > 20_000 ? `${text.slice(0, 20_000)}\n… (cut)` : text}`, stderr: '', decided: 'read', target };
      }
      for (const key of c.keys) {
        // Asked for just fixVersions, as JSON; if that has none we can read, the whole ticket.
        let r = await client.callTool(read.name, argsFor(read, { cloudId: id, key, fields: ['fixVersions'], json: true }));
        if (r?.isError) { now.push({ key, error: `Jira said: ${said(r)}` }); continue; }
        let had = fixVersionsOf(r);
        if (!had && read.inputSchema?.properties?.fields) {
          const whole = await client.callTool(read.name, argsFor(read, { cloudId: id, key, json: true }));
          if (!whole?.isError) { had = fixVersionsOf(whole); r = whole; }
        }
        now.push(had ? { key, had } : { key, error: `couldn't find its fix versions in what Jira sent (${shapeOf(r)}); \`jira-versions raw ${key}\` shows it` });
      }
      if (c.cmd === 'show') {
        const out = now.map((t) => (t.error ? `${t.key}: ${t.error}` : `${t.key}: ${names(t.had)}`)).join('\n');
        return { code: now.some((t) => t.error) ? 1 : 0, stdout: out, stderr: '', decided: 'read', target };
      }
      const plan = now.map((t) => (t.error ? t : { ...t, ...change(t.had, c.cmd, c.versions) }));
      const todo = plan.filter((t) => t.changed);
      const lines = plan.map((t) => (t.error ? `${t.key}: ${t.error}` : t.changed ? `${t.key}: ${names(t.had)} → ${names(t.after)}` : `${t.key}: ${names(t.had)} (${c.cmd === 'add' ? 'has it already' : 'doesn\'t have it'})`));
      if (!todo.length) return { code: plan.some((t) => t.error) ? 1 : 0, stdout: `Nothing to change.\n${lines.join('\n')}`, stderr: '', decided: 'nothing to change', target };
      const what = `${c.cmd === 'add' ? 'Add' : 'Remove'} fix version ${c.versions.join(', ')} ${c.cmd === 'add' ? 'to' : 'from'} ${todo.map((t) => t.key).join(', ')}`;
      if (!await ask(`${what}\n\n${lines.join('\n')}`)) {
        return { code: 1, stdout: '', stderr: 'Clearsky: you declined this Jira change. Ask what to do instead.\n', decided: 'declined', target };
      }
      let failed = plan.some((t) => t.error);
      for (const t of todo) {
        const fixVersions = t.after.map((v) => (v.id ? { id: v.id } : { name: v.name }));
        const r = await client.callTool(edit.name, argsFor(edit, { cloudId: id, key: t.key, fields: { fixVersions } }));
        if (r?.isError) { failed = true; t.result = `not changed: Jira said: ${said(r)}`; } else t.result = `now ${names(t.after)}`;
      }
      const out = plan.map((t) => (t.error ? `${t.key}: ${t.error}` : t.result ? `${t.key}: ${t.result}` : `${t.key}: ${names(t.had)} (unchanged)`)).join('\n');
      return { code: failed ? 1 : 0, stdout: out, stderr: '', decided: failed ? 'allowed, some failed' : 'allowed', target };
    },
  };
}

// ---------------------------------------------------------------- the login

export const DEFAULT_URL = 'https://mcp.atlassian.com/v2/mcp';
// Fixed, as the client registered for it is kept with the login (Confluence's is 19877).
export const REDIRECT = 'http://localhost:19878/oauth/callback';

// Of the scopes the server lists, the ones that read and write Jira work, and staying logged
// in. Nothing for Confluence or the rest of Atlassian.
export function jiraScopes(supported = []) {
  const keep = supported.filter((s) => (/jira/i.test(s) && /^(read|write):/i.test(s) && !/(admin|manage|delete)/i.test(s)) || ['offline_access', 'read:me', 'read:account'].includes(s));
  return keep.join(' ');
}

export function options(env = {}) {
  const scopes = String(env.JIRA_MCP_SCOPES || '').split(/[\s,]+/).filter(Boolean).join(' ');
  return { url: String(env.JIRA_MCP_URL || '').trim() || DEFAULT_URL, site: siteFrom(env.JIRA_MCP_SITE), scope: scopes || jiraScopes };
}

// The login and the client, with Clearsky's MCP parts (lends.mcpOAuth, lends.mcpClient).
// `store` keeps { access_token, refresh_token, …, client, site } in a file only you can read.
export function createJiraVersionsMcp({ lends, store, open = (u) => lends.openUrl(u), fetchImpl = fetch, now = () => Date.now() }) {
  const { login: oauthLogin, refresh, expiresSoon } = lends.mcpOAuth;
  let opts = options({}), client = null, clientFor = '';
  const use = (env) => { opts = options(env); };
  const notIn = () => Object.assign(new Error('not logged in for Jira fix versions; log in under Settings → Plugins → Jira versions'), { auth: true });

  async function token() {
    let t = store.get();
    if (!t?.access_token) throw notIn();
    if (expiresSoon(t, now())) { t = await refresh(t, { fetchImpl, now: now() }); store.set(t); }
    return t.access_token;
  }
  function mcp() {
    if (!client || clientFor !== opts.url) {
      client = lends.mcpClient.mcpClient({ url: opts.url, token, fetchImpl, onAuth: async () => {
        const t = store.get();
        if (!t?.refresh_token) throw Object.assign(new Error('Atlassian ended the login; log in again under Settings → Plugins → Jira versions'), { auth: true });
        store.set(await refresh(t, { fetchImpl, now: now() }));
      } });
      clientFor = opts.url;
    }
    return { listTools: () => client.tools(), callTool: (n, a) => client.callTool(n, a) };
  }
  const versions = () => createVersions({ client: mcp(), site: () => opts.site || store.get()?.site || null, clearskySite: () => lends.jiraSite?.(), keepSite: (site) => { const t = store.get(); if (t) store.set({ ...t, site }); } });

  return {
    use,
    status() {
      const t = store.get();
      if (!t?.access_token) return { loggedIn: false, detail: 'not logged in' };
      const site = opts.site || t.site;
      return { loggedIn: true, detail: `logged in ${new Date(t.at).toLocaleDateString()}${site ? `, ${new URL(site).host}` : ''}` };
    },
    async login() {
      const had = store.get();
      const t = await oauthLogin({ mcpUrl: opts.url, client: had?.client, redirectUri: REDIRECT, scope: opts.scope, open, clientName: 'Clearsky', fetchImpl, now });
      store.set({ ...t, site: null });
      client = null;
      const ts = await mcp().listTools();
      const ok = pickTool(ts, 'read') && pickTool(ts, 'edit');
      return { detail: ok ? 'Logged in; chats can now change fix versions, after you OK it.' : 'Logged in, but the server offers this login no tool to edit Jira tickets.' };
    },
    // The client registered stays, so the next login doesn't register another.
    logout() { const t = store.get(); store.set(t?.client ? { client: t.client } : null); client = null; },
    run: (cmd, ask) => versions().run(cmd, ask),
  };
}
