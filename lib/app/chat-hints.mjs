// What a chat is told when it starts: how to work here (pull requests, tickets, folders, builds,
// the sandbox and its doors), and the items and references put in front of your message.
import { homedir } from 'node:os';
import { vmSupport } from '../vm.mjs';
import * as memory from '../memory.mjs';
import { DISCLOSE_HINT } from '../disclosure.mjs';
import { REWIND_INTRO } from '../checkpoints.mjs';
import { makeContext } from '../sources.mjs';
import { trackerHint } from '../tracker.mjs';
import { nameOf, commentInfo, excerpt } from '../modules/jira.mjs';
import { list, config, tracker, plugins } from './config.mjs';
import { gql, ghCliToken, acli, jiraComments, jiraSite, browseUrl } from './services.mjs';
import { sourceCache } from './work.mjs';
import { copilotTmp, copilotFolders } from './chat-env.mjs';

// Plugins' doors (lib/broker.mjs): commands chats call through Clearsky, such as `grafana …`.
// Only from plugins that run inside Clearsky and list the door in their manifest. The door
// decides what to ask (with the chat's card); Clearsky removes secrets from what goes back, cuts
// it to size, and puts every call in the agent log (reads too: they're as you).
export function doorsByName() {
  const out = new Map();
  for (const p of plugins.sources.values()) {
    if (p.sandboxed || !p.doors) continue;
    for (const d of p.pluginManifest?.doors || []) if (typeof p.doors[d.name]?.run === 'function' && !out.has(d.name)) out.set(d.name, { p, door: p.doors[d.name] });
  }
  return out;
}

// What a sandboxed chat is told about plugins' doors (Grafana's says which environments ask).
const doorHints = () => [...doorsByName().values()].map(({ p, door }) => {
  if (p.enabled && !p.enabled(process.env)) return '';
  try { const h = door.hint?.(makeContext(p).env); return h ? ` ${h}` : ''; } catch { return ''; }
}).join('');

export const CONTEXT_INTRO = 'You are helping me with my work. This is my work dashboard right now:';
// A chat that goes on in a new Copilot (after a restart of Clearsky) gets the sandbox's current rules again.
export const UPDATE_INTRO = 'How the sandbox works now (this replaces what I said about it before):';
// PR descriptions are for the human reviewer: after Copilot's review rounds, theirs should be quick.
export const PR_HINT = 'When you open a PR or finish a round of work on one, write (or update with `gh api -X PATCH repos/<owner>/<repo>/pulls/<n> -F body=@<file>`; `gh pr edit` can silently drop the edit) its description '
  + 'for the human reviewer, short and in this shape: "## What and why" (the change and the reason, with the ticket key); '
  + '"## How it was checked" (tests you ran and their result, Copilot review rounds so far and that their findings are addressed, '
  + 'and the CI build: once Copilot has no more findings, run the branch\'s CI build with tests, e.g. `gh workflow run <workflow> --ref <branch>` '
  + 'or the run for the latest commit, follow it to the end with `gh run watch`, fix and rerun if it fails, and link the run); '
  + '"## For the reviewer" (anything still open, decisions worth a second look, where the risk is; "Nothing open" if so). '
  + 'Facts only, no filler; keep any PR template\'s headings and fill them the same way.';
// Jira Cloud shows wiki markup sent as text literally ("h3. Goal"); Clearsky's acli turns the
// text into ADF (lib/to-adf.mjs), so Copilot writes plain Markdown and leaves the format to it.
export const JIRA_HINT = 'When you write a Jira description or comment with `acli`, write it in Markdown (`## Heading`, `- item`, `1. step`, '
  + '`**bold**`, `` `code` ``, ``` fences, `[text](url)`), not Jira wiki markup (`h3.`, `{{code}}`), and don\'t build ADF JSON yourself. Pass it with `--description` or '
  + '`--body`; for longer text, write it to a file in this folder or in $TMPDIR (not /tmp) and use `--description-file` or `--body-file` (also to edit one: `ticket comment <KEY> --edit <id> --body-file <file>`, or `comment update … --body-file`).'
  + ' Clearsky turns the text into ADF and hands acli the file and flag it needs, with the path made absolute, so the headings and lists '
  + 'show as such. If a ticket still shows raw Markdown, say so instead of working around it.';
