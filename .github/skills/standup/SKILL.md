---
name: standup
description: Write my stand-up update (yesterday, today, blockers) from my GitHub, Jira and calendar activity. Use when I ask for my standup, daily update, or what I did yesterday.
---

# Stand-up

1. Run `clearsky standup --json` (or `node <path-to-clearsky>/bin/clearsky.mjs standup --json`).
2. Start from its `text` field, which is already in Yesterday / Today / Blockers form. Tighten it:
   - Group related items, e.g. a merged PR and the Jira issue it closes.
   - Keep each line short; drop commit counts if the PR lines already cover the work.
   - If `yesterday.github.error` or `yesterday.jira.error` is set, say that part may be incomplete.
3. Show the result ready to paste into Slack. Don't post it anywhere yourself.
