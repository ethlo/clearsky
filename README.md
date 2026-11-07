# Clearsky

One page that shows what needs your attention at work:

- **Now / Next:** your current or next meeting, how much free time you have until it, and up to three tasks that fit that gap (optional, from Google Calendar).
- **Needs my review:** open PRs where your review is requested, oldest request first, with re-reviews flagged.
- **My PRs:** each open PR shows who has the ball (changes requested, CI failing, merge conflict, unresolved threads, ready to merge) or who you are waiting on.
- **Mentions:** GitHub issues and PRs that mention you, Jira comments that @mention you, and (optionally) Slack messages that @mention you, from the last 14 days.
- **What I have left:** your open Jira issues (in progress, then to do), plus GitHub issues assigned to you.
- **Stand-up tab:** a ready-to-paste Yesterday / Today / Blockers summary for your next daily stand-up (`CLEARSKY_STANDUP_TIME`, default 09:45, on `CLEARSKY_WORKDAYS`, default Mon-Fri). It covers everything since the previous stand-up, so on Monday that's since Friday's: PRs merged, opened and reviewed, commits, and Jira issues you finished or worked on. Today comes from the dashboard queue and your meetings. The dashboard reminds you 30 minutes before, and the stand-up counts as a meeting in Now / Next.
- **Links:** your favourites in groups, under Work or Personal in the menu. Add one with Add link or by dropping a link from your browser, or import your browser's bookmarks (its HTML export; each folder becomes a group). Edit renames, moves between Work and Personal, reorders and removes. They're kept only in `~/.config/clearsky/links.json`, and no favicons are fetched.
- **Loads as it goes:** each source (GitHub, Jira, Jira mentions, Slack, calendar) loads on its own, so the page shows whatever is ready first.
- **Hover cards:** hover a Jira key like `ABC-1234` or a PR like `org/repo#12` on the Stand-up tab to see its title, status and summary, with a link to the full item.
- **Settings page** (`/settings`): log in to GitHub and Jira with one click, and set up Google Calendar and Slack with guided links. Everything is saved to `~/.config/clearsky/.env`.

It is a single Node script with no dependencies. It runs on your machine, talks to GitHub, Jira and Slack with your own tokens, and keeps no data anywhere.

## Try it first

```sh
clearsky try          # or: node bin/clearsky.mjs try
```

This opens Clearsky with made-up data (a company called Acme, its PRs, tickets, meetings and a Copilot chat) on http://127.0.0.1:7790. It needs no logins. Nothing of yours is read or shown, so it's also the way to show Clearsky to others. **Leave demo** in its menu, or Ctrl+C, stops it and removes its data. Settings → General → **Try with demo data** starts the same demo from the page.

## Setup

The first time you open Clearsky it shows a **welcome page** (`/welcome`): what this machine has (Node, git, gh, acli, Copilot, the sandbox, a calendar), with the install command for your OS next to anything missing, buttons to log in to GitHub and Jira through their CLIs, and your work organizations picked from your gh login. `clearsky doctor` prints the same check in a terminal. No tokens are needed.

