// The list of chats: every agent's sessions with what each is doing now, and which pull request
// or ticket a chat belongs to.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import * as localState from '../state.mjs';
import { sessionEvents } from '../copilot-events.mjs';
import { stateFile, backend, installedAgents } from './config.mjs';
import { sourceCache } from './work.mjs';
import { sessionAgent, workspaceInfo, copilotHome, acpChats, sessionsCache, keepSessions } from './chat-env.mjs';
import { CONTEXT_INTRO, MSG_MARK, typedPart, REFS_INTRO } from './chat-hints.mjs';
import { jobs, withAgent } from './chat.mjs';

// Sessions open in a running Copilot (terminal, editor): the process keeps an
// inuse.<pid>.hold file in the session's folder while it has the session open.
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
// A sandboxed Copilot writes its pid as seen inside the sandbox (17, say), which out here is some
// other process, often a kernel thread that never ends. So on Linux the pid must be a Copilot.
function isCopilot(pid) {
  if (!alive(pid)) return false;
  if (process.platform !== 'linux') return true;
  try { return /copilot/i.test(readFileSync(`/proc/${pid}/cmdline`, 'utf8')); } catch { return false; }
}
function openCopilotSessions() {
  const dir = join(copilotHome(), 'session-state');
  let state = {};
  try { state = JSON.parse(readFileSync(join(copilotHome(), 'open-sessions-state.json'), 'utf8')) || {}; } catch {}
  const open = {};
  let ids = [];
  try { ids = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch {}
  for (const id of ids) {
    let files = [];
    try { files = readdirSync(join(dir, id)); } catch {}
    const pids = files.map((f) => Number(f.match(/^inuse\.(\d+)\.hold$/)?.[1])).filter((n) => n && isCopilot(n));
    if (pids.length) open[id] = { working: !!state[id]?.working && Date.now() - (Date.parse(state[id]?.refreshedAt) || 0) < 15 * 6e4 };
  }
  return open;
}

// A session started here is named after the dashboard and items Clearsky put in front of
// your message; show what you typed instead (and never match PRs or tickets on the rest).
export function sessionTitle(title, typed) {
  if (!title || !(title.startsWith(CONTEXT_INTRO.slice(0, 30)) || title.startsWith(REFS_INTRO))) return title || null;
  const own = typed || (title.includes(MSG_MARK) ? typedPart(title) : '');
  return own.trim().split('\n')[0].slice(0, 120) || 'Chat from Clearsky';
}

// Sessions of every agent installed here, each with the agent it belongs to. One agent that
// can't list them doesn't hide the other's (unless it's the only one).
export async function copilotSessions(_bin, force) {
  if (!force && sessionsCache && Date.now() - sessionsCache.at < 30_000) return withStatus(sessionsCache.data);
  const names_ = installedAgents();
  const lists = await Promise.allSettled(names_.map((n) => withAgent(n, (a) => a.listSessions()).then((l) => l.map((x) => ({ ...x, agent: n })))));
  if (lists.every((x) => x.status === 'rejected')) throw lists[0].reason;
  const list = lists.flatMap((x) => (x.status === 'fulfilled' ? x.value : []));
  const titles = localState.sessionTitles(stateFile), names = localState.sessionNames(stateFile);
  const data = list.map((x) => ({ id: x.sessionId, agent: x.agent, title: names[x.sessionId] || sessionTitle(x.title, titles[x.sessionId]), cwd: x.cwd || null, updatedAt: x.updatedAt || null }))
    .sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));
  keepSessions(data);
  return withStatus(data);
}

