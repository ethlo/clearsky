// What a sandboxed chat asks before it reaches outside: changes on GitHub and in Jira, hosts off
// its list, and the rules you saved for them. The answers are cards in the chat.
import { homedir } from 'node:os';
import { execFile, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as localState from '../state.mjs';
import { logWrite } from '../agent-log.mjs';
import { SHARED_BRANCH, NODES_REPO_QUERY, repoFromNodes } from '../github-gate.mjs';
import { githubAdvice, jiraAdvice, outsideAdvice, parseRules, ruleLabel } from '../advice.mjs';
import * as chatScope from '../chat-scope.mjs';
import { untilde } from '../util.mjs';
import { ciState } from '../modules/github.mjs';
import { stateFile, agentLogFile, scopesFile, config, saveSettings } from './config.mjs';
import { http, gql, ghCliToken } from './services.mjs';
import { acpChats, chatFolders, chatRef, cloneDirs, chatRepos, chatByKey, copilotFolders } from './chat-env.mjs';

// ---------------------------------------------------------------- hosts

// The host door's card, in every chat that may have asked: the first answer counts, and it goes in
// the agent log.
export function hostAsk(card, chats, { rule, write = false }) {
  const shared = chats.length > 1;
  const log = (decided) => logWrite(agentLogFile, { where: 'network', what: write ? card.detail.split('\n')[0] : `reach ${rule}`, target: rule, chats: chats.map(chatRef), decided });
  return new Promise((done) => {
    const id = randomBytes(6).toString('hex');
    const ev = { type: 'permission', id, kind: 'fetch', ...card };
    for (const c of chats) {
      c.waiting.set(id, (answer) => {
        for (const o of chats) { o.waiting.delete(id); o.pending.delete(id); o.shared.delete(id); o.emit({ type: 'permission-done', id }); }
        // Not answered before the turn ended (lib/chat-cards.mjs): taken down, not denied.
        if (answer.expired) { log('expired'); return done(write ? 'deny' : 'expired'); }
        // You stopped the turn: no answer, not a Deny (it would show as one, and count as one).
        if (!answer.optionId) {
          log('stopped');
          for (const o of chats) o.emit({ type: 'note', text: `Network: ${write ? card.detail.split('\n')[0] : rule}: not answered (turn stopped)` });
          return done(write ? 'deny' : 'expired');
        }
        const choice = answer.optionId;
        const name = card.options.find((o) => o.id === choice)?.name || 'Deny';
        log(choice === 'deny' ? 'declined' : choice);
        for (const o of chats) o.emit({ type: 'note', text: `Network: ${write ? card.detail.split('\n')[0] : rule}: ${name}` });
        done(choice);
      });
      if (shared) c.shared.add(id); // may not be this chat's: it doesn't mark the chat as needing you
      c.pending.set(id, ev);
      c.emit(ev);
    }
  });
}

// ---------------------------------------------------------------- GitHub

// A GitHub change from a sandbox, held at srt's proxy (lib/github-gate.mjs). The proxy can't tell
// which chat sent it, so every sandboxed chat that's working asks; the first answer counts.
// When the only working chat is running a step you just allowed (say `gh pr create`), its
// GitHub changes are part of what you allowed and go through. With two chats working, it asks.
export async function githubAsk(what, { repo, nodes = [], why = null } = {}) {
  repo ||= (what.match(/^git push to (\S+)/) || [])[1] || await nodesRepo(nodes);
  const chats = askingChats(repo);
  if (!chats.length) return false;
  const shared = chats.length > 1;
  const advice = await githubCardAdvice(what, repo, nodes, why, chats).catch(() => null);
  // A kind of change you said to let through from now on (Settings), when it looks fine.
  if (advice?.rule && advice.level === 'fine' && gateRules().has(advice.rule)) {
    logWrite(agentLogFile, { where: 'github', what, target: repo, chats: chats.map(chatRef), decided: `auto (rule ${advice.rule})` });
    for (const c of chats) c.emit({ type: 'note', text: `GitHub: ${what} (let through: ${ruleLabel(advice.rule)})` });
    return true;
  }
  if (chats.length === 1 && chats[0].approved.size) {
    logWrite(agentLogFile, { where: 'github', what, target: repo, chats: chats.map(chatRef), decided: 'allowed with a step' });
    return Promise.resolve(true);
  }
  return new Promise((done) => {
    const id = randomBytes(6).toString('hex');
    const title = /\/actions\/(workflows\/[^/]+\/dispatches|runs\/\d+\/rerun)/.test(what) ? 'Start a CI run as you' : 'Change GitHub as you';
    const ev = { type: 'permission', id, title, kind: 'execute', detail: what, advice,
      options: [{ id: 'allow', name: 'Allow', kind: 'allow_once' }, ...ruleOption(advice), { id: 'deny', name: 'Deny', kind: 'reject_once' }] };
    const finish = (ok, rule = false, expired = false) => {
      if (ok && rule && advice?.rule) addGateRule(advice.rule);
      for (const c of chats) { c.waiting.delete(id); c.pending.delete(id); c.shared.delete(id); c.emit({ type: 'permission-done', id }); }
      const target = repo || (what.match(/^git push to (\S+)/) || [])[1] || null;
      // Allowed in the one chat it came from: that repo is part of this chat's work from now on.
      if (ok && !shared && target && why?.startsWith('goes to ')) { chats[0].repos.add(target.toLowerCase()); chatScope.addScopeRepo(scopesFile, chats[0].id, target); }
      logWrite(agentLogFile, { where: 'github', what, target, chats: chats.map(chatRef), decided: ok ? 'allowed' : expired ? 'expired' : 'declined' });
      done(ok);
    };
    for (const c of chats) {
      if (c.mode === 'full') return finish(true); // Full: you allowed everything (logged as allowed)
      c.waiting.set(id, (answer) => finish(answer.optionId === 'allow' || answer.optionId === 'rule', answer.optionId === 'rule', !!answer.expired));
      if (shared) c.shared.add(id); // may not be this chat's: it doesn't mark the chat as needing you
      c.pending.set(id, ev);
      c.emit(ev);
    }
  });
}

// Kinds of change you let through from now on, from a card's "always" button (Settings → Agent).
const gateRules = () => parseRules(process.env.AGENT_GATE_RULES);
function addGateRule(rule) {
  const rules = gateRules();
  if (rules.has(rule)) return;
  rules.add(rule);
  saveSettings({ AGENT_GATE_RULES: [...rules].join(', ') });
}
// The card's "always" button: offered when the advice names a kind of change and, for merges and
// branch deletes, only when this one looks fine (the rule only ever lets fine ones through).
const ruleOption = (a) => (a?.rule && (a.level === 'fine' || /^(repo|jira):/.test(a.rule))
  ? [{ id: 'rule', name: `Allow, and always for ${ruleLabel(a.rule)}`, kind: 'allow_always' }] : []);

// What Clearsky reads from GitHub (as you, read only) to advise on a card (lib/advice.mjs): the
// PR a merge merges, the branch a delete deletes. Only states and names, never PR text.
async function githubCardAdvice(what, repo, nodes, why, chats) {
  const facts = { chatRepos: new Set(chats.flatMap((c) => [...chatRepos(c)])) };
  let number = Number(what.match(/\/pulls\/(\d+)\/merge\b/)?.[1]) || null;
  if (!number && /\(mergePullRequest\)$/.test(what)) {
    const d = await gql('query($ids: [ID!]!) { nodes(ids: $ids) { ... on PullRequest { number repository { nameWithOwner } } } }', { ids: nodes }, { partial: true }).catch(() => null);
    const pr = (d?.nodes || []).find((n) => n?.number);
    if (pr) { number = pr.number; repo ||= pr.repository.nameWithOwner; }
    facts.merge = null;
  }
  if (number && repo) facts.merge = await prFacts(repo, number, chats).catch(() => null);
  const branch = why?.match(/^deletes (\S+)$/)?.[1] || what.match(/^DELETE \S+?\/git\/refs\/heads\/(.+)$/)?.[1];
  if (branch && repo) facts.branch = await branchFacts(repo, decodeURIComponent(branch)).catch(() => null);
  return githubAdvice(why || '', facts);
}
async function prFacts(repo, number, chats) {
  const [pr, reviews] = await Promise.all([ghGet(`/repos/${repo}/pulls/${number}`), ghGet(`/repos/${repo}/pulls/${number}/reviews?per_page=100`)]);
  const latest = new Map();
  for (const r of reviews || []) if (r.user?.login && r.user.login !== pr.user?.login && ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.state)) latest.set(r.user.login, r.state);
  const byState = (st) => [...latest].filter(([, v]) => v === st).map(([k]) => k);
  const r = repo.toLowerCase(), head = String(pr.head?.ref || '').toUpperCase();
  const ours = chats.some((c) => (localState.sessionRefs(stateFile)[c.id] || []).some((k) => k.toLowerCase() === `pr:${r}#${number}`)
    || [...c.tickets].some((t) => new RegExp(`(^|[^A-Z0-9])${t}([^0-9]|$)`).test(head))
    || currentBranch(c.cwd) === pr.head?.ref) && chats.some((c) => chatRepos(c).has(r));
  return { number, ours, ci: await prCi(repo, number).catch(() => null), draft: !!pr.draft, mergeable: pr.mergeable, base: pr.base?.ref,
    approvals: byState('APPROVED'), changesRequested: byState('CHANGES_REQUESTED') };
}
// CI on the PR's latest commit, as the review queue sees it (ciState in lib/modules/github.mjs).
async function prCi(repo, number) {
  const [owner, name] = repo.split('/');
  const d = await gql(`query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) {
    commits(last: 1) { nodes { commit { statusCheckRollup { state } checkSuites(first: 20) { nodes { status conclusion workflowRun { event url workflow { name } } } } } } } } } }`,
  { owner, name, number });
  return ciState(d.repository.pullRequest);
}
async function branchFacts(repo, name) {
  const owner = repo.split('/')[0];
  const prs = await ghGet(`/repos/${repo}/pulls?state=all&per_page=10&head=${encodeURIComponent(`${owner}:${name}`)}`);
  return { name, shared: SHARED_BRANCH.test(name), open: (prs || []).find((p) => p.state === 'open')?.number || null,
    merged: (prs || []).find((p) => p.merged_at)?.number || null };
}
function currentBranch(dir) {
  try { return execFileSync('git', ['-C', dir, 'branch', '--show-current'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; } catch { return null; }
}

// Which working chat a GitHub change came from. srt's proxy can't tell, so narrow it down: chats
// running a step right now, then those whose folder is a clone of the repo it goes to. Only
// when that leaves several does every one of them ask (the first answer counts).
export function askingChats(repo) {
  let chats = [...acpChats.values()].filter((c) => c.agent.sandboxed && c.busy);
  const narrow = (f) => { const n = chats.filter(f); if (n.length) chats = n; };
  narrow((c) => c.running.size);
  if (repo) narrow((c) => chatRepos(c).has(repo.toLowerCase()));
  return chats;
}
// Reading GitHub as you, for the gate's checks (lib/github-gate.mjs).
async function ghGet(path) {
  config.github.token ||= await ghCliToken();
  return http(`${config.github.api}${path}`, { headers: { Authorization: `Bearer ${config.github.token}` } });
}
const defaultBranches = new Map();
export const githubLook = {
  // Whether a push only adds commits (old is an ancestor of new), asked of a working chat's clone
  // of the repo, where the pushed commits are; null when none of them has both.
  async fastForward(repo, oldSha, newSha) {
    if (!/^[0-9a-f]{40}$/.test(oldSha) || !/^[0-9a-f]{40}$/.test(newSha)) return null;
    for (const dir of cloneDirs(repo)) {
      const code = await new Promise((done) => execFile('git', ['-C', dir, 'merge-base', '--is-ancestor', oldSha, newSha], { timeout: 5000 }, (e) => done(e ? e.code : 0)));
      if (code === 0) return true;
      if (code === 1) return false;
    }
    return null;
  },
  compare: (repo, base, head) => ghGet(`/repos/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`),
  run: (repo, id) => ghGet(`/repos/${repo}/actions/runs/${id}`),
  protected: async (repo, branch) => !!(await ghGet(`/repos/${repo}/branches/${encodeURIComponent(branch)}`)).protected,
  async defaultBranch(repo) {
    if (!defaultBranches.has(repo)) defaultBranches.set(repo, (await ghGet(`/repos/${repo}`)).default_branch);
    return defaultBranches.get(repo);
  },
};

// An everyday GitHub change that went through without asking: a line in the chat that made it.
export async function githubTold(what, { repo, nodes = [] } = {}) {
  repo ||= await nodesRepo(nodes);
  const chats = askingChats(repo);
  console.log(`clearsky: GitHub change let through: ${what}`);
  logWrite(agentLogFile, { where: 'github', what, target: repo, chats: chats.map(chatRef), decided: 'auto' });
  for (const c of chats) c.emit({ type: 'note', text: `GitHub: ${what}${chats.length > 1 ? ' (from one of your working chats)' : ''}` });
}

// A GitHub write goes through only to a repo a working chat is on: its clone's remote, the PRs
// it was started about, or one you allowed in it. Others ask.
export async function githubScope({ repo, nodes = [] }) {
  repo ||= await nodesRepo(nodes);
  if (!repo) return 'Clearsky couldn\'t tell which repo it changes';
  const r = repo.toLowerCase();
  const chats = [...acpChats.values()].filter((c) => c.agent.sandboxed && c.busy);
  if (gateRules().has(`repo:${r}`)) return null; // you let this repo's everyday changes through (Settings)
  return chats.some((c) => chatRepos(c).has(r)) ? null : `goes to ${repo}, not a repo this chat works on`;
}

// The repo of a GraphQL change, from the ids it names (looked up as you, read only).
async function nodesRepo(ids) {
  if (!ids.length) return null;
  try {
    config.github.token ||= await ghCliToken();
    return repoFromNodes(await gql(NODES_REPO_QUERY, { ids }, { partial: true }));
  } catch { return null; }
}

// ---------------------------------------------------------------- Jira and the other doors (lib/broker.mjs)

// Which Jira tickets and projects an acli command changes; `bulk` when it picks them by a query.
export function jiraTargets(argv) {
  const keys = new Set(), projects = new Set();
  let bulk = false;
  argv.forEach((a, i) => {
    if (/^--(jql|filter)(=|$)/.test(a)) bulk = true;
    const v = a.includes('=') && a.startsWith('--') ? a.slice(a.indexOf('=') + 1) : a;
    const flag = a.startsWith('--') ? a.split('=')[0] : argv[i - 1];
    if (/^(--project|-p)$/.test(flag) && /^[A-Z][A-Z0-9_]+$/.test(v)) projects.add(v);
    for (const k of v.split(',')) if (/^[A-Z][A-Z0-9_]+-\d+$/.test(k.trim())) { keys.add(k.trim()); projects.add(k.trim().split('-')[0]); }
  });
  return { keys: [...keys], projects: [...projects], bulk };
}
// The Jira projects this chat works in: its tickets, and the one its branch is named after.
function chatJira(c) {
  const set = new Set(c.jira);
  for (const k of localState.sessionRefs(stateFile)[c.id] || []) if (k.startsWith('issue:')) set.add(k.slice(6).split('-')[0]);
  try {
    const branch = execFileSync('git', ['-C', c.cwd, 'branch', '--show-current'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
    for (const m of branch.toUpperCase().matchAll(/\b([A-Z][A-Z0-9_]+)-\d+\b/g)) set.add(m[1]);
  } catch {}
  return set;
}

// The folders a door's command may run in: the chat's own, Settings → Agent's, and those added to it.
export function brokerWhere(key) {
  const c = chatByKey(key);
  return c && [c.cwd, ...copilotFolders().map((d) => untilde(d)), ...chatFolders(c.id)];
}
// Ask in the chat, as for any step Copilot wants to take, and wait for your answer.
export function brokerAsk({ key, tool, argv, cwd, vm = false, background = false }) {
  const c = chatByKey(key);
  if (!c) return Promise.resolve(false);
  const line = [tool, ...argv].map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ');
  const jira = tool === 'acli' ? jiraTargets(argv) : null;
  const log = (decided) => jira && logWrite(agentLogFile, { where: 'jira', what: line, target: jira.keys.join(', ') || jira.projects.join(', ') || null, chats: [chatRef(c)], decided });
  if (c.mode === 'full') { log('allowed'); return Promise.resolve(true); } // Full: you allowed everything
  // A Jira change to the tickets of this chat's project goes through, and shows in the chat.
  if (jira && !jira.bulk && jira.projects.length && jira.projects.every((p) => chatJira(c).has(p) || gateRules().has(`jira:${p}`))) {
    log('auto');
    c.emit({ type: 'note', text: `Jira: ${line}` });
    return Promise.resolve(true);
  }
  const title = { git: 'Push from your machine', gh: 'Change GitHub as you', acli: 'Change Jira as you', outside: `Run on your machine, outside the sandbox${background ? ', in the background' : ''}` }[tool];
  return new Promise((done) => {
    const id = randomBytes(6).toString('hex');
    // The same command again (a test run after a fix) can be allowed for the rest of this chat.
    const same = `${cwd}\n${line}`;
    if (c.allowedRuns?.has(same)) return done(true);
    const advice = jira ? jiraAdvice(jira, chatJira(c)) : tool === 'outside' ? outsideAdvice({ vm }) : null;
    const ev = { type: 'permission', id, title, kind: 'execute', detail: `${line}\n(in ${cwd.replace(homedir(), '~')})`, advice,
      options: [...(vm ? [{ id: 'vm', name: 'Run in the VM instead', kind: 'allow_once' }] : []), { id: 'allow', name: 'Allow', kind: 'allow_once' },
        ...(jira ? ruleOption(advice) : [{ id: 'chat', name: 'Allow this command again in this chat', kind: 'allow_always' }]), { id: 'deny', name: 'Deny', kind: 'reject_once' }] };
    c.waiting.set(id, (answer) => {
      c.pending.delete(id);
      if (answer.optionId === 'rule' && advice?.rule) { addGateRule(advice.rule); answer = { ...answer, optionId: 'allow' }; }
      if (answer.optionId === 'chat') (c.allowedRuns ||= new Set()).add(same);
      if (answer.optionId === 'vm') return done('vm');
      const ok = answer.optionId === 'allow' || answer.optionId === 'chat';
      log(ok ? 'allowed' : 'declined');
      // Allowed here: that ticket's project is part of this chat's work from now on.
      if (ok && jira && !jira.bulk) for (const p of jira.projects) c.jira.add(p);
      done(ok);
    });
    c.pending.set(id, ev);
    c.emit(ev);
  });
}

// A question in a chat with Allow and Deny only (asked every time).
export function askInChat(c, { title, detail, advice = null }) {
  return new Promise((done) => {
    const id = randomBytes(6).toString('hex');
    const ev = { type: 'permission', id, title, kind: 'execute', detail, advice,
      options: [{ id: 'allow', name: 'Allow', kind: 'allow_once' }, { id: 'deny', name: 'Deny', kind: 'reject_once' }] };
    c.waiting.set(id, (answer) => { c.pending.delete(id); done(answer.optionId === 'allow'); });
    c.pending.set(id, ev);
    c.emit(ev);
  });
}
