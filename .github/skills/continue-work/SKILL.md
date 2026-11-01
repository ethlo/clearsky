---
name: continue-work
description: Check the current status of a pull request or Jira ticket (or the current branch) and carry on with what's left. Use when I ask to check status and continue, pick up where I left off, or get a PR or ticket moving again.
---

# Check status and continue work

The item is the PR or Jira ticket I attached or named. With none, use the current branch: its PR (`gh pr view --json url`) and the ticket key in the branch name.

## 1. Find the work

- For a PR, find the local checkout of its repository: the current folder if it is that repo, otherwise look under `~/dev/` (for example `~/dev/acme/<repo>`). If there is none, ask me where it is, or whether to work from GitHub only.
- In the checkout, fetch and switch to the PR's branch (`gh pr checkout <number>`). If I have uncommitted changes there, stop and ask.
- For a ticket, read it with `acli jira workitem view <KEY> --json` and find its PR: search `gh pr list --search <KEY>` in the likely repos, or the branch named after the key.

## 2. Check the status

Report in a short list, newest first:

- **PR:** open, draft or merged; mergeable or in conflict with its base; CI checks (failing ones by name, with the first error line from `gh run view --log-failed`).
- **Reviews:** verdicts per reviewer, and every unresolved review thread (`gh pr view --comments`, or the review threads API), with `file:line` and what was asked.
- **Ticket:** status, assignee, the acceptance criteria or description, and comments since the last commit.
- **What's left:** your reading of what still needs doing, as a checklist.

## Check before you act

Things may already be done, by me or by an earlier session. Before each step, check its current state and skip it if it's done:

- **Reviewers:** list who is already requested (`gh pr view --json reviewRequests,reviews`). Don't request someone again who is still requested, or who reviewed after the last commit, unless I ask.
- **Ticket status:** read it first. Don't move a ticket that is already in the target status or further on.
- **Pushes:** compare the local branch with the remote (`git status -sb`). Don't push or commit again when there's nothing new.
- **Review threads:** skip threads I or you already answered, resolved threads, and outdated ones. Copilot's reviewer bot (`copilot-pull-request-reviewer`) leaves suggestions after every push; treat them as optional unless I say otherwise.

When nothing is left for me to do, say so plainly and name who it's waiting on (for example "Waiting on anna's review, requested 2h ago"), instead of redoing a step.

## 3. Continue

Ask me once whether to go ahead with the checklist, unless I already said to continue. Then, in this order:

1. Resolve merge conflicts by bringing in the base branch (merge, don't rebase or force-push unless I say so).
2. Fix failing CI. Run the same checks locally first when you can.
3. Address unresolved review comments: make the change, or draft a reply explaining why not.
4. Finish what the ticket still asks for.
5. Before opening the PR, and before pushing a larger round of changes to an open one, do a self-review, as below.
6. When Copilot's review rounds are done (its review is no longer requested and none of its threads are open), run the branch's CI build with tests, as below.

## Self-review before the PR

A proper review by a fresh reviewer that knows only the goal and the code, not this conversation:

- In Clearsky's sandbox, run `review --ticket <KEY>` in the repo (`--goal "<one or two sentences>"` when there's no ticket, `--base <branch>` when the PR won't target the default branch). Clearsky works out the diff and reads the ticket itself, and starts a new Copilot session that can only read the repo.
- Give it the goal only. Never pass your own reasoning, plans or what you think is risky: the point is a review without them.
- Without `review` (outside Clearsky's sandbox), start a new Copilot session yourself (`copilot -p`, read only) with only the ticket's summary and description and `git diff <base>...` in the prompt, and nothing from this conversation.
- Check each finding against the code. Fix the ones that hold up, and note in one line why you skip the others. Run it again after fixing; stop when it says `VERDICT: ready`, or after three rounds, and tell me what's still open.
- Put the result under "How it was checked": how many self-review rounds, and anything you chose not to fix.

GitHub's Copilot review still runs on the PR afterwards, as before.

## CI build after the review rounds

Once Copilot has no more findings, the branch gets a full CI build with tests before a person reviews it:

- Find how the repo builds in CI: `.github/workflows/` (`gh workflow list`). Pick the workflow that builds and tests branches or PRs.
- If it can be started by hand (`workflow_dispatch`), run it on the PR's branch: `gh workflow run <workflow> --ref <branch>`. If it only runs on push or on the PR, check the run for the latest commit instead (`gh pr checks`, `gh run list --branch <branch>`); start it again only if it didn't run for that commit (`gh run rerun <id>`).
- Follow it to the end (`gh run watch <id> --exit-status`). If it fails, read the failing step (`gh run view <id> --log-failed`), fix the cause, push, and run it again.
- If the repo builds somewhere else (Jenkins, for example), say so and ask me how to start it; don't guess.
- Put the result in the PR description under "How it was checked", with a link to the run.

Commit in small steps with clear messages, and run the tests before each push. Push to the PR's branch only.

## The PR description is for the human reviewer

After Copilot's review rounds, a person's review should be quick but still real. When you open the PR, and after each round of work on it, update its description (`gh api -X PATCH repos/<owner>/<repo>/pulls/<n> -F body=@<file>`; `gh pr edit` can silently drop the edit) to:

- **What and why:** the change and the reason, with the ticket key.
- **How it was checked:** the tests you ran and their result; the self-review rounds before the PR; how many Copilot review rounds, and that their findings are addressed or why not.
- **For the reviewer:** anything still open, decisions worth a second look, and where the risk is. Say "Nothing open" when that's so.

Facts only, short. If the repo has a PR template, keep its headings and fill them this way.

## Never without asking me

- Merge, approve, close, or force-push.
- Post review replies or Jira comments, or change a ticket's status: show me drafts.
- Touch another branch or someone else's PR.

End with what you did, what's still open, and anything that needs me.