// Where tickets live, for every chat, and for Jira how to write to it.
export const trackerHints = (t = tracker()) => (t === 'jira' ? `${trackerHint('jira')} ${JIRA_HINT}` : trackerHint(t));
// Clearsky shows a ```choices block as buttons (web/js/50-chat.js); a click sends the option.
export const CHOICES_HINT = 'When you need me to choose (an approach, a next step, yes or no), ask once, at the end of your answer, as a block I can click:\n'
  + '```choices\nThe question, in one line\n- First option (recommended) | what happens if I pick it\n- Second option | what happens\n```\n'
  + 'Two to four options, the one you recommend first. Then stop and wait for my pick.';
// Long-term memory: where it is, and how to suggest a note (a ```remember block, saved only by you).
export const memoryHint = () => { const f = memory.memoryFile(); return memory.memoryHint(f, memory.readMemory(f)); };
// Where my code is, so Copilot looks there first instead of listing my home and asking for it.
export function foldersHint() {
  const tilde = (p) => (p.startsWith(homedir()) ? `~${p.slice(homedir().length)}` : p);
  const rw = copilotFolders().map(tilde), ro = list(process.env.AGENT_READ).map(tilde);
  if (!rw.length && !ro.length) return `For temporary files use $TMPDIR (${tilde(copilotTmp())}), not /tmp: /tmp here is this chat's own, kept in memory, and nothing outside the sandbox sees it.`;
  return `My code is in ${rw.join(', ') || 'this folder'}${ro.length ? ` (and, read only, ${ro.join(', ')})` : ''}. `
    + 'Find repos and files there or in the current folder; don\'t list or search the rest of my home. '
    + 'If you need something outside these folders, say what and why first. '
    + `For temporary files use $TMPDIR (${tilde(copilotTmp())}), not /tmp: /tmp here is this chat's own, kept in memory, and nothing outside the sandbox sees it.`;
}
// Where a sandboxed chat runs builds and tests (Settings → Agent → Run builds in): the chat's
// VM when this machine has one, so a full build doesn't take your laptop's CPU; or the sandbox,
// with the VM only for tests that need Docker. The sandbox fences files and network, not CPU: a
// build in it runs on this machine, as you, and the VMs view only sees it as sandbox load.
export const buildsWhere = (setting = process.env.AGENT_BUILDS, vmOk = vmSupport().ok) => (vmOk && setting !== 'sandbox' ? 'vm' : 'sandbox');
const VM_ABOUT = 'It runs in this chat\'s own VM, in the same folder, with Docker (`docker compose` and buildx too) and without asking me; the first one starts the VM, and it '
  + 'stays up for the next ones. If other chats use the VMs, it waits in line for one and says so: let it wait. Images named in Settings (my private ones) are copied in from my own Docker before each `vm` command, and `vm docker pull` of one pulls it on my machine with my login; if a test needs a private image the VM can\'t get, tell me which instead of working around it. It sees only this repo (read-write), my JDKs, and my Maven repository and wrapper downloads (read only: the repository at /host/m2, already Maven\'s fallback repository, and ~/.m2/wrapper; don\'t copy them). Its network is the sandbox\'s: commands in the VM, `docker build` steps and the containers it starts all get the proxy as HTTP(S)_PROXY, so a Dockerfile\'s apt-get, curl or pip works there as it does on CI, and a host off the list asks me, as in the sandbox (wait for my answer, then build again). '
  + '"Connection refused" to an outside address means a tool skipped the proxy: give it $HTTPS_PROXY. '
  + 'HTTPS to github.com, Docker Hub and my Maven repositories comes signed by Clearsky\'s own CA (the proxy reads it); the VM trusts it, images don\'t, so a build step that downloads from there fails with a certificate error: say so instead of changing the Dockerfile or turning checks off. '
  + 'Image builds belong in the VM too: never test them only on CI because of the VM. If a `vm` run fails for another reason, tell me what failed instead of working around the VM. ';
