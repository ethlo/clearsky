// Jira, through the Atlassian CLI only: your assigned tickets and the comments that @mention you.
//
// All Jira access goes through the Atlassian CLI, so authentication is whatever
// `acli jira auth login` set up. acli's JSON mirrors the Jira REST shapes, but the
// readers below are tolerant of small differences (wrappers, flat fields).

import { replyNext, startNext } from '../items.mjs';

// What this module holds and reaches (shown in Settings → Modules).
export const manifest = {
  name: 'jira', label: 'Jira', area: 'work',
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
    else if (n.type === 'hardBreak' || n.type === 'paragraph') parts.push(' ');
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

export function mergeJira(work, mentions) {
  const error = work.error || mentions.error;
  return { ...mentions, ...work, error: error || undefined, mentionsError: mentions.error };
}

// The parts that run acli. `config.jira` holds the acli path, the site, account id and queries.
export function createJira({ config, execFileP, settle }) {
  async function acli(args) {
    try {
      const { stdout } = await execFileP(config.jira.acli, ['jira', ...args], { maxBuffer: 32 * 1024 * 1024, timeout: 60_000 });
      return stdout.trim() ? JSON.parse(stdout) : null;
    } catch (e) {
      if (e.code === 'ENOENT') throw new Error(`acli not found (looked for "${config.jira.acli}"); install it or set ACLI_BIN`);
      if (e instanceof SyntaxError) throw new Error(`acli returned non-JSON output for "jira ${args.slice(0, 2).join(' ')}"`);
      const msg = (e.stderr || e.message || '').toString().trim().split('\n').slice(-3).join(' ');
      throw new Error(`acli jira ${args.slice(0, 2).join(' ')} failed: ${msg}`);
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

  // acli has no JSON "whoami", so find myself on an issue I'm assigned to or reported.
  async function jiraMe() {
    if (config.jira.accountId) return { id: config.jira.accountId, name: null };
    for (const [jql, field] of [['assignee = currentUser() ORDER BY updated DESC', 'assignee'], ['reporter = currentUser() ORDER BY updated DESC', 'reporter']]) {
      const [issue] = await jiraSearch(jql, ['key', field], 1).catch(() => []);
      const u = issue && fieldsOf(issue)[field];
      if (userId(u)) return { id: userId(u), name: u.displayName || null };
    }
    throw new Error('could not work out your Jira account id; set JIRA_ACCOUNT_ID');
  }

  // The site to link to. acli's `self` URLs point at an internal API host (*.atl-paas.net),
  // so ask `acli jira auth status`, which names the real site (xyz.atlassian.net).
  let jiraBase = null;

  let jiraSitePending = null;

  function jiraSite() {
    if (config.jira.url) return Promise.resolve(config.jira.url);
    jiraSitePending ||= execFileP(config.jira.acli, ['jira', 'auth', 'status'], { timeout: 15_000 })
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
      ['key', 'summary', 'status', 'priority', 'duedate', 'updated', 'issuetype', 'project'], 100)).map((i) => {
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
        project: f.project?.key || i.key?.split('-')[0] || null,
        due: f.duedate || null,
        updatedAt: f.updated || null,
        // acli often refuses `updated`, so fall back to the status.
        stamp: f.updated || nameOf(f.status) || '',
      };
    });
    return { assigned };
  }

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
    const out = await acli(['workitem', 'view', key, '--fields', 'summary,status,assignee,reporter,priority,issuetype,description', '--json']);
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
      reporter: f.reporter?.displayName || null,
      description: excerpt(text, null, 600),
    };
    issueCache.set(key, { at: Date.now(), data });
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
    fetchJira, issuePreview, jiraDebug, get site() { return config.jira.url || jiraBase; } };
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
    issue: t.key, ref: t.key, title: t.summary, step: `${t.people.join(', ')}${t.count > 1 ? ` · ${t.count} mentions` : ''}`, quote: t.excerpt, glyph: 'ment',
    label: ['Jira'], at: t.at, next: replyNext(t.url), data: t }));
}