// Where each session is at, worked out fresh each time:
//   working: Copilot is busy on it (here, or in a terminal or editor);
//   needs-you: it asked to use a tool and waits for your answer (here);
//   waiting: open in a terminal or here, done with its turn, waiting for your next message;
//   closed: not open anywhere.
// Waiting for your answer on something that is this chat's (not a GitHub change that may be another's).
export const needsYou = (c) => !!c && [...c.waiting.keys()].some((id) => !c.shared?.has(id));
function withStatus(list) {
  const open = openCopilotSessions();
  return list.map((x) => {
    const c = acpChats.get(x.id);
    const status = needsYou(c) ? 'needs-you' : c?.busy || open[x.id]?.working ? 'working'
      : jobs.running(x.id).length ? 'background' : c || open[x.id] ? 'waiting' : 'closed';
    return { ...x, open: !!open[x.id] && !c, working: status === 'working', here: !!c, status };
  });
}

// Which Copilot sessions belong to which PR or ticket ("pr:org/repo#12", "issue:ABC-1"): the
// items you attached in Clearsky, the branch a terminal session worked on (matched to its
// PR, and the ticket key in its name), and ticket keys in the session's title.
export function linkSessions(sessions, { prs = [], refs = {}, workspace = () => ({}) } = {}) {
  // workspace.yaml may hold "org/repo" or a clone URL.
  const repoOf = (r) => (r || '').replace(/\.git$/i, '').replace(/^.*[:/]([^/:]+\/[^/]+)$/, '$1').toLowerCase();
  const byBranch = new Map(prs.filter((p) => p.branch).map((p) => [`${repoOf(p.repo)}@${p.branch}`, `pr:${p.repo}#${p.number}`]));
  const byNumber = new Map(prs.map((p) => [`${repoOf(p.repo)}#${p.number}`, `pr:${p.repo}#${p.number}`]));
  const links = {};
  for (const x of sessions) {
    const keys = new Set(refs[x.id] || []);
    const ws = workspace(x.id);
    const repo = repoOf(ws.repository);
    for (const branch of ws.branches || [ws.branch]) {
      const pr = repo && branch && byBranch.get(`${repo}@${branch}`);
      if (pr) keys.add(pr);
    }
    // A PR named in the title: its URL anywhere, or "#123" / "PR 123" in a session in that repo.
    for (const m of (x.title || '').matchAll(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/gi)) {
      const pr = byNumber.get(`${m[1].toLowerCase()}#${m[2]}`);
      if (pr) keys.add(pr);
    }
    for (const m of (x.title || '').matchAll(/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)/gi)) keys.add(`gh:${m[1]}#${m[2]}`);
    if (repo) for (const m of (x.title || '').matchAll(/(?:#|\bPR\s*#?)(\d+)\b/gi)) {
      const pr = byNumber.get(`${repo}#${m[1]}`);
      if (pr) keys.add(pr);
    }
    for (const m of `${(ws.branches || [ws.branch]).join(' ')} ${x.title || ''}`.toUpperCase().matchAll(/\b([A-Z][A-Z0-9_]+-\d+)\b/g)) keys.add(`issue:${m[1]}`);
    for (const k of keys) (links[k] ||= []).push({ id: x.id, title: x.title || 'Untitled session', updatedAt: x.updatedAt, cwd: x.cwd, status: x.status || 'closed' });
  }
  // A PR, its Jira ticket (the key in its title or branch) and the GitHub issues it closes are
  // one piece of work: a session linked to any of them shows on all of them.
  for (const p of prs) {
    const keys = [`pr:${p.repo}#${p.number}`,
      ...[...`${p.title || ''} ${p.branch || ''}`.toUpperCase().matchAll(/\b([A-Z][A-Z0-9_]+-\d+)\b/g)].map((m) => `issue:${m[1]}`),
      ...(p.issues || []).map((i) => `gh:${i}`)];
    const all = keys.flatMap((k) => links[k] || []).filter((x, i, a) => a.findIndex((y) => y.id === x.id) === i);
    if (all.length) for (const k of keys) links[k] = all;
  }
  for (const k of Object.keys(links)) links[k] = links[k].sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0)).slice(0, 3);
  return links;
}

