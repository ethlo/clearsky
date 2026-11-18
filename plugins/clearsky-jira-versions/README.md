# Jira versions for Clearsky

A [Clearsky](https://github.com/ethlo/clearsky) plugin. Add it with `clearsky add jira-versions --trust` (or Add under Settings → Plugins). It needs `--trust` because it lends chats a door with your login, so it runs inside Clearsky.

Clearsky reaches Jira through `acli`, but acli can't set a ticket's fix versions: `acli jira workitem edit` has no flag for them, and its `--from-json` takes only summary, type, description, assignee and labels. This plugin fills that gap. Chats run:

```
jira-versions show KEY…                  each ticket's fix versions
jira-versions add VERSION KEY…           add a fix version, keeping the others
jira-versions remove VERSION KEY…        take a fix version off
jira-versions raw KEY                    what Jira's server sends for a ticket, as it is
```

It goes through Atlassian's remote MCP server (`https://mcp.atlassian.com/v2/mcp`) with your own login, and needs no API token: log in with your browser under Settings → Plugins → Jira versions. The login is kept in `~/.config/clearsky/jira-versions-mcp.json` and never goes in a chat's sandbox. It asks only for the Jira scopes the server lists, plus staying logged in.

What it does with that login is narrow: it reads a ticket's fix versions and writes that one field, nothing else. Each `add` or `remove` asks you once in the chat, listing every ticket with its fix versions before and after; tickets that already have (or don't have) the version are left alone. Every call is in Copilot's changes.

Status moves don't need this: `acli jira workitem transition --key ABC-1 --status "Done"` already works through Clearsky's acli door.

It uses the Jira site Clearsky already knows (`JIRA_URL`, else the site acli is logged in to). Set **Jira site** (like `acme.atlassian.net`) only to use another one. Your organization's admin may need to allow the Rovo MCP server before the login works.
