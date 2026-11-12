// Where your tickets live: Jira (through acli), GitHub Issues (through gh), or nowhere.
//
// Clearsky started out Jira-only. The tracker is now one setting (TRACKER, Settings → General,
// or a team pack), and the rest of Clearsky asks this file what a ticket is:
//
//   jira    Jira tickets ("ABC-123") through the Atlassian CLI and its web login.
//   github  GitHub issues ("owner/name#12") through the GitHub CLI login Clearsky already has.
//           PRs link to the issues they close ("Fixes #12"), and milestones are the versions.
//   none    No tracker: the stand-up groups work by PR and chat, and ticket pages stay hidden.
//
// Left empty, it is Jira when Jira is set up (any JIRA_* setting, or acli on this machine), so
// nothing changes for people who had Jira, and GitHub Issues otherwise.
//
// Chats use one command for all three: `ticket view|comment|move|new|mine` (scripts/ticket-bin),
// which runs acli or gh, so every ask and rule for those stays as it is.

import { existsSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { createRequire } from 'node:module';

export const TRACKERS = {
  jira: { name: 'jira', label: 'Jira', noun: 'ticket', cli: 'acli', example: 'ABC-123' },
  github: { name: 'github', label: 'GitHub Issues', noun: 'issue', cli: 'gh', example: 'owner/name#12' },
  none: { name: 'none', label: 'No tracker', noun: 'ticket', cli: null, example: '' },
};
export const TRACKER_NAMES = Object.keys(TRACKERS);

// The acli on PATH (or ACLI_BIN), checked without running it.
export function cliOnPath(bin, path = process.env.PATH || '', platform = process.platform) {
  if (!bin) return false;
  if (bin.includes('/') || bin.includes('\\')) return existsSync(bin);
  const names = platform === 'win32' ? [`${bin}.exe`, `${bin}.cmd`, bin] : [bin];
  return path.split(delimiter).some((dir) => dir && names.some((n) => existsSync(join(dir, n))));
}

const JIRA_SET_UP = ['JIRA_URL', 'JIRA_ACCOUNT_ID', 'JIRA_STARRED_PROJECTS', 'JIRA_ASSIGNED_JQL', 'JIRA_MENTIONS_JQL', 'ACLI_BIN'];

// The tracker in use. `acli` says whether the Atlassian CLI is installed (asked only when unset).
export function trackerName(env = process.env, { acli = () => cliOnPath(env.ACLI_BIN || 'acli', env.PATH) } = {}) {
  const v = String(env.TRACKER || '').trim().toLowerCase();
  if (TRACKERS[v]) return v;
  if (JIRA_SET_UP.some((k) => env[k])) return 'jira';
  return acli() ? 'jira' : 'github';
}
export const trackerOf = (env, opts) => TRACKERS[trackerName(env, opts)];

// ---- Ticket refs

export const JIRA_KEY_RE = /^[A-Z][A-Z0-9_]+-\d+$/;
export const GH_ISSUE_RE = /^([\w-][\w.-]*\/[\w-][\w.-]*)#(\d+)$/;

// "owner/name#12", "https://github.com/owner/name/issues/12" → { repo, number }.
export function ghIssue(text) {
  const t = String(text || '').trim();
  const m = t.match(GH_ISSUE_RE) || t.match(/^https:\/\/github\.com\/([\w-][\w.-]*\/[\w-][\w.-]*)\/issues\/(\d+)\/?$/);
  return m ? { repo: m[1], number: Number(m[2]) } : null;
}

// A ref for the tracker: a Jira key (upper-cased) or a GitHub issue, or null.
export function ticketRef(text, tracker = 'jira') {
  const t = String(text || '').trim();
  if (tracker === 'github') { const g = ghIssue(t); return g ? { kind: 'gh', ...g } : null; }
  if (tracker === 'jira') {
    const m = t.match(/\/browse\/([A-Z][A-Z0-9_]+-\d+)/i) || t.match(/^([A-Z][A-Z0-9_]+-\d+)$/i);
    return m ? { kind: 'issue', key: m[1].toUpperCase() } : null;
  }
  return null;
}

// ---- What chats are told

// One line on where tickets live and how to reach them, next to the other hints.
export function trackerHint(name) {
  if (name === 'github') {
    return 'My tickets are GitHub issues (owner/name#12). Read and change them with `ticket view|comment|move|new <ref>` '
      + '(or `gh issue …`); a PR links to its issue with "Fixes owner/name#12" in its description. Changes ask me like other GitHub changes.';
  }
  if (name === 'none') {
    return 'I don\'t use an issue tracker here: there are no tickets to read or update, so work from the PR, the code and what I tell you.';
  }
  return 'My tickets are in Jira (ABC-123). Read and change them with `ticket view|comment|move|new <KEY>` (or `acli jira workitem …`).';
}

// `ticket` itself (scripts/ticket-bin/translate.js), shared so tests and the docs see the same.
const { ticketArgv, TICKET_USAGE } = createRequire(import.meta.url)('../scripts/ticket-bin/translate.js');
export { ticketArgv, TICKET_USAGE };
