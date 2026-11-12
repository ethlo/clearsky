// `ticket …`: one command for chats and skills, whatever tracker you use (lib/tracker.mjs).
// It only translates: the result is an acli or gh command, which then runs as usual, so in the
// sandbox every change still goes through the same door and asks you the same way.

const TICKET_USAGE = `ticket <verb> …   (your tracker: {{tracker}})

ticket view <ref>                          read a ticket and its description
ticket comment <ref> --body "…"            add a comment (--body-file <file> for longer text)
ticket move <ref> <status>                 change its status ("In Progress", "Done"; GitHub: open or closed)
ticket new --title "…" [--body "…"]        create one (Jira: --project KEY [--type Task]; GitHub: [--repo owner/name])
ticket mine                                your open tickets

<ref> is ABC-123 in Jira, owner/name#12 (or #12 in the repo's folder) on GitHub.
Write text in Markdown.`;

const JIRA_KEY = /^[A-Z][A-Z0-9_]+-\d+$/i;
const GH_REF = /^(?:([\w-][\w.-]*\/[\w-][\w.-]*))?#?(\d+)$/;
const GH_URL = /^https:\/\/github\.com\/([\w-][\w.-]*\/[\w-][\w.-]*)\/issues\/(\d+)\/?$/;
const FLAGS = new Set(['--body', '--body-file', '--title', '--project', '--repo', '--type', '--reason']);

function parse(argv) {
  const pos = [], o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (FLAGS.has(a)) {
      if (argv[i + 1] == null) return { error: `${a} needs a value` };
      o[a.slice(2)] = argv[++i];
    } else if (a === '--json') o.json = true;
    else if (a.startsWith('--')) return { error: `unknown option ${a}` };
    else pos.push(a);
  }
  return { pos, o };
}

const jiraKey = (r) => (JIRA_KEY.test(r || '') ? r.toUpperCase() : null);
function ghRef(r) {
  const m = String(r || '').match(GH_URL) || String(r || '').match(GH_REF);
  return m ? { repo: m[1] || null, number: m[2] } : null;
}
const repoArgs = (ref, o) => (ref?.repo || o.repo ? ['-R', ref?.repo || o.repo] : []);
const textArgs = (o, flag) => (o['body-file'] != null ? [`${flag}-file`, o['body-file']] : o.body != null ? [flag, o.body] : []);

// { bin, args } to run, or { error }, or { help }.
function ticketArgv(tracker, argv = []) {
  const [verb, ...rest] = argv;
  if (!verb || ['help', '--help', '-h'].includes(verb)) return { help: true };
  if (tracker === 'none') return { error: 'there is no issue tracker set up (Settings → General → Tickets live in)' };
  const p = parse(rest);
  if (p.error) return p;
  const { pos, o } = p;
  if (!['view', 'comment', 'move', 'new', 'mine'].includes(verb)) return { error: `unknown verb ${verb}` };
  const needsRef = ['view', 'comment', 'move'].includes(verb);

  if (tracker === 'jira') {
    const key = needsRef ? jiraKey(pos[0]) : null;
    if (needsRef && !key) return { error: `say which ticket, like ABC-123 (got ${pos[0] || 'nothing'})` };
    const acli = (args) => ({ bin: 'acli', args: ['jira', 'workitem', ...args] });
    if (verb === 'view') return acli(['view', key, '--fields', 'summary,status,assignee,reporter,priority,issuetype,description,labels,fixVersions', '--json']);
    if (verb === 'comment') {
      const t = textArgs(o, '--body');
      return t.length ? acli(['comment', 'create', '--key', key, ...t]) : { error: 'say what to write: --body "…" or --body-file <file>' };
    }
    if (verb === 'move') {
      const status = pos.slice(1).join(' ').trim();
      return status ? acli(['transition', '--key', key, '--status', status, '--yes']) : { error: 'say which status, like "In Progress"' };
    }
    if (verb === 'new') {
      if (!o.title) return { error: 'say what it is: --title "…"' };
      if (!o.project || !/^[A-Z][A-Z0-9_]+$/i.test(o.project)) return { error: 'say which Jira project: --project KEY' };
      return acli(['create', '--project', o.project.toUpperCase(), '--type', o.type || 'Task', '--summary', o.title, ...textArgs(o, '--description')]);
    }
    return acli(['search', '--jql', 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC', '--fields', 'key,summary,status,priority', '--limit', '30', ...(o.json ? ['--json'] : [])]);
  }

  if (tracker === 'github') {
    const ref = needsRef ? ghRef(pos[0]) : null;
    if (needsRef && !ref) return { error: `say which issue, like owner/name#12 (got ${pos[0] || 'nothing'})` };
    const gh = (args) => ({ bin: 'gh', args });
    if (verb === 'view') return gh(['issue', 'view', ref.number, ...repoArgs(ref, o), '--comments', ...(o.json ? ['--json', 'number,title,state,body,author,assignees,labels,milestone,comments,url'] : [])]);
    if (verb === 'comment') {
      const t = textArgs(o, '--body');
      return t.length ? gh(['issue', 'comment', ref.number, ...repoArgs(ref, o), ...t]) : { error: 'say what to write: --body "…" or --body-file <file>' };
    }
    if (verb === 'move') {
      const status = pos.slice(1).join(' ').trim().toLowerCase();
      if (/^(done|closed?|resolved|fixed|complete[d]?)$/.test(status)) return gh(['issue', 'close', ref.number, ...repoArgs(ref, o), '--reason', o.reason === 'not planned' ? 'not planned' : 'completed']);
      if (/^(open|re-?open(ed)?|to ?do|in progress)$/.test(status)) return gh(['issue', 'reopen', ref.number, ...repoArgs(ref, o)]);
      return { error: `GitHub issues are only open or closed (got "${status || 'nothing'}"); use labels for more with gh issue edit` };
    }
    if (verb === 'new') {
      if (!o.title) return { error: 'say what it is: --title "…"' };
      if (o.repo && !/^[\w-][\w.-]*\/[\w-][\w.-]*$/.test(o.repo)) return { error: '--repo is owner/name' };
      const t = textArgs(o, '--body');
      return gh(['issue', 'create', ...repoArgs(null, o), '--title', o.title, ...(t.length ? t : ['--body', ''])]);
    }
    return gh(['search', 'issues', '--assignee', '@me', '--state', 'open', '--limit', '30', ...(o.json ? ['--json', 'repository,number,title,url,updatedAt'] : [])]);
  }
  return { error: `unknown tracker ${tracker}` };
}

module.exports = { ticketArgv, TICKET_USAGE };
