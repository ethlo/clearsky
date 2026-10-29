---
name: continue-work
description: Check the current status of a pull request or Jira ticket (or the current branch) and carry on with what's left. Use when I ask to check status and continue, pick up where I left off, or get a PR or ticket moving again.
---

# Check status and continue work

The item is the PR or Jira ticket I attached or named. With none, use the current branch: its PR (`gh pr view --json url`) and the ticket key in the branch name.

## 1. Find the work

- For a PR, find the local checkout of its repository: the current folder if it is that repo, otherwise look under `~/dev/` (for example `~/dev/kezzler/<repo>`). If there is none, ask me where it is, or whether to work from GitHub only.
- In the checkout, fetch and switch to the PR's branch (`gh pr checkout <number>`). If I have uncommitted changes there, stop and ask.
- For a ticket, read it with `acli jira workitem view <KEY> --json` and find its PR: search `gh pr list --search <KEY>` in the likely repos, or the branch named after the key.

## 2. Check the status

Report in a short list, newest first:

- **PR:** open, draft or merged; mergeable or in conflict with its base; CI checks (failing ones by name, with the first error line from `gh run view --log-failed`).
- **Reviews:** verdicts per reviewer, and every unresolved review thread (`gh pr view --comments`, or the review threads API), with `file:line` and what was asked.
- **Ticket:** status, assignee, the acceptance criteria or description, and comments since the last commit.
- **What's left:** your reading of what still needs doing, as a checklist.

## 3. Continue

Ask me once whether to go ahead with the checklist, unless I already said to continue. Then, in this order:

1. Resolve merge conflicts by bringing in the base branch (merge, don't rebase or force-push unless I say so).
2. Fix failing CI. Run the same checks locally first when you can.
3. Address unresolved review comments: make the change, or draft a reply explaining why not.
4. Finish what the ticket still asks for.

Commit in small steps with clear messages, and run the tests before each push. Push to the PR's branch only.

## Never without asking me

- Merge, approve, close, or force-push.
- Post review replies or Jira comments, or change a ticket's status: show me drafts.
- Touch another branch or someone else's PR.

End with what you did, what's still open, and anything that needs me.
