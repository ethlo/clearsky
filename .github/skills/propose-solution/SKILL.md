---
name: propose-solution
description: Look at where things stand in the code for a ticket, PR, bug or question, work out the best way to solve it, and ask me which way to go before changing anything. Use when I ask to check the current status and find the best solution, to propose a fix, or "what should we do about this".
---

# Check the status, find the best solution, ask me

Read only until I've picked: no edits, commits, pushes, Jira or GitHub changes.

## 1. Where it stands

The subject is the ticket, PR or problem I attached or named; with none, the current branch.

- Ticket: `acli jira workitem view <KEY> --fields summary,status,description,comment --json`.
- PR: `gh pr view <n> --json state,reviews,statusCheckRollup` and its unresolved threads.
- Code: find the local clone (the current folder, else under `~/dev/`), check out nothing. Read the code the problem touches, and search for what already exists: settings, flags, earlier fixes, the same pattern elsewhere. Check `git log -S` or `git log -- <file>` for earlier attempts.

Sum it up in at most five bullets, each with `file:line` where it applies: what happens today, why, and what was tried before.

## 2. Options

Work out two or three real ways to solve it, not variations of one. For each:

- what changes (files, config, behaviour);
- size (S, M or L) and risk, including compatibility for other users or services;
- what it leaves unsolved.

Prefer the smallest change that solves the cause, not just the symptom. Say so when a symptom fix (like a lower log level) hides a real problem.

## 3. Ask me

End with one question, as a choice (in Clearsky, a `choices` block), your recommendation first:

```choices
How should we fix <the problem>?
- <Option A> (recommended) | <what happens, one line>
- <Option B> | <what happens>
- Something else | I'll say what I want instead
```

Then stop and wait.

## 4. After I pick

Carry on with the usual workflow for the choice: a personal delivery skill if I have one (for example a feature-delivery skill for "ticket, branch, PR"), otherwise `continue-work`. Say which one you're using. A new branch starts from the fix version's release branch (`1.2.4` → `v1.2`); when that isn't clear, ask me which branch to start from, as continue-work describes.

When drafting anything posted as me (comments, replies, PR descriptions), follow the write-like-me skill.