export function buildsHint(where = buildsWhere()) {
  if (where === 'vm') {
    return 'Run every build and test in this chat\'s VM, never directly in the sandbox: `vm <command>` (for example `vm ./mvnw verify -pl core`), '
      + 'or `bg vm <command>` when it takes more than a few minutes. That covers compiling, `mvn`/`./mvnw`, Gradle, `npm test`/`npm run build`, '
      + '`make` and the like. The sandbox runs on my laptop and shares its CPU, so a build there slows down everything I do; the VM has its own cores, and Docker, so Testcontainers work there too. '
      + VM_ABOUT
      + 'Only if `vm` says there is no VM, run the build in the sandbox instead. Never use `outside` for builds or for failures (fix those, or ask me), and don\'t quote arguments you don\'t need to. ';
  }
  return 'There is no Docker in the sandbox. Tests that need it (Testcontainers) fail with errors like "Ryuk is unreachable" or '
    + '"Could not find a valid Docker environment": run that test command as `vm <command>` (for example `vm ./mvnw verify -pl core`). '
    + VM_ABOUT
    + 'If `vm` says there is no VM, use `outside <command>` instead, which runs it on my machine after '
    + 'I OK it. Builds and tests run fine in the sandbox (Maven, its repository and your JDKs are there): always run them normally '
    + 'first, and use `vm` only after a run in the sandbox failed with one of those Docker errors. Never use `outside` for other '
    + 'failures (fix those, or ask me), and don\'t quote arguments you don\'t need to. ';
}
// How the sandbox works for Copilot, and its doors out (lib/broker.mjs).
const SANDBOX_HINT = 'You run in a sandbox: everything inside it runs without asking me. git and gh work as usual, except that a clone\'s '
  + 'git settings and hooks can\'t be changed here (no `git config`, no `git remote add`, no saved upstream): push and pull by name, like '
  + '`git push origin HEAD`, and use `outside git config …` if a setting has to change. Reading GitHub '
  + 'goes through, while a push or any GitHub change (a PR, a comment, a review) waits at the sandbox\'s network until I click Allow, '
  + 'and fails with "declined" if I don\'t.{{trackerDoor}} Your built-in GitHub tools are off here. '
  + '{{builds}}'
  + 'Before you open a pull request, run `review --ticket <ticket>` (or `review --goal "<what it is for>"` without a ticket; `--base <branch>` '
  + 'when it doesn\'t go to the default branch): a fresh reviewer that sees only the goal and the code reviews your change. Give it the goal only, '
  + 'never your reasoning. Fix what holds up, say why you skip the rest, and run it again until it says "VERDICT: ready" (three rounds at most). '
  + 'Anything that takes more than a few minutes (a full build, a `vm` test run, waiting for CI with `gh run watch <id> --exit-status`) '
  + 'runs as a background job: `bg <command>` in the sandbox, `bg vm <command>` in the VM, `bg outside <command>` on my machine after my OK. '
  + 'It answers at once with the job\'s id; then end your turn, saying what you wait for. Clearsky wakes you here with the result and the end of '
  + 'its output when it ends, so a long wait never ends your work. `jobs` lists this chat\'s jobs, `jobs log <id>` shows output so far, '
  + '`jobs stop <id>` stops one. Never wait with sleep loops. '
  + 'Only hosts on the sandbox\'s list are reachable. A request to any other host waits while Clearsky asks me; if it fails as '
  + '"blocked by network allowlist" or "declined", don\'t carry on from memory or guesses: say which host you need and why, and end your turn. '
  + 'When I allow it, Clearsky tells you here and you try again. Sending data to a host I allowed asks me again. '
  + 'Maven finds the proxy and my repository logins in the settings Clearsky passes in MAVEN_ARGS, in the sandbox and in the VM: keep them (no `-s` or proxy flags of your own). '
  + 'The logins are never visible to you (the settings hold a stand-in that the proxy swaps on the way out), so don\'t look for them or copy artifacts around; '
  + 'if a private repository still answers 401 or 403, or its host asks to be allowed, say which host and stop. '
  + 'A 407 from the proxy means a tool skipped the proxy\'s login: say so and which host, don\'t work around it. '
  + 'If you stop before the task is done, Clearsky nudges you to go on; when you are done, or need me, say so plainly.';