Requires Node 22+ and the [Atlassian CLI](https://developer.atlassian.com/cloud/acli/guides/install-acli/) (`acli`), logged in with `acli jira auth login --web`.

One command installs or updates everything:

```sh
git clone <this repository> clearsky && cd clearsky
sh scripts/install.sh            # add --service to start it at login (systemd user service)
```

It puts `clearsky` and Anthropic's sandbox runtime (`srt`, for Settings → Copilot → Sandbox) on your PATH with npm, uses nvm's Node 22 when that's how Node is installed, and makes `~/.config/clearsky` (readable only by you). It never uses sudo: system packages the sandbox needs (bubblewrap, socat, ripgrep) and missing CLIs (gh, acli, copilot) are listed with the command to install them. `--no-sandbox` leaves srt out. Then open http://127.0.0.1:7777/settings.

Tokens:

- **GitHub:** nothing, if you're logged in with the GitHub CLI (`gh auth login`); Clearsky then uses `gh auth token`. Otherwise a fine-grained token with read access to Pull requests, Issues, Contents and Metadata on your work org. A classic token with `repo` scope also works. If your org uses SSO, authorize the token for it.
- **Jira:** no token in Clearsky. All Jira calls go through `acli`, so it uses whatever account `acli jira auth` is logged in as.
- **Google Calendar (optional), either or both ways.** When both are set up, their meetings are merged, and if one fails the other still shows:
  - **GNOME Online Accounts:** add your work Google account under Settings → Online Accounts with Calendar switched on, and set `CALENDAR_EMAIL`. Clearsky reads the calendar Evolution syncs locally, from its SQLite cache via `node:sqlite`, so it needs no login of its own. To include more calendars (a family or personal one), add that Google account in Online Accounts with only Calendar on, then tick the calendar in Clearsky's Settings (saved as `EVOLUTION_CALENDARS`). On a shared calendar like "Family", events only take your free time when you organise or are invited to them, or when one of your names (`CALENDAR_MY_NAMES`, say `Alex`) is in the title; the rest show greyed in the agenda. Holiday and birthday calendars are never picked automatically.
  - **Today's schedule** under Now / Next shows the day as a timeline: meetings as blocks (overlaps on their own line), your free slot in green, the rest of the workday, and a line for now. Hover over a meeting for its details (time, place, organizer, link, description); click to keep them open. The calendar names below the timeline hide or show each one (saved as `CALENDAR_HIDDEN`); a hidden calendar doesn't take your time either.
  - Times are 24-hour unless you pick 12-hour under Settings → General (`CLEARSKY_TIME_FORMAT=12`).
  - **iCal link:** in Google Calendar, open Settings, pick your calendar, then **Integrate calendar**, and copy **Secret address in iCal format** into `GOOGLE_CALENDAR_ICS`. Several addresses can be given, separated by spaces. Workspace admins often turn this off.
- **Slack (optional):** a user token, see below. Without `SLACK_TOKEN` the Slack part is skipped.

### Slack token

1. Go to https://api.slack.com/apps, choose **Create New App**, then **From a manifest**, and pick your work workspace.
2. Paste this manifest and create the app:

   ```yaml
   display_information:
     name: Clearsky
   oauth_config:
     scopes:
       user:
         - search:read
   settings:
     org_deploy_enabled: false
     socket_mode_enabled: false
     token_rotation_enabled: false
   ```

3. Choose **Install to Workspace**. If your workspace requires admin approval for apps, this sends a request to the admins instead. The app has a single read-only scope and acts only as you.
4. Under **OAuth & Permissions**, copy the **User OAuth Token** (`xoxp-...`) into `SLACK_TOKEN`.

Clearsky searches for messages that @mention you, including in DMs and private channels you are in. It does not list every unread DM, because Slack's API has no cheap way to do that, and Slack itself already shows them.

The easiest way to set all of this up is the Settings page: run `clearsky serve` and open http://127.0.0.1:7777/settings. It runs `gh auth login --web` and `acli jira auth login --web` for you, and has a pre-filled link that creates the Slack app. Pasted tokens and URLs are written to `~/.config/clearsky/.env` (mode 600) and never shown back. The page only listens on 127.0.0.1, and changes need a per-run token, so other websites can't use it.

The config is read from `./.env`, then the repo's `.env`, then `~/.config/clearsky/.env`. Real environment variables override all of them.

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
- J/K move through the list, E marks the selected item done, H snoozes it, A opens the Copilot menu for it, O opens it on its site.
- **Done** (✓) hides an item until something new happens on it (a commit, review, comment or status change). Jira mentions are grouped per ticket, so marking one done hides the ticket until someone mentions you there again.
- **Snooze** (the clock) hides it for an hour, until tomorrow's stand-up, a week, or a date you pick, even if there's new activity. "Show N done, N snoozed" at the bottom of the list brings them back.
- **Calendar** in the menu has today as a schedule, and today and tomorrow as agendas; click a meeting for its details. The header of each list says when you're free until.
- Personal sources, such as School, each get a page under **Personal** in the menu.

Done and snoozed items are saved in `~/.config/clearsky/state.json`, so the plan respects them too.

"Has feedback" on your PR means someone commented after your latest commit; once you push, the PR shows as waiting for review.

The server also answers JSON on 127.0.0.1: `/api/source/<github|jira|jiraMentions|slack|calendar>`, `/api/plan`, `/api/work` (everything), `/api/standup`, `/api/issue/<KEY>`, `/api/pr?repo=<org/repo>&number=<n>` `/api/dismissed`, `/api/copilot/sessions` and `/api/copilot/sessions/<id>`. Add `?refresh=1` to skip the cache.

## Adding a source

Besides the built-in sources, Clearsky loads extra ones, one module each, from `lib/sources/*.mjs` in this repo and from `~/.config/clearsky/sources/*.mjs` (for private ones, like a school or family app). A source declares its settings (they show up under **Other sources** in Settings and are saved to `.env`), a `fetch(ctx)`, and any of these hooks: `items` (rows for its page in the menu; a work source's `needs` rows also show under Work), `attention` (notifies when something new turns up), `events` (joins Now / Next; mark `fyi: true` to show without blocking your time) and `standup` (lines for Yesterday and Today). `ctx` gives the source its settings and helpers to fetch JSON or run a CLI. See the comment at the top of [lib/sources.mjs](lib/sources.mjs) for the contract and [test/sources/school.mjs](test/sources/school.mjs) for a complete example. Files that others can write to are skipped.

Work and personal stay apart: a source sets `area: 'work'` to sit with GitHub, Jira and Slack on the **Work** tab, or leaves it out to land on the **Personal** tab (school, training and the like). Only the calendar mixes the two: personal events show in the day schedule on both tabs.

## Its own window

`clearsky app` opens Clearsky in a window of its own (Chromium's app mode: no tabs or address bar, its own taskbar icon), starting the server first if it isn't running. The installer adds it to your app menu as **Clearsky**. It uses your normal browser profile, so links to GitHub and Jira open logged in. Any Chromium-based browser works (`CLEARSKY_BROWSER` picks one). The server is unchanged, so a browser tab still works too.

## School (Visma Flyt Skole)

If your children's school uses Visma Flyt Skole (Min Skole / Flyt Foresatt), Clearsky shows what waits for you there: unread messages and notices, and forms and consents to answer. Form deadlines show up in Now / Next. It only reads. It never replies or marks anything as read, so the portal still shows everything as unread.

1. In Settings, under **Other sources**, set **School portal key**: the last part of `https://foresatt.visma.no/<key>`.
2. Click **Log in with BankID**. A Chrome or Chromium window opens. Log in with BankID or MinID, and the window closes by itself once you're in. Set `CLEARSKY_BROWSER` if your browser isn't found.

**Weekly plans in the calendar.** The weekly plans the school sends as PDF or Word files become events on a calendar of their own, **School**, inside Clearsky: trips and theme days at the times the plan gives, when school ends each day, homework on the day it's due, and SFO activities. What's the same every day (frilek, lunsj, storefri) is left out. It's read by script, no AI: a plan laid out as a table with the weekdays as columns works; a plan written as prose gives nothing. Each file is read once and what came out of it is kept in `~/.config/clearsky/school-events.json` (mode 600). The events show in the day schedule without taking your time, and each opens the message it came from. Turn it off, or rename the calendar, in Settings (**Weekly plans in the calendar**, **Calendar for weekly plans**). PDFs need `pdftotext` (poppler-utils).

The login is kept in the GNOME keyring (`secret-tool`), or in `~/.config/clearsky/flyt-session.json` (mode 600) if there's no keyring. Clearsky renews the login itself. When Visma ends the login, the School panel links you to Settings to log in again.

There is no public API. This uses the one the portal itself uses, as documented by [skolectl](https://github.com/langtind/skolectl), so it can break when Visma changes the portal.

## Getting things done

Each row says whose move it is. Copilot's PR reviewer bot doesn't count as a reviewer: its comments show as a note ("Copilot left 3 suggestions") and never make a PR your move. Review threads you answered last, and outdated ones, aren't yours either. A PR nobody has been asked to review says **No reviewer yet**; open it and use **Request review** to pick people (GitHub's suggestions first, with who is already asked or has reviewed marked). Jira tickets in review, QA, testing or blocked statuses sit under Waiting on others. **Done** hides an item until something new happens on it, such as a person reviewing or its state changing, not a bot comment or your own push. What you did from Clearsky shows on the item ("You: Asked anna to review, 5 min ago"). The ↻ next to the page title shows how fresh the data is and refreshes everything; merged PRs drop out even before GitHub's search catches up.

PRs and tickets link to each other: a PR shows the Jira tickets in its title or branch (even ones that aren't yours) and the GitHub issues it closes, and a ticket shows its PRs with their state. Click one to open it in Clearsky. **Your PRs** and **Tickets** are tables with the branch too: a PR's head branch, and for a ticket, its PRs' branches plus any local or pushed branch in your clones under `~/dev` (or `CLEARSKY_CODE_DIRS`) with the key in its name. Drag a column header's edge to resize it, and use **Columns** to hide one; that's kept in the browser.

**Read by you.** Your PRs say whether you've read the code in them that you didn't write yourself: commits by Copilot (its Co-authored-by line, or pushed by a Clearsky chat), Copilot's coding agent, Claude or a colleague. **Mark read** remembers the commit you read up to; new commits after it show as "2 new", with a link to just those changes. PRs with unread code come first under **Not read by you**, and the ones reviewers are already on (or approved) move to **Needs you** in Work. Asking for review on one you haven't read asks you first. In Settings, **Your PRs: Everywhere** also includes PRs you opened outside the work organizations; PRs Copilot's coding agent opened for you are included either way.

## Running it

`clearsky restart` asks the running server to restart once no Copilot chat is working or waiting for your OK, so updating never cuts a turn off; idle chats carry on afterwards. To start Clearsky at login and keep it running, `contrib/clearsky.service` is a systemd user service (instructions inside); it sets `CLEARSKY_SUPERVISED=1`, so a restart hands over to systemd. Starts, restarts (with how they were asked for and how many chats were busy), stops and unexpected errors are logged to `~/.cache/clearsky/clearsky.log` (`CLEARSKY_LOG` for another file).

### In Docker

`clearsky docker up` (that is, `node bin/clearsky.mjs docker up`) builds and starts Clearsky in a Linux container, on http://127.0.0.1:7777. It takes everything from the same settings as natively: the folders under Settings → Copilot → "Folders Copilot may use" (and the general-chat folder) are mounted at the same paths, so they are also the container's fence. Tool folders you have are mounted alongside: Clearsky's and Copilot's, `~/.gitconfig`, JDKs, `~/.m2`, `~/.gradle`, `~/.sdkman` and GNOME's calendar caches. `clearsky docker mounts` lists them. After changing the folders in Settings, run `clearsky docker up` again to mount them; Settings points out a folder the container doesn't have. Also: `clearsky docker down`, `clearsky docker logs`. Anything extra goes in `docker-compose.override.yml`. On Windows, run it from WSL: paths are mounted as they are.

A container has no keyring, and acli can only keep its login in one, so Clearsky's container runs a keyring of its own, kept in `~/.config/clearsky/container/` (yours only). Log in once after the first start: `clearsky docker login` brings over the logins this machine already has: gh's, which Copilot uses too. acli's login can't be copied, so acli logs in through your browser as usual: its login calls back to a port on 127.0.0.1, so that runs in a one-off container on this machine's network while Clearsky pauses, and it prints the link to open. Anything else it can't bring over is done in the browser too. Your machine's own keyring and logins aren't used or changed.

Online Accounts calendars are found from `~/.config/clearsky/eds-sources.json`, which Clearsky writes whenever it runs natively. The school login (BankID) needs a browser, so log in natively and then hand it over with `node bin/clearsky.mjs school-handover` before starting the container; it moves the login from your keyring into the container's. Desktop notifications aren't available in the container. Updating: `git pull`, then `clearsky docker up` (Restart alone doesn't load new code into the image).

`npm test` includes a browser check of every view when Playwright is installed, and skips it otherwise.

## Notifications

While `clearsky serve` runs, it checks GitHub, Jira mentions and Slack every 3 minutes (Settings → General, or `CLEARSKY_POLL_MINUTES`), and GitHub again when you come back to the window and it is over a minute old. When something new needs you (a review request, a PR turning to your move, a mention), you get a desktop notification with an **Open** button on workdays from 07:00 until two hours after your workday ends. Dismissed and muted items stay quiet. Banners go straight to the desktop over D-Bus (`gdbus`), because Ubuntu's AppArmor profile for `notify-send` blocks the click on **Open**; a newer banner for the same item replaces the old one. Without D-Bus it falls back to `notify-send` (`CLEARSKY_NOTIFY=notify-send` forces it), and without either, the bell at the bottom of the menu turns on browser notifications instead. `CLEARSKY_NOTIFY=off` turns them off. New things also get a dot in the page and a count in the tab title until you've looked. A review request notifies when it's (re-)requested, not on every push or comment; a GitHub thread you were mentioned in notifies once; a status that flips back and forth notifies once; more than two at a time become one banner. **Notifications** in the menu lists the last 100 sent (kept across restarts), with links, to see why something came.

## Copilot chat

**✦ Copilot** in the top bar opens a chat with the GitHub Copilot CLI on your machine (`copilot`, logged in with your work account). The first message includes what's on your dashboard, so you can ask things like "what should I do first?". Answers link Jira keys and PRs with hover cards.

**Settings → Copilot** sets what a new chat starts with: model, reasoning effort, access mode, the folder for general chats, and the folders Copilot may use. In the panel you can pick the model and reasoning effort, how much Copilot may do: **Ask** (Allow/Deny buttons for each step), **Sandboxed** (Copilot runs in Anthropic's sandbox runtime and everything inside runs; it asks only at the sandbox's doors out, see below), **Full** (Clearsky says yes to anything Copilot still asks; denied patterns stay denied), Read only, or Plan only, and click a skill to use it. Every mode runs Copilot in its Agent Client Protocol mode, so whenever Copilot wants your OK, even in Full, you get Allow/Deny buttons instead of a refusal, and long builds aren't cut off. Copilot runs in the Clearsky folder (or `COPILOT_CWD`), so the skills below are available. A chat about a PR or ticket starts in that repo's clone, or the worktree with the PR's branch. Copilot may use files under **Settings → Copilot → Folders Copilot can change** (default `~/dev`, passed as `--add-dir`) without the "Access paths outside trusted directories" question. If `copilot` isn't on your PATH, Clearsky looks under nvm, or set `COPILOT_BIN`. Clearsky's own tokens are not passed to it.

**The sandbox and its doors.** Clearsky doesn't try to judge shell commands: srt, which Clearsky runs as a library, keeps Copilot to your folders and the allowed hosts. Your GitHub login never enters the sandbox: Copilot, git and gh inside get stand-ins, and srt's proxy adds your `gh` login on the way to GitHub. The proxy also decides what reaches GitHub (`lib/github-gate.mjs`): reading goes through, while a push, an API write or a GraphQL mutation waits until you click Allow in the chat, however the command was written. Copilot's built-in GitHub tools are off in the sandbox. Two more doors are small commands in `scripts/sandbox-bin` that hand work to Clearsky over a private socket (`lib/broker.mjs`): `acli` (Jira's login is in the keyring; reads run at once, changes ask) and `outside <command>` for anything that can't run inside, like tests that start Docker containers. Settings → Copilot → Never ask before lists Jira and `outside` commands that go through without asking. `review --ticket <KEY>` (or `--goal "…"`) gets a proper review of the chat's change before it opens a PR: Clearsky works out the diff and reads the ticket itself, and a fresh Copilot session in its own sandbox, which can only read the repo, reviews it knowing nothing but the goal and the code (`lib/review.mjs`). It answers with findings and `VERDICT: ready` or `VERDICT: fix first`; `COPILOT_REVIEW_MODEL` picks its model.

**＋ PR or ticket** attaches pull requests and Jira tickets to your next message: pick from what's on your dashboard, or paste a key (ABC-1234), `org/repo#12` or a link. Clearsky adds their details (description, status, files and reviews, latest comments) in front of your message, so you don't have to explain what you mean. The ✦ on any PR or ticket row asks about it, or runs one of your skills on it, in a new chat with that item attached.

Type **/** in the message box for skills and every slash command your Copilot offers (`/review`, `/plan`, `/compact`…), plus `/new`, `/history` and `/ref` for the chat.

A chat uses the whole work area, with what it's about (linked PRs and tickets, folder, status), your skills and its settings on the right. The menu has Settings and a Light / Dark / Auto theme switch (saved per device); on a phone it folds away behind ☰. In Chrome, 🎤 next to Send lets you talk instead of typing; the browser sends the audio to Google to turn it into text, and nothing is sent to Copilot until you press Send.

**Copilot** in the menu lists the chats that are working or waiting on you, plus the ones you used lately here, each with a status dot. Click one, or press Alt+1…9, to switch; Alt+N starts a new chat. Switching (or reloading the page) doesn't stop a chat: it carries on in the background, and when you come back you see any question it's waiting on and follow it to the end. **Stop** ends a turn on purpose.

**History** lists your Copilot sessions as Copilot itself knows them, whether you started them here, in a terminal or in your editor, with ones open elsewhere marked. Click one to see the conversation and carry on with it. The chat you had open comes back after a page reload. Click a chat's title to rename it (the name is kept in Clearsky). A chat you start with ✦ on a ticket, PR or GitHub issue is named after it ("ABC-6519 · Fix capture timeout") in Clearsky. A PR, the Jira key in its title or branch, and the GitHub issues it closes count as one piece of work, so ✦ on any of them offers **Continue** on it before a new chat. A message you send while Copilot is still working waits and goes when the turn ends; Enter on an empty box, or **Stop**, stops the turn.

Sessions show up next to the PR or ticket they are about: one you started from that row or attached it to, one running in a checkout of the PR's branch, or one with the PR or ticket key in its title or branch. A dot shows if it is working (green), waiting for you (blue) or needs your OK (amber), and a click reopens it; the ✦ menu also offers **↩ Continue**. Any session that is working or waiting, linked or not, is listed under **Copilot now** at the top of Work, and one waiting for you counts in its number.

## Copilot skills

`.github/skills/` contains these skills for GitHub Copilot (agent mode in VS Code and the Copilot CLI):

- **triage-my-work:** runs `clearsky --json` and sorts everything into Do now / Today / Later / Waiting on others.
- **review-my-queue:** goes through your review requests, smallest and re-reviews first, and drafts review notes. It never submits a review unless you tell it to.
- **continue-work:** checks a PR or ticket (CI, conflicts, unresolved review comments, what the ticket still asks for), then carries on with what's left after asking once. It never merges, approves, force-pushes or posts comments without asking. From ✦ on a PR in Clearsky, the chat runs in your local clone of that repository (found under `~/dev`, or `CLEARSKY_CODE_DIRS`).

- **write-like-me:** anything posted as you (review comments, replies, PR descriptions, Jira comments, Slack) in your own voice: short, to the point, no filler. It reads your voice profile, `~/.copilot/voice.md`, if you have one: how you write, with samples of your own comments. That file stays on your machine; Copilot can write it for you from your recent GitHub and Jira comments.

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
