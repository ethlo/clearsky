---
name: review-my-queue
description: Go through the pull requests waiting for my review and draft review notes for each. Use when I ask to review my queue, look at my review requests, or prepare reviews.
---

# Review my queue

1. Run `clearsky --json` (or `node <path-to-clearsky>/bin/clearsky.mjs --json`) and take `github.reviewRequested`.
2. Order the PRs: re-reviews first, then smallest (`size.additions + size.deletions`), then oldest `requestedAt`. Skip drafts unless I ask for them.
3. Ask me how many to cover if there are more than 5. Otherwise do them all.
4. For each PR, use the GitHub tools (or `gh pr view <url>` / `gh pr diff <url>`) to read the description, the diff and existing review comments. For a re-review, focus on what changed since my last review and whether my earlier comments were addressed.
5. Write for each PR:
   - **Summary:** one or two sentences on what it does.
   - **Risk:** low / medium / high, and why.
   - **Findings:** concrete issues with `file:line`, ordered by severity. Separate must-fix from nits.
   - **Suggested verdict:** approve, comment or request changes.
6. Never submit a review, approve, or post comments unless I explicitly say so for that PR. Show drafts only.

When drafting anything posted as me (comments, replies, PR descriptions), follow the write-like-me skill.