export const sandboxHintFor = (permission) => (process.env.AGENT_SANDBOX === 'srt' || permission === 'sandboxed'
  ? `\n\n${SANDBOX_HINT.replace('{{builds}}', buildsHint()).replace('{{trackerDoor}}', tracker() === 'jira' ? ' Jira changes with `acli` (or `ticket`) ask me the same way.' : '')}${doorHints()}${process.env.AGENT_DISCLOSE === 'on' ? ` ${DISCLOSE_HINT}` : ''}` : '');
// What you typed, without the dashboard and references Clearsky added in front.
export const MSG_MARK = '\n\n---\nMy message:\n';
export function typedPart(text) {
  const at = text.lastIndexOf(MSG_MARK);
  if (at >= 0 && (text.startsWith(CONTEXT_INTRO) || text.startsWith(REFS_INTRO) || text.startsWith(UPDATE_INTRO) || text.startsWith(REWIND_INTRO))) return text.slice(at + MSG_MARK.length);
  if (text.startsWith(CONTEXT_INTRO)) return text.slice(text.lastIndexOf('\n\n---\n\n') + 7); // chats from before the marker
  return text;
}

// Fuller details of the PRs and tickets you attach to a Copilot message.
export const REFS_INTRO = 'I am asking about these items:';
export async function referenceText(ref) {
  if (ref.kind === 'issue') {
    await jiraSite();
    const [out, comments] = await Promise.all([
      acli(['workitem', 'view', ref.key, '--fields', 'summary,status,assignee,reporter,priority,issuetype,description,labels', '--json']),
      jiraComments(ref.key).catch(() => []),
    ]);
    const f = out?.fields || out || {};
    const desc = f.description ? excerpt(commentInfo(f.description).text, null, 4000) : '';
    return [`## Jira ${ref.key}: ${f.summary || ''}`, browseUrl({ key: ref.key, self: out?.self }),
      `Type: ${nameOf(f.issuetype) || '?'} · Status: ${nameOf(f.status) || '?'} · Priority: ${nameOf(f.priority) || '-'} · Assignee: ${f.assignee?.displayName || 'unassigned'} · Reporter: ${f.reporter?.displayName || '?'}`,
      desc && `Description: ${desc}`,
      comments.length && `Latest comments:\n${comments.slice(-5).map((c) => `- ${c.author?.displayName || '?'} (${String(c.created || '').slice(0, 10)}): ${excerpt(commentInfo(c.body).text, null, 600)}`).join('\n')}`,
    ].filter(Boolean).join('\n');
  }
  config.github.token ||= await ghCliToken();
  const [owner, name] = ref.repo.split('/');
  if (ref.kind === 'gh') {
    const { repository } = await gql(`query($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) { issue(number: $number) {
        title url state bodyText author { login } assignees(first: 5) { nodes { login } } labels(first: 10) { nodes { name } }
        comments(last: 5) { nodes { author { login } createdAt bodyText } } } } }`, { owner, name, number: Number(ref.number) });
    const i = repository?.issue;
    if (!i) throw new Error(`${ref.repo}#${ref.number} not found`);
    return [`## GitHub issue ${ref.repo}#${ref.number}: ${i.title}`, i.url,
      `By ${i.author?.login || '?'} · ${i.state.toLowerCase()} · assignees: ${i.assignees.nodes.map((a) => a.login).join(', ') || 'none'}${i.labels.nodes.length ? ` · labels: ${i.labels.nodes.map((l) => l.name).join(', ')}` : ''}`,
      i.bodyText && `Description: ${i.bodyText.trim().slice(0, 4000)}`,
      i.comments.nodes.length && `Latest comments:\n${i.comments.nodes.map((c) => `- ${c.author?.login || '?'} (${String(c.createdAt).slice(0, 10)}): ${c.bodyText.replace(/\s+/g, ' ').slice(0, 600)}`).join('\n')}`,
    ].filter(Boolean).join('\n');
  }
  const { repository } = await gql(`query($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) { pullRequest(number: $number) {
      title url state isDraft reviewDecision bodyText headRefName baseRefName author { login }
      files(first: 60) { nodes { path additions deletions } }
      latestReviews(first: 10) { nodes { author { login } state bodyText } } } } }`,
  { owner, name, number: Number(ref.number) });
  const pr = repository?.pullRequest;
  if (!pr) throw new Error(`${ref.repo}#${ref.number} not found`);
  return [`## Pull request ${ref.repo}#${ref.number}: ${pr.title}`, pr.url,
    `By ${pr.author?.login || '?'} · ${pr.isDraft ? 'draft' : pr.state.toLowerCase()} · review: ${(pr.reviewDecision || 'none').toLowerCase().replace(/_/g, ' ')} · ${pr.headRefName} → ${pr.baseRefName}`,
    pr.bodyText && `Description: ${pr.bodyText.trim().slice(0, 4000)}`,
    pr.files?.nodes?.length && `Files:\n${pr.files.nodes.map((x) => `- ${x.path} (+${x.additions} -${x.deletions})`).join('\n')}`,
    pr.latestReviews?.nodes?.length && `Reviews:\n${pr.latestReviews.nodes.map((r) => `- ${r.author?.login}: ${r.state.toLowerCase()}${r.bodyText ? ` "${r.bodyText.replace(/\s+/g, ' ').slice(0, 300)}"` : ''}`).join('\n')}`,
  ].filter(Boolean).join('\n');
}

