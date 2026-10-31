// Advice, never a decision. A short "looks fine" or "check first" on each question Copilot asks you
// (and on each PR you're asked to review), with the reason. It's worked out from facts only:
// states, counts, branch names and file paths that Clearsky reads from GitHub and Jira itself.
// It never reads titles, descriptions or comments, so text in a PR or issue can't steer it.
//
//   { level: 'fine' | 'check', text, rule? }
// `rule` names the kind of request this is, when you could let all of them through from now on
// (Settings → Copilot → Let through without asking). A rule only ever applies to a 'fine' case.

const fine = (text, rule = null) => ({ level: 'fine', text: `Looks fine: ${text}`, ...(rule && { rule }) });
const check = (text, rule = null) => ({ level: 'check', text: `Check first: ${text}`, ...(rule && { rule }) });
const join = (xs) => (xs.length < 3 ? xs.join(' and ') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

// The kinds of request a rule can name, as Settings shows them.
export const RULES = {
  'merge-ready': 'merging a PR of the chat\'s repo when CI is green, it\'s approved and has no conflicts',
  'delete-merged-branch': 'deleting a branch whose PR is merged',
};
export function ruleLabel(rule) {
  if (RULES[rule]) return RULES[rule];
  const repo = rule.match(/^repo:(.+)$/)?.[1], project = rule.match(/^jira:(.+)$/)?.[1];
  return repo ? `everyday changes to ${repo}` : project ? `changes to tickets in Jira project ${project}` : rule;
}
export const parseRules = (s) => new Set(String(s || '').split(/[\s,]+/).map((x) => x.trim()).filter(Boolean));

// Merging a PR. `pr`: { number, ours, ci, approvals, changesRequested, mergeable, draft, base, protectedBase }.
export function mergeAdvice(pr) {
  if (!pr) return check('Clearsky couldn\'t read the PR it merges');
  const bad = [];
  if (!pr.ours) bad.push(`#${pr.number} isn't a PR this chat works on`);
  if (pr.draft) bad.push('it\'s a draft');
  if (pr.ci === 'FAILURE' || pr.ci === 'ERROR') bad.push('CI is failing');
  else if (pr.ci === 'PENDING') bad.push('CI is still running');
  else if (pr.ci !== 'SUCCESS') bad.push('no CI result');
  if (pr.changesRequested?.length) bad.push(`${join(pr.changesRequested)} asked for changes`);
  else if (!pr.approvals?.length) bad.push('nobody has approved it');
  if (pr.mergeable === false) bad.push('it has conflicts');
  if (bad.length) return check(`${join(bad)}.`);
  return fine(`#${pr.number} is this chat's PR, CI is green and ${join(pr.approvals)} approved it.`, 'merge-ready');
}

// Deleting a branch. `b`: { name, merged (its PR's number when merged), open (an open PR's number), shared }.
export function deleteAdvice(b) {
  if (!b) return check('Clearsky couldn\'t tell which branch this deletes.');
  if (b.shared) return check(`${b.name} is a branch others build on.`);
  if (b.open) return check(`${b.name} still has an open PR (#${b.open}).`);
  if (b.merged) return fine(`${b.name}'s PR #${b.merged} is merged.`, 'delete-merged-branch');
  return check(`${b.name} has no merged PR; its commits may be the only copy.`);
}

// Any GitHub question: `why` is the gate's reason (lib/github-gate.mjs); `facts` what Clearsky
// looked up for it ({ merge, branch, repo, chatRepos }).
export function githubAdvice(why = '', facts = {}) {
  if (facts.merge !== undefined) return mergeAdvice(facts.merge);
  if (facts.branch !== undefined) return deleteAdvice(facts.branch);
  const other = why.match(/^goes to (\S+),/)?.[1];
  if (other) {
    const owners = new Set([...(facts.chatRepos || [])].map((r) => r.split('/')[0]));
    const same = owners.has(other.split('/')[0].toLowerCase());
    return check(`this chat works on ${facts.chatRepos?.size ? join([...facts.chatRepos]) : 'no GitHub repo yet'}, not ${other}${same ? ' (same owner, so it may be a related repo)' : ''}.`, `repo:${other.toLowerCase()}`);
  }
  if (/couldn't tell which repo/.test(why)) return check('Clearsky couldn\'t tell which repo this changes.');
  if (/^pushes to /.test(why)) return check(`it ${why} directly, not through a PR (that branch has no protection on GitHub).`);
  if (/^force-pushes /.test(why)) return check(`it ${why}: commits on GitHub would be dropped.`);
  if (/workflows/.test(why)) return check('the branch changes CI\'s workflows, and a run gets the repo\'s secrets.');
  if (/couldn't (read|check)/.test(why)) return check(`${why}.`);
  if (/^pushes /.test(why)) return check(`it ${why} (tags and releases are seen by everyone).`);
  if (/settings|Protection|Ruleset|Collaborator|Member|Secret|Variable|DeployKey|Webhook|Permission|Visibility/i.test(why)) return check('it changes the repo\'s settings or access.');
  if (/^delete|deletes/i.test(why)) return check('it deletes something on GitHub, which can\'t be undone.');
  return check(`${why || 'a change Clearsky doesn\'t know'}.`);
}

// A Jira change that asks: `j` from jiraTargets() (bin/clearsky.mjs), `projects` the chat's.
export function jiraAdvice(j, projects = new Set()) {
  if (!j) return null;
  if (j.bulk) return check('it changes every ticket a search finds, not named tickets.');
  const other = j.projects.filter((p) => !projects.has(p));
  if (!j.projects.length) return check('Clearsky couldn\'t tell which tickets this changes.');
  return check(`${join(j.keys.length ? j.keys : other)} ${j.keys.length > 1 ? 'are' : 'is'} in ${join(other)}, and this chat works on ${projects.size ? join([...projects]) : 'no Jira project yet'}.`,
    other.length === 1 ? `jira:${other[0]}` : null);
}

// Running something outside the sandbox.
export function outsideAdvice({ vm = false } = {}) {
  return check(`it runs on your machine without the sandbox, with your logins and files.${vm ? ' Running it in the VM keeps it in.' : ''}`);
}

// A PR you're asked to review: routine, or worth verifying, and why. `p`: { size: {additions,
// deletions, files}, paths, ci, draft, botSuggestions, changesRequested }.
const RISKY = [
  [/(^|\/)\.github\/workflows\/|(^|\/)(Jenkinsfile|\.gitlab-ci\.ya?ml|azure-pipelines\.ya?ml)$/i, 'CI workflows'],
  [/(^|\/)(pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|package\.json|go\.mod|Cargo\.toml|requirements[^/]*\.txt|pyproject\.toml|Gemfile|\.mvn\/)/i, 'dependencies or the build'],
  [/(^|\/)(Dockerfile[^/]*|docker-compose[^/]*\.ya?ml)$|\.tf$|(^|\/)(helm|charts|k8s|kubernetes|terraform|infra|deploy)\//i, 'deployment or infrastructure'],
  [/auth|security|crypt|permission|(^|[/_.-])acl|login|token|secret|password|oauth|jwt|saml/i, 'security-related code'],
  [/migration|flyway|liquibase|changelog|schema|\.sql$/i, 'database schema'],
];
const LOW = /(^|\/)(docs?|test|tests|__tests__|spec|src\/test)\/|\.(md|adoc|txt|rst)$|(^|\/)(README|CHANGELOG|LICENSE)[^/]*$|[._-](test|spec)\.[a-z]+$|Test\.(java|kt)$/i;

export function reviewTriage(p) {
  const s = p.size || {}, lines = (s.additions || 0) + (s.deletions || 0), paths = p.paths || [];
  const why = [];
  const touched = RISKY.filter(([re]) => paths.some((f) => re.test(f))).map(([, label]) => label);
  if (touched.length) why.push(`touches ${join(touched)}`);
  const lowOnly = paths.length > 0 && paths.length === s.files && paths.every((f) => LOW.test(f));
  if (!lowOnly && (lines > 400 || s.files > 20)) why.push(`large (${lines} lines in ${s.files} files)`);
  if (s.files > paths.length) why.push(`${s.files} files, more than Clearsky checked`);
  if (p.ci === 'FAILURE' || p.ci === 'ERROR') why.push('CI is failing');
  else if (p.ci !== 'SUCCESS' && p.ci !== 'PENDING') why.push('no CI result');
  if (p.botSuggestions) why.push(`${p.botSuggestions} open Copilot suggestion${p.botSuggestions > 1 ? 's' : ''}`);
  if (p.changesRequested?.length) why.push(`${join(p.changesRequested)} asked for changes`);
  if (why.length) return { level: 'verify', text: `Verify: ${why.slice(0, 3).join(', ')}` };
  const good = [lowOnly ? 'only tests and docs' : `${lines} line${lines === 1 ? '' : 's'} in ${s.files} file${s.files === 1 ? '' : 's'}`,
    p.ci === 'SUCCESS' ? 'CI green' : 'CI still running'];
  return { level: 'routine', text: `Routine: ${good.join(', ')}` };
}
