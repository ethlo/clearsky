---
name: triage-my-work
description: Sort and prioritize my open work across GitHub, Jira and Slack (review requests, my PRs, mentions, assigned issues) into a short plan. Use when I ask what to work on, to triage, sort, or plan my day.
---

# Triage my work

1. Run `clearsky --json` in the terminal. If the command is not found, run `node <path-to-clearsky>/bin/clearsky.mjs --json`.
   If a source has an `error` field, say so in one line and continue with the rest. `slack.disabled: true` just means Slack is not configured; skip it silently.
2. Build a prioritized plan from the JSON using these rules, highest first:
   - **Unblock others:** `github.reviewRequested`. Re-reviews (`rerequested: true`) and small PRs (few lines changed) first, then oldest `requestedAt`. Skip drafts unless nothing else is waiting.
   - **My PRs where `status.owner` is `me`:** `CI failing`, `Merge conflict`, `Changes requested`, unresolved threads, then `Ready to merge` (quick win: just merge it).
   - **Mentions:** `slack.mentions`, `jira.mentions` and `github.mentions` from the last 2 days that look like questions or requests to me (read `excerpt`). Older ones only if they still look unanswered.
   - **Jira work:** `jira.assigned`. In progress (`statusCategory: indeterminate`) before To do; then by priority and `due` date. Flag anything overdue or due within 2 days.
   - My PRs where `status.owner` is `others` are not tasks. List them once at the end as "waiting on others" with who they wait on.
3. Output:
   - **Do now** (max 5), **Today** (max 5), **Later**, **Waiting on others**.
   - One line per item: link, what to do as a verb ("Review", "Fix CI", "Reply to Anna", "Merge"), and a short reason.
   - End with a one-line summary of counts.
4. Do not change anything on GitHub, Jira or Slack. This skill is read-only.