export function ticketPr(ref) {
  if (!ref) return null;
  const gh = sourceCache.get('github')?.data || {};
  return [...(gh.myPrs || []), ...(gh.reviewRequested || [])].find((p) => new RegExp(`\\b${ref.key}\\b`, 'i').test(`${p.title} ${p.branch || ''}`)) || null;
}

// The name a chat started on an item gets: "ABC-6519 · Fix capture timeout", or for a PR
// without a ticket key "abc#1187 · Fix capture timeout". Continuing work then finds it again.
export function itemSessionName(ref, cache = (n) => sourceCache.get(n)?.data || {}) {
  const gh = cache('github'), jira = cache('jira'), jm = cache('jiraMentions');
  if (ref.kind === 'pr') {
    const p = [...(gh.myPrs || []), ...(gh.reviewRequested || [])].find((x) => x.repo === ref.repo && x.number === Number(ref.number));
    const key = `${p?.title || ''} ${p?.branch || ''}`.toUpperCase().match(/\b([A-Z][A-Z0-9_]+-\d+)\b/)?.[1];
    const title = (p?.title || '').replace(new RegExp(`\\[?${key}\\]?:?\\s*`, 'i'), '').trim();
    return `${key ? `${key} · ` : ''}${ref.repo.split('/').pop()}#${ref.number}${title ? ` · ${title}` : ''}`.slice(0, 100);
  }
  if (ref.kind === 'gh') {
    const i = [...(gh.assigned || []), ...(gh.mentions || [])].find((x) => x.repo === ref.repo && x.number === Number(ref.number));
    return `${ref.repo.split('/').pop()}#${ref.number}${i?.title ? ` · ${i.title}` : ''}`.slice(0, 100);
  }
  const t = (jira.assigned || []).find((x) => x.key === ref.key) || (jm.tickets || []).find((x) => x.key === ref.key);
  return `${ref.key}${t?.summary ? ` · ${t.summary}` : ''}`.slice(0, 100);
}

export async function copilotLinks(bin) {
  const sessions = await copilotSessions(bin);
  const recent = sessions.filter((x) => x.status !== 'closed' || Date.now() - (Date.parse(x.updatedAt) || 0) < 60 * 864e5);
  const gh = sourceCache.get('github')?.data || {};
  // Copilot's own log: every branch a session worked on (workspace.yaml only has the one it
  // started or last resumed on), and the steps it took, for sessions from the last two weeks.
  // Copilot's session log (lib/copilot-events.mjs).
  const events = new Map(recent.filter((x) => x.agent === 'copilot' && Date.now() - (Date.parse(x.updatedAt) || 0) < 14 * 864e5).map((x) => [x.id, sessionEvents(copilotHome(), x.id)]));
  const cwdOf = new Map(recent.map((x) => [x.id, x.cwd]));
  const workspace = (id) => { const ws = workspaceInfo(id, cwdOf.get(id)); return { ...ws, branches: [...new Set([...(events.get(id)?.branches || []), ws.branch].filter(Boolean))] }; };
  const links = linkSessions(recent, { prs: [...(gh.myPrs || []), ...(gh.reviewRequested || [])], refs: localState.sessionRefs(stateFile), workspace });
  // The latest step Copilot took on each item, from any session linked to it.
  const actions = {};
  for (const [k, list] of Object.entries(links)) {
    for (const x of list) for (const a of events.get(x.id)?.actions || []) {
      if ((a.key && a.key !== k) || (actions[k] && actions[k].at >= a.at)) continue;
      actions[k] = { text: a.text, at: a.at, session: x.id };
    }
  }
  // Every session that is busy or waiting on you, linked to an item or not.
  const live = sessions.filter((x) => x.status !== 'closed').map(({ id, title, updatedAt, cwd, status }) => ({ id, title: title || 'Untitled session', updatedAt, cwd, status }));
  // Chats running here that Copilot doesn't list yet (before their first answer is saved).
  const titles = localState.sessionTitles(stateFile), names = localState.sessionNames(stateFile);
  for (const [id, c] of acpChats) if (!sessions.some((x) => x.id === id)) {
    live.push({ id, title: names[id] || titles[id] || 'New chat', updatedAt: new Date(c.lastUsed).toISOString(), cwd: c.cwd || null,
      status: needsYou(c) ? 'needs-you' : c.busy ? 'working' : 'waiting' });
  }
  return { links, live, actions };
}

