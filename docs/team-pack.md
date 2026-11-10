# Team packs

A team pack is your team's shared Clearsky setup. It lives in a git repo (or a file) that the team owns, not in Clearsky, so nothing about your company ends up in this repo. A new colleague joins it once:

```sh
clearsky join https://github.com/acme/clearsky-team.git
```

or pastes the same address on the welcome page or in Settings → General → Team pack. Running `clearsky join` again, or **Update** in Settings, fetches the newest version.

## What's in one

The repo has a `clearsky-team.json` at the top, and optionally a folder of Copilot skills:

```
clearsky-team/
  clearsky-team.json
  skills/
    release-notes/SKILL.md
```

```json
{
  "name": "Payments team",
  "settings": {
    "GITHUB_ORGS": "acme",
    "CLEARSKY_STANDUP_TIME": "09:45",
    "CLEARSKY_WORKDAYS": "Mon-Fri",
    "COPILOT_FOLDERS": "~/dev/acme",
    "COPILOT_DOMAINS": "repo.acme.example",
    "GRAFANA_INSTANCES": "test=https://grafana.test.acme.example, prod=https://grafana.acme.example"
  },
  "links": [
    { "name": "Team", "links": [{ "title": "Board", "url": "https://acme.atlassian.net/jira/software/projects/PAY/boards/12" }] }
  ],
  "skills": "skills",
  "plugins": [
    "github:someone/clearsky-weather#v1.2.0",
    { "from": "./plugins/deploys", "note": "Our deploy board" }
  ],
  "jira": { "site": "acme.atlassian.net" },
  "gate": { "suggest": ["repo:acme/docs", "jira:PAY"] }
}
```

## Starting one

```sh
clearsky team init ~/dev/clearsky-team --name "Payments team" \
  --repo https://github.com/acme/clearsky-team --jira-site acme.atlassian.net [--links]
```

or Settings → General → **Make a team pack**. It writes a folder that's ready to push:

```
clearsky-team/
  clearsky-team.json   from your settings: the ones a team may set, never a secret
  README.md            for colleagues: install, log in, join, what joining changes
  skills/README.md     put shared Copilot skills here
  plugins/README.md    put work-only plugins here
  .gitignore
```

The plugins you added are listed with where they come from and their pins (one that follows a branch is pointed out, and one added from a folder here is left out, since colleagues can't fetch it). Your "always" rules become the pack's suggestions, minus repos outside the team's organizations. A value that looks like a token or a password is left out and named. Look it through, run `node scripts/leak-check.mjs <folder>` from a Clearsky checkout once it's a git repo, then push it with the `gh repo create … --private` line it prints. Nothing is pushed for you.

`clearsky team export --name "Payments team"` prints just the JSON from your own settings; add `--links` to include your work links.

## What joining does

- **Settings:** a pack value fills a setting you haven't set, or one the pack set before. A setting you changed yourself is kept, and joining says so. Only team-wide settings are taken (organizations, stand-up, workdays, starred Jira projects, Copilot defaults and folders, the sandbox's extra hosts, VPN check), plus the settings plugins let a team set (below). Tokens, your calendar, and the sandbox's doors (**Never ask before**, the "always" rules) are never taken from a pack: those stay your own decisions.
- **The sandbox:** extra hosts in `COPILOT_DOMAINS` or `COPILOT_VM_IMAGES` are named when you join, so you know the sandbox may reach them.
- **Links** are added to your work links. Links you already have aren't added twice.
- **Skills** are copied to `~/.copilot/skills`, so Copilot has them in every repo. A skill you already have with the same name is left alone.

- **Suggested rules** (`gate.suggest`): kinds of change the team lets through without asking, such as a docs repo's everyday changes (`repo:acme/docs`) or one Jira project's tickets (`jira:PAY`). They're offered under Settings → Copilot → Let through without asking, each with **Add**; the pack never changes your gate itself.
- **Jira** (`jira.site`): joining tells you which site to log in to with `acli`.

- **Plugins** are offered, never added unseen. They show under Settings → Plugins → From *your team*, each with **Look at it**, and `clearsky add --team` goes through them in a terminal. You see what each one reaches before it's added, like any plugin.

A git pack is fetched with your own git login (and your gh login for github.com), so a private team repo works without a token. What you joined is remembered in `~/.config/clearsky/team.json`.

## Plugins in a pack

Each entry is anything `clearsky add` takes, or `./folder` for a plugin kept in the pack's own repo (fetched from that repo, with your login, like any git plugin). A plugin only your company uses can live there or in a private repo of its own; nothing of it needs to be public.

The pin in the pack is the team's version. Pin with a tag (`#v1.2.0`); when the team moves it to `#v1.3.0` and you update the pack, the plugin shows "you have another version" with **Look at the team's version**. A plugin without a pin follows its default branch for everyone.

A plugin can let a team set some of its settings by marking them `"team": true` in its manifest (never a secret). Clearsky's own plugins do: Slack (MCP) its app client ID, redirect URL, scopes, server and mentions search; Confluence its site, server and scopes; Grafana its environments and which ask every time (from v1.1.0 of each). Put the values in the pack's `settings` like any other. If you haven't added the plugin yet, they wait in `team.json` and are filled in at the first start after you add it. Your own values win, as with every team setting.

## Using Clearsky at work

A setup that keeps the company out of every public repo:

1. **Clearsky** and any general plugins are public repos, with nothing about the company in them.
2. **A work repo** (private, in the company's GitHub) holds `clearsky-team.json`: organizations, Jira site, stand-up, Copilot's folders and hosts, links, skills, and the list of plugins with their versions. Work-only plugins live in it under `plugins/`, or in private repos of their own.
3. **Each person** installs Clearsky, logs in with `gh auth login` and `acli`, and runs `clearsky join https://github.com/acme/clearsky-team` (or pastes it on the welcome page). Logins stay on each laptop; the work repo holds no secrets.

Changing the team's setup is a pull request to the work repo. People get it with **Update** in Settings → General → Team pack, or `clearsky join`.
