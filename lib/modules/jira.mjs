// Jira, through the Atlassian CLI only: your assigned tickets and the comments that @mention you.
//
// All Jira access goes through the Atlassian CLI, so authentication is whatever
// `acli jira auth login` set up. acli's JSON mirrors the Jira REST shapes, but the
// readers below are tolerant of small differences (wrappers, flat fields).

import { jiraHtml } from '../jira-rich.mjs';
import { replyNext, startNext } from '../items.mjs';

// What this module holds and reaches (shown in Settings → Plugins).
export const manifest = {
  name: 'jira', label: 'Jira', area: 'work', description: 'Your tickets and the comments that mention you, through the Atlassian CLI.',
  secrets: [{ kind: 'cli-login', note: 'none of its own: acli keeps your Atlassian login' }],
  clis: ['acli'],
  hosts: ['*.atlassian.net', 'api.atlassian.com'],
  files: [],
};

export const listOf = (out, ...keys) => {
  if (Array.isArray(out)) return out;
  for (const k of keys) if (Array.isArray(out?.[k])) return out[k];
  return [];
};

export const fieldsOf = (i) => i.fields || i;

export const nameOf = (v) => (v && typeof v === 'object' ? v.name ?? v.displayName ?? v.value : v) ?? null;
export const versionsOf = (f) => (Array.isArray(f.fixVersions) ? f.fixVersions.filter((v) => nameOf(v)).map((v) => ({ name: nameOf(v), released: !!v.released })) : []);

// Comment bodies are either wiki text or Atlassian Document Format (ADF).
export function commentInfo(body) {
  if (typeof body === 'string') {
    const ids = [...body.matchAll(/\[~(?:accountid:)?([^\]]+)\]/gi)].map((m) => m[1]);
    return { ids, text: body };
  }
  const ids = [], parts = [];
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (n.type === 'mention') { ids.push(n.attrs?.id); parts.push(`[~accountid:${n.attrs?.id}]`); }
    else if (n.type === 'text') parts.push(n.text);
    else if (['hardBreak', 'paragraph', 'heading', 'listItem', 'codeBlock', 'tableCell', 'tableHeader', 'blockquote', 'panel'].includes(n.type)) parts.push(' ');
    walk(n.content);
  };
  walk(body);
  return { ids: ids.filter(Boolean), text: parts.join('') };
}

export function excerpt(text, myId, max = 220) {
  const plain = (text || '')
    .replaceAll(`[~accountid:${myId}]`, '@you').replaceAll(`[~${myId}]`, '@you')
    .replace(/\[~[^\]]+\]/g, '@someone')
    .replace(/\{(code|noformat|quote|panel)[^}]*\}/g, '')
    .replace(/\[([^|\]]+)\|[^\]]+\]/g, '$1')
    .replace(/[*_]{1,2}([^*_]+)[*_]{1,2}/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > max ? `${plain.slice(0, max - 3)}...` : plain;
}

export const userId = (u) => u?.accountId || u?.name || u?.key || null;

// Run fn over items with limited parallelism (acli is a process per call).
export async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

// Statuses where a ticket waits on someone else (a reviewer, QA, another team), not on you.
export const JIRA_WAITING = /review|\bqa\b|verif|test|blocked|waiting|on hold|pending/i;

// One entry per ticket, from its newest mention. Its stamp is that comment's id, so a dismissed
// ticket comes back only when someone mentions you there again.
export function jiraMentionsByTicket(mentions = []) {
  const byKey = new Map();
  for (const m of [...mentions].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))) {
    const t = byKey.get(m.key);
    if (t) { t.count++; if (!t.people.includes(m.by)) t.people.push(m.by); continue; }
    byKey.set(m.key, { ...m, count: 1, people: [m.by], dismissKey: `jira-mention:${m.key}` });
  }
  return [...byKey.values()];
}

export const PROJECT_KEY = /^[A-Z][A-Z0-9_]{0,49}$/;

