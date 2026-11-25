// A new Jira ticket gets its project and fix version from you. When a chat runs
// `acli jira workitem create` (itself, or through `ticket new`), Clearsky doesn't just let it
// through: the card asks which project it goes in and which fix version it gets. Many Jira setups
// let you set a fix version when a ticket is created but not change it afterwards (acli has no
// flag for it, and a read-only Atlassian MCP can't either), so this is the one chance to set it.
//
// acli's create takes fix versions only in its --from-json definition (`acli jira workitem create
// --generate-json` shows its keys; other fields go in additionalAttributes, as
// Jira's REST fields), so a ticket with a fix version is sent that way: the command's own flags
// become a definition in a private file, with the description as ADF.

import { toAdf, looksAdf, hasMarkup } from './to-adf.mjs';

export const PROJECT = /^[A-Z][A-Z0-9_]+$/;
const NONE = '';

// `acli jira workitem create …`: one ticket, not `create-bulk` or acli's JSON template.
export const isCreate = (argv) => Array.isArray(argv) && argv[0] === 'jira' && argv[1] === 'workitem' && argv[2] === 'create'
  && !argv.some((a) => /^--generate-json(=|$)/.test(a) || /^(--help|-h)$/.test(a));

const FLAGS = {
  '--summary': 'summary', '-s': 'summary', '--project': 'project', '-p': 'project', '--type': 'type', '-t': 'type',
  '--assignee': 'assignee', '-a': 'assignee', '--label': 'label', '-l': 'label', '--parent': 'parent',
  '--description': 'description', '-d': 'description', '--description-file': 'descriptionFile',
  '--from-file': 'fromFile', '-f': 'fromFile', '--from-json': 'fromJson',
};

// The create command's flags, by what they are: { summary, project, type, …, json, editor }.
export function createFlags(argv) {
  const o = { json: false, editor: false, rest: [] };
  for (let i = 3; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.startsWith('--') ? a.indexOf('=') : -1;
    const flag = eq > 0 ? a.slice(0, eq) : a;
    if (flag === '--json') { o.json = true; continue; }
    if (flag === '--editor' || flag === '-e') { o.editor = true; continue; }
    const k = FLAGS[flag];
    if (!k) { o.rest.push(a); continue; }
    const v = eq > 0 ? a.slice(eq + 1) : argv[++i];
    if (v === undefined) { o.rest.push(a); continue; }
    o[k] = v;
  }
  return o;
}

// What the card shows about the ticket: its project as the chat gave it, summary and type.
export function createSummary(argv) {
  const o = createFlags(argv);
  return { project: PROJECT.test(o.project || '') ? o.project : null, summary: o.summary || null, type: o.type || null, fromJson: o.fromJson || null };
}

// The versions a new ticket can get: unreleased ones, soonest first (all of them when none is).
export function openVersions(list = []) {
  const live = list.filter((v) => v && v.name && !v.released && !v.archived);
  return (live.length ? live : list.filter((v) => v && v.name && !v.archived)).map((v) => ({ name: v.name, releaseDate: v.releaseDate || null, released: !!v.released }));
}

// The card's fields: project (the one the chat named first, then this chat's, then starred) and
// fix version (optional: not every project uses them), with each project's own versions. `versions` maps a project to its list, or to
// null when Clearsky couldn't read them.
export function ticketFields({ project, chatProjects = [], starred = [], versions = {} }) {
  const keys = [...new Set([project, ...chatProjects, ...starred].filter((k) => PROJECT.test(k || '')))];
  return [
    { name: 'project', label: 'Project', value: keys[0] || '', options: keys.map((k) => ({ value: k, label: k })) },
    { name: 'version', label: 'Fix version', value: NONE, by: 'project',
      choices: Object.fromEntries(keys.map((k) => [k, [
        ...(versions[k] || []).map((v) => ({ value: v.name, label: v.releaseDate ? `${v.name} (${v.releaseDate.slice(0, 10)})` : v.name })),
        { value: NONE, label: 'No fix version' },
      ]])),
      notes: Object.fromEntries(keys.filter((k) => versions[k] == null).map((k) => [k, 'Clearsky couldn\'t read this project\'s versions.'])) },
  ];
}

// Your answer, checked against what the card offered: { project, version } or null.
export function pickedTicket(fields, values) {
  if (!values || typeof values !== 'object') return null;
  const [p, v] = fields;
  const project = String(values.project ?? '');
  if (!p.options.some((o) => o.value === project)) return null;
  const version = typeof values.version === 'string' ? values.version : NONE; // not every project has versions
  if (!(v.choices[project] || []).some((o) => o.value === version)) return null;
  return { project, version: version || null };
}

// The command to run for your answer. No version: the same command, in the project you picked.
// A version (or a --from-json command): a --from-json definition (written with `writeFile`) built from the command's flags or
// its own --from-json (read with `readFile`, relative to `cwd`). Throws when it can't be built.
export function ticketArgv(argv, { project, version }, { readFile, writeFile, cwd = null }) {
  const o = createFlags(argv);
  const abs = (f) => (f.startsWith('/') || !cwd ? f : `${cwd.replace(/\/$/, '')}/${f}`);
  if (!version && !o.fromJson) {
    const out = [];
    let set = false;
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (/^(--project|-p)$/.test(a)) { out.push(a, project); i++; set = true; continue; }
      if (/^--project=/.test(a)) { out.push(`--project=${project}`); set = true; continue; }
      out.push(a);
    }
    return set ? out : [...out, '--project', project];
  }
  if (o.editor) throw new Error('acli\'s --editor can\'t be used from a chat; give --summary and --description instead');
  let def = {};
  if (o.fromJson) {
    try { def = JSON.parse(readFile(abs(o.fromJson))); } catch (e) { throw new Error(`can't read ${o.fromJson} as JSON (${e.message})`); }
    if (!def || typeof def !== 'object' || Array.isArray(def)) throw new Error(`${o.fromJson} isn't a work item definition`);
  }
  if (o.fromFile) {
    const [first, ...rest] = String(readFile(abs(o.fromFile))).replace(/\r\n/g, '\n').split('\n');
    def.summary ??= first.trim();
    if (rest.join('\n').trim()) def.description ??= rest.join('\n').trim();
  }
  if (o.summary != null) def.summary = o.summary;
  if (o.type != null) def.type = o.type;
  if (o.assignee != null) def.assignee = o.assignee;
  if (o.label != null) def.labels = o.label.split(',').map((s) => s.trim()).filter(Boolean);
  if (o.parent != null) def.parentIssueId = o.parent;
  if (o.descriptionFile != null) def.description = String(readFile(abs(o.descriptionFile)));
  else if (o.description != null) def.description = o.description;
  if (typeof def.description === 'string') {
    if (looksAdf(def.description)) { try { def.description = JSON.parse(def.description); } catch { /* left as text */ } }
    else if (hasMarkup(def.description)) def.description = toAdf(def.description);
  }
  if (!def.summary) throw new Error('the ticket has no summary');
  def.projectKey = project;
  def.type ||= 'Task';
  if (version) def.additionalAttributes = { ...(def.additionalAttributes || {}), fixVersions: [{ name: version }] };
  return ['jira', 'workitem', 'create', '--from-json', writeFile('workitem.json', JSON.stringify(def, null, 2)), ...(o.json ? ['--json'] : [])];
}