export function validRefs(refs) {
  return (Array.isArray(refs) ? refs : []).slice(0, 8).map((r) => (
    r?.kind === 'issue' && /^[A-Z][A-Z0-9_]+-\d+$/.test(r.key) ? { kind: 'issue', key: r.key }
      : (r?.kind === 'pr' || r?.kind === 'gh') && /^[\w.-]+\/[\w.-]+$/.test(r.repo) && /^\d+$/.test(String(r.number)) ? { kind: r.kind, repo: r.repo, number: Number(r.number) }
        : null)).filter(Boolean);
}

// A compact view of what's on the dashboard right now, from the cache (no new fetches).
export function copilotContext() {
  const get = (n) => sourceCache.get(n)?.data || {};
  const g = get('github'), j = get('jira'), jm = get('jiraMentions'), cal = get('calendar');
  const pr = (p) => `${p.repo}#${p.number} ${p.title}`;
  const lines = [
    `Now: ${new Date().toString()}`,
    g.reviewRequested?.length && `Reviews requested from me:\n${g.reviewRequested.map((p) => `- ${pr(p)} (by ${p.author}, ${p.url})`).join('\n')}`,
    g.myPrs?.length && `My open PRs:\n${g.myPrs.map((p) => `- ${pr(p)}: ${p.status.label} (${p.url})`).join('\n')}`,
    jm.tickets?.length && `Jira tickets where I was mentioned:\n${jm.tickets.map((t) => `- ${t.key} ${t.summary}: ${t.people.join(', ')} said "${t.excerpt}"`).join('\n')}`,
    j.assigned?.length && `My Jira issues:\n${j.assigned.slice(0, 40).map((i) => `- ${i.key} ${i.summary} [${i.status}${i.priority ? `, ${i.priority}` : ''}]`).join('\n')}`,
    cal.events?.length && `Calendar (today and tomorrow):\n${cal.events.map((e) => `- ${e.start} to ${e.end} ${e.title}`).join('\n')}`,
  ].filter(Boolean);
  return lines.join('\n\n');
}