// A value inside a JQL "string": backslashes and quotes escaped.
export const jqlText = (s) => String(s).replace(/[\\"]/g, (c) => `\\${c}`);

// Starred projects from the setting (JIRA_STARRED_PROJECTS: "ABC, OPS"), in the order saved.
export const starredProjects = (v) => [...new Set(String(v || '').toUpperCase().split(/[\s,]+/).filter((k) => PROJECT_KEY.test(k)))];

// Fix versions, archived ones left out: unreleased first by release date (no date last),
// then released ones, newest first.
export function sortVersions(list = []) {
  const byName = new Map();
  for (const v of list) {
    const name = nameOf(v);
    if (!name || v.archived || byName.has(name)) continue;
    byName.set(name, { name, released: !!v.released, releaseDate: v.releaseDate || null, overdue: !!v.overdue, description: v.description || '' });
  }
  const t = (v) => (v.releaseDate ? Date.parse(v.releaseDate) : NaN);
  const open = [...byName.values()].filter((v) => !v.released).sort((a, b) => (t(a) || Infinity) - (t(b) || Infinity) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  const done = [...byName.values()].filter((v) => v.released).sort((a, b) => (t(b) || 0) - (t(a) || 0) || b.name.localeCompare(a.name, undefined, { numeric: true }));
  return [...open, ...done];
}

// How far a version is: tickets per status category, and per status in board order.
export function versionSummary(issues = []) {
  const cats = { new: 0, indeterminate: 0, done: 0 };
  const statuses = new Map();
  for (const i of issues) {
    const c = i.statusCategory in cats ? i.statusCategory : 'new';
    cats[c]++;
    const s = statuses.get(i.status) || { name: i.status, category: c, count: 0 };
    s.count++;
    statuses.set(i.status, s);
  }
  const order = { new: 0, indeterminate: 1, done: 2 };
  return { total: issues.length, ...cats, statuses: [...statuses.values()].sort((a, b) => order[a.category] - order[b.category] || b.count - a.count) };
}

export function mergeJira(work, mentions) {
  const error = work.error || mentions.error;
  return { ...mentions, ...work, error: error || undefined, mentionsError: mentions.error };
}

// acli gives up on Jira by itself after about 60 s ("failed to search work items"); wait a
// little longer so its own error is what you see.
const ACLI_TIMEOUT = 90_000;

// acli's own words when it fails. It often writes its error to stdout, not stderr, and a
// timeout leaves both empty, so say what happened instead of only "Command failed: <command>".
const AUTH_TROUBLE = /unauthori[sz]ed|\b401\b|not (?:logged|authenticated)|log ?in again|auth(?:entication)? (?:failed|expired|required)|token (?:has )?expired|session (?:has )?expired|acli jira auth login/i;
export function acliError(args, e) {
  const clean = (t) => String(t || '').replace(/\x1b\[[0-9;]*m/g, '').trim();
  const said = [clean(e.stderr), clean(e.stdout)].filter(Boolean).join('\n');
  const lines = said.split('\n').map((l) => l.trim()).filter(Boolean);
  let why;
  if (e.killed && e.signal) why = `no answer within ${ACLI_TIMEOUT / 1000}s (stopped). acli may not be reaching Jira: try logging in again`;
  else if (lines.length) why = lines.slice(-4).join(' ').slice(0, 600);
  else why = `exited with ${e.code ?? e.signal ?? 'an error'} and said nothing`;
  const auth = AUTH_TROUBLE.test(said);
  const err = new Error(`acli jira ${args.slice(0, 2).join(' ')} failed: ${why}${auth ? ' (the Atlassian login looks expired: log in again in Settings → Plugins → Jira)' : ''}`);
  if (auth) err.auth = true;
  err.acli = { code: e.code ?? null, signal: e.signal ?? null, stderr: clean(e.stderr).slice(-4000), stdout: clean(e.stdout).slice(-4000) };
  return err;
}

// The parts that run acli. `config.jira` holds the acli path, the site, account id and queries.
export function createJira({ config, execFileP, settle }) {
  // acli with its input closed: if it wants to ask something (a login, a keyring unlock), it
  // gets end-of-input and fails at once with its own words instead of waiting for the timeout.
  const run = (args, opts) => {
    const p = execFileP(config.jira.acli, args, opts);
    p.child?.stdin?.end();
    return p;
  };
  async function acli(args) {
    try {
      const { stdout } = await run(['jira', ...args], { maxBuffer: 32 * 1024 * 1024, timeout: ACLI_TIMEOUT });
      return stdout.trim() ? JSON.parse(stdout) : null;
    } catch (e) {
      if (e.code === 'ENOENT') throw new Error(`acli not found (looked for "${config.jira.acli}"); install it or set ACLI_BIN`);
      if (e instanceof SyntaxError) throw new Error(`acli returned non-JSON output for "jira ${args.slice(0, 2).join(' ')}"`);
      throw acliError(args, e);
    }
  }

  // acli only accepts some fields in search (e.g. it rejects duedate, updated, project).
  // Drop whatever it refuses and remember that for later searches.
  const refusedFields = new Set();

  async function jiraSearch(jql, fields, limit = 50) {
    const wanted = fields.filter((f) => !refusedFields.has(f));
    try {
      const out = await acli(['workitem', 'search', '--jql', jql, '--fields', wanted.join(','), '--limit', String(limit), '--json']);
      return listOf(out, 'issues', 'workItems', 'values', 'results');
    } catch (e) {
      const m = e.message.match(/fields? '([^']+)' (?:are|is) not allowed/);
      const refused = m ? m[1].split(',').map((f) => f.trim()).filter((f) => wanted.includes(f)) : [];
      if (!refused.length) throw e;
      refused.forEach((f) => refusedFields.add(f));
      return jiraSearch(jql, fields, limit);
    }
  }

  // `workitem comment list` flattens bodies to plain text and drops @mentions, so read the
  // comments through `workitem view`, which keeps the rich-text (ADF) body and author objects.
  async function jiraComments(key) {
    const out = await acli(['workitem', 'view', key, '--fields', 'comment', '--json']);
    const f = out?.fields || out || {};
    return listOf(f.comment, 'comments', 'values');
  }

  // acli has no JSON "whoami", so find myself on an issue I'm assigned to, reported or created.
  // Found once and kept: it doesn't change. When acli itself fails, that error is passed on.
  let me = null;
  async function jiraMe() {
    if (config.jira.accountId) return { id: config.jira.accountId, name: null };
    if (me) return me;
    let failed = null;
    for (const field of ['assignee', 'reporter', 'creator']) {
      let issue;
      try { [issue] = await jiraSearch(`${field} = currentUser() ORDER BY updated DESC`, ['key', field], 1); }
      catch (e) { failed ||= e; continue; }
      const u = issue && fieldsOf(issue)[field];
      if (userId(u)) return (me = { id: userId(u), name: u.displayName || null });
    }
    if (failed) throw failed;
    throw new Error('no Jira ticket names you yet (as assignee, reporter or creator), so mentions can\'t be matched to you');
  }

  // The site to link to. acli's `self` URLs point at an internal API host (*.atl-paas.net),
  // so ask `acli jira auth status`, which names the real site (xyz.atlassian.net).
  let jiraBase = null;

  let jiraSitePending = null;

  function jiraSite() {
    if (config.jira.url) return Promise.resolve(config.jira.url);
    jiraSitePending ||= run(['jira', 'auth', 'status'], { timeout: 15_000 })
      .then(({ stdout, stderr }) => `${stdout}\n${stderr}`, (e) => `${e.stdout || ''}\n${e.stderr || ''}`)
      .then((out) => {
        const site = out.match(/[\w-]+\.atlassian\.net/)?.[0];
        if (site) jiraBase = `https://${site}`;
        else jiraSitePending = null; // try again next time
        return jiraBase;
      });
    return jiraSitePending;
  }

  function browseUrl(issue) {
    const self = issue.self ? new URL(issue.self).origin : null;
    const base = config.jira.url || jiraBase || (self && /\.atlassian\.net$/.test(self) ? self : '');
    return base ? `${base}/browse/${issue.key}` : null;
  }

  async function fetchJiraWork() {
    await jiraSite();
    const assigned = (await jiraSearch(config.jira.assignedJql,
      ['key', 'summary', 'status', 'priority', 'duedate', 'updated', 'issuetype', 'project', 'assignee'], 100)).map((i) => {
      const f = fieldsOf(i);
      return {
        key: i.key,
        summary: f.summary,
        url: browseUrl(i),
        status: nameOf(f.status),
        statusCategory: f.status?.statusCategory?.key || null, // new | indeterminate | done
        waiting: f.status?.statusCategory?.key === 'indeterminate' && JIRA_WAITING.test(nameOf(f.status) || ''),
        priority: nameOf(f.priority),
        type: nameOf(f.issuetype),
        assignee: f.assignee?.displayName || null,
        project: f.project?.key || i.key?.split('-')[0] || null,
        due: f.duedate || null,
        updatedAt: f.updated || null,
        // acli often refuses `updated`, so fall back to the status.
        stamp: f.updated || nameOf(f.status) || '',
      };
    });
    // acli won't give fix versions in a search, only per ticket: read each once, then again
    // only when it changed.
    await mapLimit(assigned, 4, async (t) => {
      const hit = versionCache.get(t.key);
      if (!hit || hit.stamp !== t.stamp) {
        try { versionCache.set(t.key, { stamp: t.stamp, versions: versionsOf(fieldsOf(await acli(['workitem', 'view', t.key, '--fields', 'fixVersions', '--json']) || {})) }); } catch { return; }
      }
      t.fixVersions = versionCache.get(t.key).versions;
    });
    return { assigned };
  }
  const versionCache = new Map();

  // The slow part: one acli call per candidate issue, so it's loaded separately.
  async function fetchJiraMentions() {
    await jiraSite();
    // Find candidate issues, then confirm the mention by reading their comments.
    const me = await jiraMe();
    const days = config.days;
    const involved = 'watcher = currentUser() OR assignee = currentUser() OR reporter = currentUser()';
    const fields = ['key', 'summary', 'status'];
    let candidates;
    try {
      candidates = await jiraSearch(config.jira.mentionsJql ||
        `comment ~ currentUser() AND updated >= -${days}d ORDER BY updated DESC`, fields, 40);
    } catch (e) {
      if (config.jira.mentionsJql) throw e;
      // Some Jira sites reject `comment ~ currentUser()`; fall back to issues I'm involved in.
      candidates = await jiraSearch(`updated >= -${days}d AND (${involved}) ORDER BY updated DESC`, fields, 40);
    }

    const cutoff = Date.now() - days * 864e5;
    const perIssue = await mapLimit(candidates, 4, async (issue) => {
      const f = fieldsOf(issue);
      const found = [];
      for (const c of await jiraComments(issue.key)) {
        if (userId(c.author) === me.id || Date.parse(c.created) < cutoff) continue;
        const { ids, text } = commentInfo(c.body);
        if (!ids.some((id) => id.toLowerCase() === me.id.toLowerCase())) continue;
        const url = browseUrl(issue);
        found.push({
          key: issue.key,
          summary: f.summary,
          status: nameOf(f.status),
          url: url && c.id ? `${url}?focusedCommentId=${c.id}` : url,
          by: c.author?.displayName || 'someone',
          at: c.created,
          stamp: c.id || c.created,
          excerpt: excerpt(text, me.id),
          // The comment with its formatting, for the item page (lib/jira-rich.mjs).
          html: jiraHtml(c.body).slice(0, 50_000),
        });
      }
      return found;
    });
    const mentions = perIssue.flat().sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

    return { user: me.name, mentions, tickets: jiraMentionsByTicket(mentions) };
  }

  async function fetchJira() {
    const [work, mentions] = await Promise.all([settle(fetchJiraWork()), settle(fetchJiraMentions())]);
    return mergeJira(work, mentions);
  }

  // Hover-card details for one issue.
  const issueCache = new Map();

  async function issuePreview(key) {
    const hit = issueCache.get(key);
    if (hit && Date.now() - hit.at < 10 * 6e4) return hit.data;
    await jiraSite();
    const out = await acli(['workitem', 'view', key, '--fields', 'summary,status,assignee,reporter,priority,issuetype,fixVersions,description', '--json']);
    const f = out?.fields || out || {};
    const text = f.description ? commentInfo(f.description).text : '';
    const data = {
      key,
      url: browseUrl({ key, self: out?.self }),
      summary: f.summary || '',
      status: nameOf(f.status),
      statusCategory: f.status?.statusCategory?.key || null,
      type: nameOf(f.issuetype),
      priority: nameOf(f.priority),
      assignee: f.assignee?.displayName || null,
      fixVersions: versionsOf(f),
      reporter: f.reporter?.displayName || null,
      description: excerpt(text, null, 600),
      // The whole description with its formatting, for the ticket page (lib/jira-rich.mjs).
      descriptionHtml: f.description ? jiraHtml(f.description).slice(0, 200_000) : '',
    };
    issueCache.set(key, { at: Date.now(), data });
    return data;
  }

  // A ticket's goal for a review: its summary and its whole description (acceptance criteria
  // and all), nothing else: no comments, no people.
  async function ticketGoal(key) {
    await jiraSite();
    const out = await acli(['workitem', 'view', key, '--fields', 'summary,issuetype,description', '--json']);
    const f = out?.fields || out || {};
    return { key, type: nameOf(f.issuetype), summary: f.summary || '', description: (f.description ? commentInfo(f.description).text : '').slice(0, 12_000) };
  }

  // ---- Projects and versions (the Versions page): pick projects to star, then a fix version.

  // Every project you can see, for starring. acli's list is paged; ask for all of it.
  async function jiraProjects() {
    await jiraSite();
    let out;
    try { out = await acli(['project', 'list', '--paginate', '--json']); }
    catch { out = await acli(['project', 'list', '--limit', '500', '--json']); }
    return listOf(out, 'values', 'projects', 'results')
      .map((p) => ({ key: p.key, name: p.name || p.key }))
      .filter((p) => PROJECT_KEY.test(p.key || ''))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  // A project's fix versions: from the project itself when acli includes them, else gathered
  // from its tickets (acli has no versions command of its own).
  const versionsCache = new Map();
  async function projectVersions(key, force = false) {
    const hit = versionsCache.get(key);
    if (!force && hit && Date.now() - hit.at < 10 * 6e4) return hit.data;
    await jiraSite();
    let list = [];
    try {
      const out = await acli(['project', 'view', '--key', key, '--json']);
      list = listOf(out?.versions ?? out?.project?.versions ?? out?.fields?.versions, 'values', 'versions');
    } catch { /* gather them from the tickets below */ }
    if (!list.length) {
      const issues = await jiraSearch(`project = "${jqlText(key)}" AND fixVersion is not EMPTY ORDER BY updated DESC`, ['key', 'fixVersions'], 100);
      list = issues.flatMap((i) => fieldsOf(i).fixVersions || []);
      // A search that won't give fix versions: read them from the newest tickets one by one.
      if (!list.length) {
        const per = await mapLimit(issues.slice(0, 25), 4, (i) => acli(['workitem', 'view', i.key, '--fields', 'fixVersions', '--json']).catch(() => null));
        list = per.flatMap((o) => fieldsOf(o || {}).fixVersions || []);
      }
    }
    const data = sortVersions(list);
    versionsCache.set(key, { at: Date.now(), data });
    return data;
  }

  // The tickets in one fix version of a project, with what the Versions page filters on.
  const versionIssueCache = new Map();
  async function versionIssues(key, version, force = false) {
    const ck = `${key}\n${version}`, hit = versionIssueCache.get(ck);
    if (!force && hit && Date.now() - hit.at < 2 * 6e4) return hit.data;
    await jiraSite();
    const limit = 500;
    const found = await jiraSearch(`project = "${jqlText(key)}" AND fixVersion = "${jqlText(version)}" ORDER BY priority DESC, key ASC`,
      ['key', 'summary', 'status', 'assignee', 'issuetype', 'priority', 'updated'], limit);
    const issues = found.map((i) => {
      const f = fieldsOf(i);
      return {
        key: i.key,
        summary: f.summary || '',
        url: browseUrl(i),
        status: nameOf(f.status) || 'Unknown',
        statusCategory: f.status?.statusCategory?.key || null, // new | indeterminate | done
        type: nameOf(f.issuetype),
        priority: nameOf(f.priority),
        assignee: f.assignee?.displayName || null,
        updatedAt: f.updated || null,
      };
    });
    const data = { project: key, version, issues, truncated: found.length >= limit, checkedAt: new Date().toISOString() };
    versionIssueCache.set(ck, { at: Date.now(), data });
    return data;
  }

  // Print raw acli output, to check the shapes if Jira data looks wrong.
  async function jiraDebug() {
    const [first] = await jiraSearch(config.jira.assignedJql, ['key', 'summary', 'status', 'assignee'], 1);
    console.log('workitem search --json (first item):\n', JSON.stringify(first, null, 2));
    if (first) console.log(`\nview ${first.key} --fields comment --json (first 2 comments):\n`,
      JSON.stringify((await jiraComments(first.key)).slice(0, 2), null, 2));
  }

  return { acli, jiraSearch, jiraComments, jiraMe, jiraSite, browseUrl, fetchWork: fetchJiraWork, fetchMentions: fetchJiraMentions,
    fetchJira, issuePreview, ticketGoal, jiraDebug, jiraProjects, projectVersions, versionIssues, get site() { return config.jira.url || jiraBase; } };
}

// Your tickets as work items (see lib/items.mjs): in progress first, then to do.
export function workItems(j) {
  if (!j || j.error) return [];
  const cat = (i) => (i.statusCategory === 'indeterminate' ? 0 : 1);
  return [...(j.assigned || [])].sort((a, b) => cat(a) - cat(b)).map((i) => ({ group: i.waiting ? 'waiting' : 'tickets', kind: 'ticket', src: 'Jira',
    k: i.url, url: i.url, stamp: i.stamp, issue: i.key, ref: i.key,
    title: i.summary, step: [i.status, i.type, i.priority && `${i.priority} priority`].filter(Boolean).join(' · '),
    glyph: i.waiting ? 'wait' : cat(i) ? 'todo' : 'prog', label: i.waiting ? [i.status.toLowerCase()] : i.due ? [`due ${i.due}`, 'amber'] : [cat(i) ? 'to do' : 'in progress'],
    at: i.updatedAt, next: i.waiting ? { label: `Waiting: ${i.status}`, wait: true } : startNext(), data: i }));
}

// Tickets where someone @mentioned you, one row each.
export function mentionItems(jm) {
  if (!jm || jm.error) return [];
  return (jm.tickets || []).map((t) => ({ group: 'needs', kind: 'mention', src: 'Jira', k: t.dismissKey || t.url, url: t.url, stamp: t.stamp, dismissKey: t.dismissKey,
    issue: t.key, ref: t.key, title: t.summary, step: `${t.people.join(', ')}${t.count > 1 ? ` · ${t.count} mentions` : ''}`, quote: t.excerpt, quoteHtml: t.html || null, glyph: 'ment',
    label: ['Jira'], at: t.at, next: replyNext(t.url), data: t }));
}
