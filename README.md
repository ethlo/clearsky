# Clearsky

One local page for what needs you at work: reviews, your PRs, your tickets (Jira or GitHub Issues), mentions, today's meetings and a stand-up summary, with a GitHub Copilot chat next to it that runs in a sandbox. It runs on your own machine with your own logins (`gh`, and `acli` if you use Jira), needs no tokens, and keeps nothing anywhere else.

Website, with a getting started guide: **https://clearsky.ethlo.com** (built from `site/`, this README and `docs/` by `npm run site`).

## Quick start

You need [Node 22+](https://nodejs.org) and git. For real data you also want the [GitHub CLI](https://cli.github.com) and, if you use Jira, the [Atlassian CLI](https://developer.atlassian.com/cloud/acli/guides/install-acli/). Linux, macOS and Windows all work; on Windows Clearsky runs in WSL2 (Ubuntu) and you use it from your Windows browser, see [Clearsky on Windows](docs/windows.md).

```sh
git clone https://github.com/ethlo/clearsky && cd clearsky
sh scripts/install.sh      # puts `clearsky` on your PATH; never uses sudo
clearsky try               # look around with made-up data first: no logins, nothing of yours
clearsky serve             # then the real thing, at http://127.0.0.1:7777
```

The first time, Clearsky opens a **welcome page** that checks what this machine has, asks where your tickets live (Jira, GitHub Issues or nowhere), and logs you in with a button each. That's all the setup there is. After that:

- `clearsky app` opens it in a window of its own (it's in your app menu too).
- If your team has a shared setup, join it: `clearsky join <the team's repo>` (see [Team packs](#team-packs)).
- Add what else you use: `clearsky add slack-mcp --trust`, `clearsky add grafana --trust`, `clearsky add visma-flyt --trust` (see [Plugins](#plugins)).
- Run `clearsky doctor` if something looks off.

Everything you set is in `~/.config/clearsky/` and can be changed under **Settings**.

## What you get

- **Work:** one list grouped by whose move it is: Copilot chats that need you, review requests, your PRs on your move, mentions (GitHub, Jira, Slack), your tickets, and what you're waiting on.
- **Now / Next:** your current or next meeting, how long you're free, and tasks that fit that gap.
- **Stand-up:** a ready-to-paste Yesterday / Today / Blockers for your daily stand-up.
- **Copilot:** a chat with the GitHub Copilot CLI on any PR or ticket, in your clone of the repo, inside a sandbox that asks before anything leaves your machine (a push, a Jira change, a new host). It can hand work off, run long builds in the background, review its own change before opening a PR, and write like you (see the next section).
- **Links, calendar, notifications,** and plugins for the rest (Slack, Grafana, school, your own).

## Make Copilot write like you

Comments, PR descriptions and Jira replies that Copilot drafts for you go through the **write-like-me** skill. It reads a voice profile, `~/.copilot/voice.md`, if you have one, and checks each draft against it. The file is yours alone: it stays on your machine, is never sent anywhere by Clearsky, and doesn't belong in any repo or team pack.

A good profile is short: a few rules on how you write, a checklist, and 10 to 20 real samples. To make one from what you've already written:

1. **Collect samples you wrote yourself.** Copy them into a scratch file such as `~/voice-samples.txt`: PR review comments, PR descriptions, Jira tickets and comments, emails, Slack messages. Pick a mix: a pushback, a question, an approval, a bug report, a ticket description. Leave out anything an agent drafted for you, and anything you're not allowed to put through an AI tool; if your company has rules about that, follow them, or write a few samples fresh.
2. **Let Copilot write the profile from them,** in a chat on your own machine:

   > Read ~/voice-samples.txt. Write ~/.copilot/voice.md with: 5 to 10 rules on how I write (length, tone, structure, language, words I use and avoid); a "Check every draft against this" list; and 15 short samples from the file with people's names, ticket keys, repo and company names replaced by placeholders.

3. **Delete the scratch file,** read `voice.md`, and fix anything that doesn't sound like you.
4. **Try it:** ask Copilot to draft a review comment, compare, and tighten the rules where it's off. Small rules work best ("answer the question first", "one hedge at most", "no headings or sign-offs").

A profile looks like this:

```markdown
# How I write
- The thread's language; English when unsure.
- 1 to 3 sentences. The point first, then the one fact that carries it.
- Push back directly, with the reason. No "just", no "I think maybe".

## Check every draft against this
- Does it answer the actual question in the first sentence?
- Could a word go? Then it goes.

## Samples
- "This retries forever if the queue is down. Cap it at 3 and log the last error?"
- "Looks good. One thing: <TICKET> also needs the migration, can you add it here?"
```

## Setup in detail

The welcome page (`/welcome`) shows what this machine has (Node, git, gh, acli, Copilot, the sandbox, a calendar), with the install command for your OS next to anything missing, buttons to log in to GitHub and Jira through their CLIs, and your work organizations picked from your gh login. `clearsky doctor` prints the same check in a terminal.

`sh scripts/install.sh` installs or updates everything. It puts `clearsky` and Anthropic's sandbox runtime (`srt`, for Settings → Copilot → Sandbox) on your PATH with npm, uses nvm's Node 22 when that's how Node is installed, and makes `~/.config/clearsky` (readable only by you). It never uses sudo: system packages the sandbox needs (bubblewrap, socat, ripgrep) and missing CLIs (gh, acli, copilot) are listed with the command to install them. `--no-sandbox` leaves srt out; `--service` starts Clearsky at login (systemd user service). Without the installer, `node bin/clearsky.mjs serve` works from the checkout.

### Try it first

`clearsky try` opens Clearsky with made-up data (a company called Acme, its PRs, tickets, meetings and a Copilot chat) on http://127.0.0.1:7790. It needs no logins. Nothing of yours is read or shown, so it's also the way to show Clearsky to others. **Leave demo** in its menu, or Ctrl+C, stops it and removes its data. Settings → General → **Try with demo data** starts the same demo from the page.

### Logins

- **GitHub:** nothing, if you're logged in with the GitHub CLI (`gh auth login`); Clearsky then uses `gh auth token`. Otherwise a fine-grained token with read access to Pull requests, Issues, Contents and Metadata on your work org. A classic token with `repo` scope also works. If your org uses SSO, authorize the token for it.
- **Tickets:** Jira, GitHub Issues, or no tracker (Settings → General → Tickets live in; see [Where your tickets live](docs/trackers.md)). Chats use one `ticket view|comment|move|new` command for any of them.
- **Jira:** no token in Clearsky. All Jira calls go through `acli` (`acli jira auth login --web`), so it uses whatever account `acli jira auth` is logged in as.
- **Google Calendar (optional), either or both ways.** When both are set up, their meetings are merged, and if one fails the other still shows:
  - **GNOME Online Accounts:** add your work Google account under Settings → Online Accounts with Calendar switched on, and set `CALENDAR_EMAIL`. Clearsky reads the calendar Evolution syncs locally, from its SQLite cache via `node:sqlite`, so it needs no login of its own. To include more calendars (a family or personal one), add that Google account in Online Accounts with only Calendar on, then tick the calendar in Clearsky's Settings (saved as `EVOLUTION_CALENDARS`). On a shared calendar like "Family", events only take your free time when you organise or are invited to them, or when one of your names (`CALENDAR_MY_NAMES`, say `Alex`) is in the title; the rest show greyed in the agenda. Holiday and birthday calendars are never picked automatically.
  - **Today's schedule** under Now / Next shows the day as a timeline: meetings as blocks (overlaps on their own line), your free slot in green, the rest of the workday, and a line for now. Hover over a meeting for its details (time, place, organizer, link, description); click to keep them open. The calendar names below the timeline hide or show each one (saved as `CALENDAR_HIDDEN`); a hidden calendar doesn't take your time either.
  - Times are 24-hour unless you pick 12-hour under Settings → General (`CLEARSKY_TIME_FORMAT=12`).
  - **iCal link:** in Google Calendar, open Settings, pick your calendar, then **Integrate calendar**, and copy **Secret address in iCal format** into `GOOGLE_CALENDAR_ICS`. Several addresses can be given, separated by spaces. Workspace admins often turn this off.
- **Slack (optional, no token):** `clearsky add slack-mcp --trust` talks to Slack's own MCP server read only. You log in from Settings in your browser, Copilot chats read Slack with `door slack …`, and mentions show under Needs you. See [clearsky-slack-mcp](plugins/clearsky-slack-mcp/README.md).
- **Confluence (optional, no token):** `clearsky add confluence` lets Copilot chats search and read Confluence with `confluence …`, read only, through Atlassian's MCP server. You log in from Settings in your browser; Clearsky registers itself as a client, so there's no app or token to create. Jira stays on `acli`. See [clearsky-confluence](plugins/clearsky-confluence/README.md).

The Settings page (`/settings`) runs `gh auth login --web` and `acli jira auth login --web` for you. Pasted tokens and URLs are written to `~/.config/clearsky/.env` (mode 600) and never shown back. The page only listens on 127.0.0.1, and changes need a per-run token, so other websites can't use it. The config is read from `./.env`, then the repo's `.env`, then `~/.config/clearsky/.env`. Real environment variables override all of them.

### Team packs

If your team shares a setup, join it: `clearsky join <git repo, https link or file>` (or paste it on the welcome page, or in Settings → General). It fills in the organizations, stand-up time, Copilot defaults, links and skills the team agreed on, and plugin settings such as the Slack app or the Grafana addresses (once you add the plugin), and keeps anything you set yourself. Tokens and the sandbox's doors are never part of a pack. A pack can also list the team's plugins, pinned to versions, and kinds of change the team suggests letting through without asking; you look at both and take them yourself.

To start one for your company, `clearsky team init ~/dev/clearsky-team` (or Settings → General → **Make a team pack**) writes a ready repo from your own settings: `clearsky-team.json`, a README for your colleagues, and folders for skills and work-only plugins, with no secrets in it. Push it to a private repo in your company's GitHub and share the link. See [docs/team-pack.md](docs/team-pack.md).

## Use

```sh
clearsky serve        # dashboard at http://127.0.0.1:7777, refreshes every 5 minutes
clearsky restart      # restart once no Copilot chat is working (--now: right away)
clearsky              # Markdown summary in the terminal
clearsky --json       # everything as JSON, for scripts and Copilot
clearsky standup      # stand-up summary (add --json for the data)
clearsky jira-debug   # raw acli output, if Jira data looks wrong
```

The page has a menu on the left and one work area beside it:
- **Work** is one list, grouped by what it needs from you: **Copilot now** (every open Copilot session, from here, a terminal or VS Code), **Needs you** (reviews, your PRs on your move, mentions), **Your tickets**, and **Waiting on others** (folded into one line). **Reviews**, **Your PRs**, **Mentions** and **Tickets** in the menu show just that part.
- Click a row (or press ↵) to open it in full in the work area: the PR, ticket or message with its details, a link to open it on GitHub, Jira or Slack, and the Copilot sessions about it. A Copilot session opens as its chat. Esc goes back. Ctrl-click a title to go straight to the source.
- **Ctrl+K** (⌘K on a Mac), or **Find anything** at the top of the menu, opens one box to find anything: PRs, tickets, mentions, Copilot chats, links, today's and tomorrow's meetings, servers, pages, Settings tabs, skills and a few commands. Paste a ticket key, `org/repo#12` or a link to open it even when it isn't in your lists. It searches what the page already has, so nothing extra is fetched.
- J/K move through the list, E marks the selected item done, H snoozes it, A opens the Copilot menu for it, O opens it on its site.
- **Done** (✓) hides an item until something new happens on it (a commit, review, comment or status change). Jira mentions are grouped per ticket, so marking one done hides the ticket until someone mentions you there again.
- **Snooze** (the clock) hides it for an hour, until tomorrow's stand-up, a week, or a date you pick, even if there's new activity. "Show N done, N snoozed" at the bottom of the list brings them back.
- **Calendar** in the menu has today as a schedule, and today and tomorrow as agendas; click a meeting for its details. The header of each list says when you're free until.
- Personal sources, such as School, each get a page under **Personal** in the menu.

Done and snoozed items are saved in `~/.config/clearsky/state.json`, so the plan respects them too.

"Has feedback" on your PR means someone commented after your latest commit; once you push, the PR shows as waiting for review.

The server also answers JSON on 127.0.0.1: `/api/source/<github|jira|jiraMentions|calendar|a plugin's name>`, `/api/plan`, `/api/work` (everything), `/api/standup`, `/api/issue/<KEY>`, `/api/pr?repo=<org/repo>&number=<n>` `/api/dismissed`, `/api/copilot/sessions` and `/api/copilot/sessions/<id>`. Add `?refresh=1` to skip the cache.

## Plugins

Clearsky's core is GitHub, Jira, your calendars, Copilot and your links. Everything else is a plugin you add: a folder with a `clearsky-plugin.json` and one ES module, with no build step and no dependencies to install. These have repos of their own and short names in Clearsky's catalog ([plugins/catalog.json](plugins/catalog.json)), each pinned to a released version:

| Name | What it does | Repo |
| --- | --- | --- |
| `grafana` | Logs and metrics for Copilot chats, read only, through `grafana …` | [clearsky-grafana](plugins/clearsky-grafana/) |
| `visma-flyt` | Messages, forms and weekly plans from Visma Flyt Skole | [clearsky-visma-flyt](plugins/clearsky-visma-flyt/) |
| `slack-mcp` | Slack through Slack's MCP server: mentions and read-only `door slack …` for chats, no token | [clearsky-slack-mcp](plugins/clearsky-slack-mcp/) |
| `confluence` | Read-only Confluence search and pages for chats, through Atlassian's MCP server | [clearsky-confluence](plugins/clearsky-confluence/) |

```
clearsky add slack-mcp                           # from the catalog: its repo, at the pinned tag
clearsky add github:someone/clearsky-weather     # a GitHub repo (#ref and /sub/folder work too)
clearsky add https://git.example.com/me/plug.git # any git repo, with your own git login
clearsky add npm:clearsky-weather@1.2.0          # an npm package, fetched without running its scripts
clearsky add ./my-plugin                         # a folder here
clearsky plugins                                 # what's added, and what the catalog has
clearsky update [<name>]                         # fetch again from where it came from (a #tag stays put)
clearsky update --check                          # newer version tags, without fetching code
clearsky update <name> --to v1.3.0               # move it to another tag, branch or commit
clearsky remove <name> [--data]
```

Or do the same under **Settings → Plugins**. Either way, you see what a plugin reaches (hosts, programs, files) before any of its code runs, and Clearsky loads it at its next start.

A plugin you add runs in a sandbox of its own (srt, like Copilot's): every fetch is a separate process that reaches only the hosts in its manifest, reads only its own code, writes only its own data folder, and gets only its own settings, with nothing of Clearsky's environment. Clearsky itself never loads its code. Its files are hashed when it's added (git ones also pinned to the commit), and a plugin whose files changed isn't loaded until you update it. A plugin that can't work in the sandbox, say because it opens a browser to log in (School) or lends chats a login (Grafana), says why in its manifest and is added only with `--trust` (or the box in Settings).

How to write one is in [docs/plugins.md](docs/plugins.md). For a quick private source there's still `~/.config/clearsky/sources/*.mjs`: one file each, loaded as it is, never shared. The hooks are the same; see the comment at the top of [lib/sources.mjs](lib/sources.mjs) and [test/sources/school.mjs](test/sources/school.mjs).

Work and personal stay apart: a source sets `area: 'work'` to sit with GitHub, Jira and Slack on the **Work** tab, or leaves it out to land on the **Personal** tab (school, training and the like). Only the calendar mixes the two: personal events show in the day schedule on both tabs.

## Its own window

`clearsky app` opens Clearsky in a window of its own (Chromium's app mode: no tabs or address bar, its own taskbar icon), starting the server first if it isn't running. The installer adds it to your app menu as **Clearsky**. It uses your normal browser profile, so links to GitHub and Jira open logged in. Any Chromium-based browser works (`CLEARSKY_BROWSER` picks one). The server is unchanged, so a browser tab still works too.

## Getting things done

Each row says whose move it is. Copilot's PR reviewer bot doesn't count as a reviewer: its comments show as a note ("Copilot left 3 suggestions") and never make a PR your move. Review threads you answered last, and outdated ones, aren't yours either. A PR nobody has been asked to review says **No reviewer yet**; open it and use **Request review** to pick people (GitHub's suggestions first, with who is already asked or has reviewed marked). Jira tickets in review, QA, testing or blocked statuses sit under Waiting on others. **Done** hides an item until something new happens on it, such as a person reviewing or its state changing, not a bot comment or your own push. What you did from Clearsky shows on the item ("You: Asked anna to review, 5 min ago"). The ↻ next to the page title shows how fresh the data is and refreshes everything; merged PRs drop out even before GitHub's search catches up.

PRs and tickets link to each other: a PR shows the Jira tickets in its title or branch (even ones that aren't yours) and the GitHub issues it closes, and a ticket shows its PRs with their state. Click one to open it in Clearsky. **Your PRs** and **Tickets** are tables with the branch too: a PR's head branch, and for a ticket, its PRs' branches plus any local or pushed branch in your clones under `~/dev` (or `CLEARSKY_CODE_DIRS`) with the key in its name. Drag a column header's edge to resize it, and use **Columns** to hide one; that's kept in the browser.

**Read by you.** Your PRs say whether you've read the code in them that you didn't write yourself: commits by Copilot (its Co-authored-by line, or pushed by a Clearsky chat), Copilot's coding agent, Claude or a colleague. **Mark read** remembers the commit you read up to; new commits after it show as "2 new", with a link to just those changes. PRs with unread code come first under **Not read by you**, and the ones reviewers are already on (or approved) move to **Needs you** in Work. Asking for review on one you haven't read asks you first. In Settings, **Your PRs: Everywhere** also includes PRs you opened outside the work organizations; PRs Copilot's coding agent opened for you are included either way.

## Running it

`clearsky restart` asks the running server to restart once no Copilot chat is working or waiting for your OK, so updating never cuts a turn off; idle chats carry on afterwards. To start Clearsky at login and keep it running, `contrib/clearsky.service` is a systemd user service (instructions inside); it sets `CLEARSKY_SUPERVISED=1`, so a restart hands over to systemd. Starts, restarts (with how they were asked for and how many chats were busy), stops and unexpected errors are logged to `~/.cache/clearsky/clearsky.log` (`CLEARSKY_LOG` for another file).

### In Docker

`clearsky docker up` (that is, `node bin/clearsky.mjs docker up`) builds and starts Clearsky in a Linux container, on http://127.0.0.1:7777. It takes everything from the same settings as natively: the folders under Settings → Copilot → "Folders Copilot may use" (and the general-chat folder) are mounted at the same paths, so they are also the container's fence. Tool folders you have are mounted alongside: Clearsky's and Copilot's, `~/.gitconfig`, JDKs, `~/.m2`, `~/.gradle`, `~/.sdkman` and GNOME's calendar caches. `clearsky docker mounts` lists them. After changing the folders in Settings, run `clearsky docker up` again to mount them; Settings points out a folder the container doesn't have. Also: `clearsky docker down`, `clearsky docker logs`. Anything extra goes in `docker-compose.override.yml`. On Windows, run it from WSL: paths are mounted as they are. Natively in WSL2 is simpler, though: see [Clearsky on Windows](docs/windows.md).

A container has no keyring, and acli can only keep its login in one, so Clearsky's container runs a keyring of its own, kept in `~/.config/clearsky/container/` (yours only). Log in once after the first start: `clearsky docker login` brings over the logins this machine already has: gh's, which Copilot uses too. acli's login can't be copied, so acli logs in through your browser as usual: its login calls back to a port on 127.0.0.1, so that runs in a one-off container on this machine's network while Clearsky pauses, and it prints the link to open. Anything else it can't bring over is done in the browser too. Your machine's own keyring and logins aren't used or changed.

Online Accounts calendars are found from `~/.config/clearsky/eds-sources.json`, which Clearsky writes whenever it runs natively. The School plugin's login (BankID) needs a browser, so log in natively and then hand it over with `clearsky school-handover` before starting the container; it moves the login from your keyring into the container's. Desktop notifications aren't available in the container. Updating: `git pull`, then `clearsky docker up` (Restart alone doesn't load new code into the image).

`npm test` includes a browser check of every view when Playwright is installed, and skips it otherwise.

## Notifications

While `clearsky serve` runs, it checks GitHub, Jira mentions and Slack every 3 minutes (Settings → General, or `CLEARSKY_POLL_MINUTES`), and GitHub again when you come back to the window and it is over a minute old. When something new needs you (a review request, a PR turning to your move, a mention), you get a desktop notification with an **Open** button on workdays from 07:00 until two hours after your workday ends. Dismissed and muted items stay quiet. Banners go straight to the desktop over D-Bus (`gdbus`), because Ubuntu's AppArmor profile for `notify-send` blocks the click on **Open**; a newer banner for the same item replaces the old one. Without D-Bus it falls back to `notify-send` (`CLEARSKY_NOTIFY=notify-send` forces it), and without either, the bell at the bottom of the menu turns on browser notifications instead. `CLEARSKY_NOTIFY=off` turns them off. New things also get a dot in the page and a count in the tab title until you've looked. A review request notifies when it's (re-)requested, not on every push or comment; a GitHub thread you were mentioned in notifies once; a status that flips back and forth notifies once; more than two at a time become one banner. **Notifications** in the menu lists the last 100 sent (kept across restarts), with links, to see why something came.

## Copilot chat

**✦ Copilot** in the top bar opens a chat with the GitHub Copilot CLI on your machine (`copilot`, logged in with your work account). The first message includes what's on your dashboard, so you can ask things like "what should I do first?". Answers link Jira keys and PRs with hover cards.

**Settings → Copilot** sets what a new chat starts with: model, reasoning effort, access mode, the folder for general chats, and the folders Copilot may use. In the panel you can pick the model and reasoning effort, how much Copilot may do: **Ask** (Allow/Deny buttons for each step), **Sandboxed** (Copilot runs in Anthropic's sandbox runtime and everything inside runs; it asks only at the sandbox's doors out, see below), **Full** (Clearsky says yes to anything Copilot still asks; denied patterns stay denied), Read only, or Plan only, and click a skill to use it. Every mode runs Copilot in its Agent Client Protocol mode, so whenever Copilot wants your OK, even in Full, you get Allow/Deny buttons instead of a refusal, and long builds aren't cut off. Copilot runs in the Clearsky folder (or `COPILOT_CWD`), so the skills below are available. A chat about a PR or ticket starts in that repo's clone, or the worktree with the PR's branch. Copilot may use files under **Settings → Copilot → Folders Copilot can change** (default `~/dev`, passed as `--add-dir`) without the "Access paths outside trusted directories" question. If `copilot` isn't on your PATH, Clearsky looks under nvm, or set `COPILOT_BIN`. Clearsky's own tokens are not passed to it.

**The sandbox and its doors.** Clearsky doesn't try to judge shell commands: srt, which Clearsky runs as a library, keeps Copilot to your folders and the allowed hosts. Your GitHub login never enters the sandbox: Copilot, git and gh inside get stand-ins, and srt's proxy adds your `gh` login on the way to GitHub. The proxy also decides what reaches GitHub (`lib/github-gate.mjs`): reading goes through, while a push, an API write or a GraphQL mutation waits until you click Allow in the chat, however the command was written. Copilot's built-in GitHub tools are off in the sandbox. Two more doors are small commands in `scripts/sandbox-bin` that hand work to Clearsky over a private socket (`lib/broker.mjs`): `acli` (Jira's login is in the keyring; reads run at once, changes ask) and `outside <command>` for anything that can't run inside, like tests that start Docker containers. Settings → Copilot → Never ask before lists Jira and `outside` commands that go through without asking. `review --ticket <KEY>` (or `--goal "…"`) gets a proper review of the chat's change before it opens a PR: Clearsky works out the diff and reads the ticket itself, and a fresh Copilot session in its own sandbox, which can only read the repo, reviews it knowing nothing but the goal and the code (`lib/review.mjs`). It answers with findings and `VERDICT: ready` or `VERDICT: fix first`; `COPILOT_REVIEW_MODEL` picks its model.

**Long tasks.** A chat used to stop when a turn waited on something long: a full build, `vm` tests, a CI run. In the sandbox, Copilot now starts those as background jobs with `bg <command>` (`bg vm <command>` in its VM, `bg outside <command>` on your machine after your OK) and ends its turn; Clearsky runs the job outside the turn, with the chat's own fence and the VM line, and wakes the chat with how it ended and the end of its output (`lib/jobs.mjs`). `jobs` lists them, `jobs log <id>` shows output so far, `jobs stop <id>` stops one; they also show in the chat's side pane. The list lives in `~/.config/clearsky/jobs.json`, so a result that hadn't reached its chat, or a job a restart cut short, still reaches it after Clearsky starts again. A restart waits for running jobs. The watchdog (`lib/watchdog.mjs`) nudges a chat that stops before its task is done (a limit, an error, an answer that stops mid-step or says there's more to do, or a turn with no word and nothing running for long), at most a few times per task; it never nudges a chat that asks you something, waits on your OK, has a job running, or that you stopped. Settings → Copilot → Long tasks sets how many nudges and how soon; the side pane pauses it per chat.

**＋ PR or ticket** attaches pull requests and Jira tickets to your next message: pick from what's on your dashboard, or paste a key (ABC-1234), `org/repo#12` or a link. Clearsky adds their details (description, status, files and reviews, latest comments) in front of your message, so you don't have to explain what you mean. The ✦ on any PR or ticket row asks about it, or runs one of your skills on it, in a new chat with that item attached.

**Starting Copilot on a PR or ticket** (the **Start it in Copilot** next step, a skill from the ✦ menu, or **Start in a new chat** on a New task card) first shows a small start box: **Anything to add** for your own instructions (only the backend part, ask before changing the schema…) and **Skill**, with the usual one picked (feature-delivery for a ticket to start, continue-work to carry on) and **None** to send just the ticket and your words. Enter starts it as it is, so a quick start is still one key; Esc cancels, and Shift+click on the button skips the box.

**Memory.** Copilot keeps notes across chats in one short Markdown file on your machine, `~/.local/share/clearsky/memory/memory.md` (at most 4 KB, outside any repo). Every new chat is told where it is and reads it from disk, using the part under `## All chats` and the part under `## owner/name` for the repo it works in. Copilot never writes it: when it learns something worth keeping (how you like things done, how a repo builds or tests), it suggests a note at the end of its answer, shown as a **Remember** card with Save, Edit and Skip. Only Save writes it. In the sandbox Copilot can read the file but not change it. You can read and edit the whole file under **Settings → Copilot → Memory** (`lib/memory.mjs`).

**New tasks get their own chat.** When a chat decides on new work (a follow-up ticket it made for you, a separate bug it found), it doesn't start on it there. It shows a **New task** card with the ticket and a short hand-off, and asks: **Start in a new chat** (the default) or **Continue here**. A new chat starts with the ticket attached and the hand-off as its first message, in the repo's clone, and the card in the first chat links to it. That chat stays about its own work.

Type **/** in the message box for skills and every slash command your Copilot offers (`/review`, `/plan`, `/compact`…), plus `/new`, `/history` and `/ref` for the chat.

A chat uses the whole work area, with what it's about (linked PRs and tickets, folder, status), your skills and its settings on the right. The menu has Settings and a Light / Dark / Auto theme switch (saved per device); on a phone it folds away behind ☰. In Chrome, 🎤 next to Send lets you talk instead of typing (so does the 🎤 in the corner of the start box, a Remember card you edit, and the memory editor in Settings); the browser sends the audio to Google to turn it into text, and nothing is sent to Copilot until you press Send.

**Copilot** in the menu lists the chats that are working or waiting on you, plus the ones you used lately here, each with a status dot. Click one, or press Alt+1…9, to switch; Alt+N starts a new chat. Switching (or reloading the page) doesn't stop a chat: it carries on in the background, and when you come back you see any question it's waiting on and follow it to the end. **Stop** ends a turn on purpose.

**History** lists your Copilot sessions as Copilot itself knows them, whether you started them here, in a terminal or in your editor, with ones open elsewhere marked. Click one to see the conversation and carry on with it. The chat you had open comes back after a page reload. Click a chat's title to rename it (the name is kept in Clearsky). A chat you start with ✦ on a ticket, PR or GitHub issue is named after it ("ABC-6519 · Fix capture timeout") in Clearsky. A PR, the Jira key in its title or branch, and the GitHub issues it closes count as one piece of work, so ✦ on any of them offers **Continue** on it before a new chat. A message you send while Copilot is still working waits and goes when the turn ends; Enter on an empty box, or **Stop**, stops the turn.

Sessions show up next to the PR or ticket they are about: one you started from that row or attached it to, one running in a checkout of the PR's branch, or one with the PR or ticket key in its title or branch. A dot shows if it is working (green), waiting for you (blue) or needs your OK (amber), and a click reopens it; the ✦ menu also offers **↩ Continue**. Any session that is working or waiting, linked or not, is listed under **Copilot now** at the top of Work, and one waiting for you counts in its number.

## Hand-offs

✦ on a PR, GitHub issue or ticket → **Work on it now, by itself** (or **From my next meeting**) hands it to Copilot. It works on hand-offs one at a time, always in the sandbox: on a feature branch, with the tests and a `review` before it opens anything, and it opens the PR as a draft. It never merges, approves, closes or deletes. The sandbox's doors still decide what leaves your machine, so a step that needs your OK waits for it in the chat. **Hand-offs** in the menu shows each one with its chat and how it ended: a draft PR (which then waits under Your PRs as not read by you), or a sentence on what it needs from you. They're kept in `~/.config/clearsky/handoffs.json`; a restart stops the one running, and its chat can carry on.

## Copilot skills

`.github/skills/` contains these skills for GitHub Copilot (agent mode in VS Code and the Copilot CLI):

- **triage-my-work:** runs `clearsky --json` and sorts everything into Do now / Today / Later / Waiting on others.
- **review-my-queue:** goes through your review requests, smallest and re-reviews first, and drafts review notes. It never submits a review unless you tell it to.
- **continue-work:** checks a PR or ticket (CI, conflicts, unresolved review comments, what the ticket still asks for), then carries on with what's left after asking once. It never merges, approves, force-pushes or posts comments without asking. From ✦ on a PR in Clearsky, the chat runs in your local clone of that repository (found under `~/dev`, or `CLEARSKY_CODE_DIRS`).

- **write-like-me:** anything posted as you (review comments, replies, PR descriptions, Jira comments, Slack) in your own voice: short, to the point, no filler. It reads your voice profile, `~/.copilot/voice.md`, if you have one; [Make Copilot write like you](#make-copilot-write-like-you) says how to make it.

Inside this repo Copilot picks them up automatically. To have them in every repo, copy them to your personal skills folder:

```sh
mkdir -p ~/.copilot/skills && cp -r .github/skills/* ~/.copilot/skills/
```

Then ask Copilot "triage my work" or "review my queue".

## Design docs

[docs/](docs/index.md) has the design docs in Markdown, with rendered HTML next to them (`npm run docs`): [how Clearsky works](docs/architecture.md) and [running it in a container, reachable from the phone](docs/remote-access.md) (on hold).

## Notes

- **Now / Next** treats back-to-back meetings (under 5 minutes apart) as one busy block and counts free time until the next meeting or `CLEARSKY_WORKDAY_END`. It then picks tasks in this order: PRs ready to merge, fresh Slack and Jira mentions, reviews (re-reviews and small ones first), your blocked PRs, and in-progress Jira work. A task is picked only if its rough time estimate fits.
- Jira data comes from `acli jira workitem search --json` and `acli jira workitem view <KEY> --fields comment --json`. `comment list` is not used, because it flattens comments to plain text and drops @mentions. Each candidate issue costs one `acli` call, run 4 at a time, and at most 40 issues are checked.
- Jira mentions are found with `comment ~ currentUser()` over the last 14 days. Each match is then confirmed by finding your account id in a mention in the comment's rich text. Mentions stay listed for the whole window; Jira's "seen" state isn't available. You can override the search with `JIRA_MENTIONS_JQL`.
- The server listens on 127.0.0.1 only and caches results for 2 minutes. Use the Refresh button to force a fetch.
- `npm test` runs the tests against a mocked GitHub and Slack, plus a fake `acli`.
- Before publishing a fork or a team pack, `node scripts/leak-check.mjs` (add `--history` for every past version) looks for real tokens, email addresses, home folders and words of your own listed in `~/.config/clearsky/private-words.txt`.

## License

MIT, see [LICENSE](LICENSE).