export const refKey = (r) => (r.kind === 'issue' ? `issue:${r.key}` : `${r.kind}:${r.repo}#${r.number}`);

// What a session's log on disk looks like now (size and time), so a conversation already read
// is answered from memory until the agent writes to it again. Reading one means starting the
// agent and having it replay the whole session, which takes seconds; null when there is no log
// to go by (a chat that only exists here so far), and then it is read every time.
export function historyStamp(id, agent = sessionAgent(id) || backend().name, { home = homedir(), cpHome = copilotHome() } = {}) {
  const stampOf = (file) => { try { const st = statSync(file); return st.isFile() ? `${st.size}-${Math.round(st.mtimeMs)}` : null; } catch { return null; } };
  if (agent === 'copilot') { const s = stampOf(join(cpHome, 'session-state', id, 'events.jsonl')); if (s) return s; }
  if (agent === 'claude') {
    // Claude Code keeps a session as projects/<its folder, spelled as a name>/<id>.jsonl.
    const dir = join(process.env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'projects');
    let folders = [];
    try { folders = readdirSync(dir); } catch {}
    for (const f of folders) { const s = stampOf(join(dir, f, `${id}.jsonl`)); if (s) return s; }
  }
  // Otherwise the time the agent's own list gives (kept for 30 s), if it lists the session.
  // That list can lag behind a chat running here, so one busy here is read every time, and a
  // turn started here since makes it another stamp.
  const at = sessionsCache?.data.find((x) => x.id === id)?.updatedAt, c = acpChats.get(id);
  return at && !c?.busy ? `at-${at}${c ? `-${c.lastUsed}` : ''}` : null;
}

// Conversations read so far, newest last (at most HISTORY_KEEP), and reads under way, so
// opening a chat twice at once starts the agent once.
const HISTORY_KEEP = 40;
const histories = new Map(), reading = new Map();
export const forgetHistories = () => { histories.clear(); reading.clear(); };

async function readHistory(id, cwd) {
  const messages = await withAgent(sessionAgent(id), (a) => a.history(id, cwd));
  for (const m of messages) if (m.role === 'me') m.text = typedPart(m.text);
  // Copilot replays steps without times; its log has them.
  const { times = {} } = (sessionAgent(id) || backend().name) === 'copilot' ? sessionEvents(copilotHome(), id) : {};
  for (const m of messages) for (const g of m.segs || []) if (g.type === 'tool' && times[g.id]) Object.assign(g, times[g.id]);
  return messages;
}

// A session's conversation and its stamp; `read` says whether the agent had to be started.
export async function copilotHistory(_bin, id, cwd, { stamp = historyStamp(id), load = readHistory } = {}) {
  const key = `${id}\n${cwd || ''}`;
  const hit = histories.get(key);
  if (stamp && hit?.stamp === stamp) { histories.delete(key); histories.set(key, hit); return { messages: hit.messages, stamp, read: false }; }
  const inFlight = reading.get(key);
  if (inFlight?.stamp === stamp) return { ...(await inFlight.promise), read: true };
  const promise = load(id, cwd).then((messages) => {
    // Keep it under the stamp from before the read: a log written meanwhile reads again next time.
    if (stamp) { histories.delete(key); histories.set(key, { stamp, messages }); }
    while (histories.size > HISTORY_KEEP) histories.delete(histories.keys().next().value);
    return { messages, stamp };
  }).finally(() => { if (reading.get(key)?.promise === promise) reading.delete(key); });
  reading.set(key, { stamp, promise });
  return { ...(await promise), read: true };
}
