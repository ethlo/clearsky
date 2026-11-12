# Where your tickets live

Clearsky works with **Jira**, with **GitHub Issues**, or with **no issue tracker** at all. Pick one in **Settings → General → Tickets live in**, on the welcome page, or in a team pack (`TRACKER`). Every choice uses a login you already have, so there's no token to make.

| | Jira | GitHub Issues | No tracker |
|---|---|---|---|
| Login | the Atlassian CLI (`acli jira auth login --web`) | the GitHub CLI login Clearsky already uses | none |
| Your tickets | assigned to you, by status | assigned to you, in your organizations | none |
| A PR's ticket | the key in its title or branch (`ABC-123`) | the issues it closes (`Fixes #12`) | none: the PR stands alone |
| Mentions | in Jira comments | in GitHub (as before) | GitHub only |
| Stand-up | tickets done and touched, with their PRs | issues closed and worked on, with their PRs | PRs and chats |
| Versions page | fix versions of starred projects | milestones of starred repos | hidden |
| `review --ticket` | `ABC-123` | `owner/name#12` | use `--goal` |

Left on **Automatic**, Clearsky picks Jira when Jira is set up on this machine (any Jira setting, or `acli` installed) and GitHub Issues otherwise, so nothing changes if you already used Jira.

## `ticket`: one command for chats and skills

Copilot chats, and the skills that come with Clearsky, use one small command for tickets, whatever the tracker:

```
ticket view <ref>                          read a ticket and its description
ticket comment <ref> --body "…"            add a comment (--body-file <file> for longer text)
ticket move <ref> <status>                 change its status ("In Progress", "Done"; GitHub: open or closed)
ticket new --title "…" [--body "…"]        create one (Jira: --project KEY [--type Task]; GitHub: [--repo owner/name])
ticket mine                                your open tickets
```

`<ref>` is `ABC-123` in Jira, and `owner/name#12` (or `#12` inside the repo's folder) on GitHub. `ticket` only translates: it runs `acli jira workitem …` or `gh issue …`, so in the sandbox each change goes through the same door as before and asks you the same way. Text is Markdown; for Jira, Clearsky turns it into rich text.

## GitHub Issues details

- Your issues are the open ones assigned to you in your work organizations (Settings → Plugins → GitHub).
- GitHub issues are open or closed. On the Versions page, an open issue with someone assigned counts as in progress.
- Star repos for the Versions page there with **☆ Repos**, or in Settings → Plugins → GitHub.

## Using something else

Linear, GitLab and others aren't built in yet. A plugin can still show tickets from anywhere in its own panel (see [Plugins](plugins.md)); choose **No tracker** so Jira stays out of the way.
