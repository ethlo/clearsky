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
  "skills": "skills"
}
```

`clearsky team export --name "Payments team"` prints one made from your own settings; add `--links` to include your work links. Check it before you share it.

## What joining does

- **Settings:** a pack value fills a setting you haven't set, or one the pack set before. A setting you changed yourself is kept, and joining says so. Only team-wide settings are taken (organizations, stand-up, workdays, Copilot defaults and folders, the sandbox's extra hosts, Grafana, VPN check). Tokens, your calendar, and the sandbox's doors (**Never ask before**, the "always" rules) are never taken from a pack: those stay your own decisions.
- **The sandbox:** extra hosts in `COPILOT_DOMAINS` or `COPILOT_VM_IMAGES` are named when you join, so you know the sandbox may reach them.
- **Links** are added to your work links. Links you already have aren't added twice.
- **Skills** are copied to `~/.copilot/skills`, so Copilot has them in every repo. A skill you already have with the same name is left alone.

A git pack is fetched with your own git login, so a private team repo works without a token. What you joined is remembered in `~/.config/clearsky/team.json`.
