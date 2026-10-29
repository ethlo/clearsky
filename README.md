# Clearsky

One page that shows what needs your attention at work:

- **Now / Next:** your current or next meeting, how much free time you have until it, and up to three tasks that fit that gap (optional, from Google Calendar).
- **Needs my review:** open PRs where your review is requested, oldest request first, with re-reviews flagged.
- **My PRs:** each open PR shows who has the ball (changes requested, CI failing, merge conflict, unresolved threads, ready to merge) or who you are waiting on.
- **Mentions:** GitHub issues and PRs that mention you, Jira comments that @mention you, and (optionally) Slack messages that @mention you, from the last 14 days.
- **What I have left:** your open Jira issues (in progress, then to do), plus GitHub issues assigned to you.
- **Stand-up tab:** a ready-to-paste Yesterday / Today / Blockers summary for your next daily stand-up (`CLEARSKY_STANDUP_TIME`, default 09:45, on `CLEARSKY_WORKDAYS`, default Mon-Fri). It covers everything since the previous stand-up, so on Monday that's since Friday's: PRs merged, opened and reviewed, commits, and Jira issues you finished or worked on. Today comes from the dashboard queue and your meetings. The dashboard reminds you 30 minutes before, and the stand-up counts as a meeting in Now / Next.
- **Loads as it goes:** each source (GitHub, Jira, Jira mentions, Slack, calendar) loads on its own, so the page shows whatever is ready first.
- **Hover cards:** hover a Jira key like `SSP-1234` or a PR like `org/repo#12` on the Stand-up tab to see its title, status and summary, with a link to the full item.
- **Settings page** (`/settings`): log in to GitHub and Jira with one click, and set up Google Calendar and Slack with guided links. Everything is saved to `~/.config/clearsky/.env`.

It is a single Node script with no dependencies. It runs on your machine, talks to GitHub, Jira and Slack with your own tokens, and keeps no data anywhere.

## Setup

Requires Node 22+ and the [Atlassian CLI](https://developer.atlassian.com/cloud/acli/guides/install-acli/) (`acli`), logged in with `acli jira auth login --web`.

```sh
git clone <this repo> && cd clearsky
npm link                       # puts `clearsky` on your PATH
mkdir -p ~/.config/clearsky
cp .env.example ~/.config/clearsky/.env   # then fill it in
```

Tokens:

- **GitHub:** nothing, if you're logged in with the GitHub CLI (`gh auth login`); Clearsky then uses `gh auth token`. Otherwise a fine-grained token with read access to Pull requests, Issues, Contents and Metadata on your work org. A classic token with `repo` scope also works. If your org uses SSO, authorize the token for it.
- **Jira:** no token in Clearsky. All Jira calls go through `acli`, so it uses whatever account `acli jira auth` is logged in as.
- **Google Calendar (optional), either or both ways.** When both are set up, their meetings are merged, and if one fails the other still shows:
  - **GNOME Online Accounts:** add your work Google account under Settings → Online Accounts with Calendar switched on, and set `CALENDAR_EMAIL`. Clearsky reads the calendar Evolution syncs locally, from its SQLite cache via `node:sqlite`, so it needs no login of its own. To include more calendars (a family or personal one), add that Google account in Online Accounts with only Calendar on, then tick the calendar in Clearsky's Settings (saved as `EVOLUTION_CALENDARS`). On a shared calendar like "Family", events only take your free time when you organise or are invited to them, or when one of your names (`CALENDAR_MY_NAMES`, say `Morten`) is in the title; the rest show greyed in the agenda. Holiday and birthday calendars are never picked automatically.
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
clearsky              # Markdown summary in the terminal
clearsky --json       # everything as JSON, for scripts and Copilot
clearsky standup      # stand-up summary (add --json for the data)
clearsky jira-debug   # raw acli output, if Jira data looks wrong
```

On the page:
- ↻ on a panel reloads just that panel (Shift-click reloads everything).
- ✕ dismisses an item until something new happens on it (a commit, review, comment or status change). Jira mentions are grouped per ticket, so dismissing one hides the ticket until someone mentions you there again.
- ✓ on a "Do next" task marks it done: it stays hidden until something new happens on it, and "Show N done" lists when you did it (with Undo).
- The clock on a "Do next" task mutes it for an hour, until tomorrow's stand-up, a week, or a date you pick, even if there's new activity.

Dismissed and muted items are saved in `~/.config/clearsky/state.json`, so the plan respects them too.

"Has feedback" on your PR means someone commented after your latest commit; once you push, the PR shows as waiting for review.

The server also answers JSON on 127.0.0.1: `/api/source/<github|jira|jiraMentions|slack|calendar>`, `/api/plan`, `/api/work` (everything), `/api/standup`, `/api/issue/<KEY>`, `/api/pr?repo=<org/repo>&number=<n>` `/api/dismissed`, `/api/copilot/sessions` and `/api/copilot/sessions/<id>`. Add `?refresh=1` to skip the cache.

## Adding a source

Besides the built-in sources, Clearsky loads extra ones, one module each, from `lib/sources/*.mjs` in this repo and from `~/.config/clearsky/sources/*.mjs` (for private ones, like a school or family app). A source declares its settings (they show up under **Other sources** in Settings and are saved to `.env`), a `fetch(ctx)`, and any of these hooks: `items` (rows for its panel, under Needs you or Keeping track), `attention` (notifies when something new turns up), `events` (joins Now / Next; mark `fyi: true` to show without blocking your time) and `standup` (lines for Yesterday and Today). `ctx` gives the source its settings and helpers to fetch JSON or run a CLI. See the comment at the top of [lib/sources.mjs](lib/sources.mjs) for the contract and [test/sources/school.mjs](test/sources/school.mjs) for a complete example. Files that others can write to are skipped.

Work and personal stay apart: a source sets `area: 'work'` to sit with GitHub, Jira and Slack on the **Work** tab, or leaves it out to land on the **Personal** tab (school, training and the like). Only the calendar mixes the two: personal events show in the day schedule on both tabs.

## School (Visma Flyt Skole)

If your children's school uses Visma Flyt Skole (Min Skole / Flyt Foresatt), Clearsky shows what waits for you there: unread messages and notices, and forms and consents to answer. Form deadlines show up in Now / Next. It only reads. It never replies or marks anything as read, so the portal still shows everything as unread.

1. In Settings, under **Other sources**, set **School portal key**: the last part of `https://foresatt.visma.no/<key>`.
2. Click **Log in with BankID**. A Chrome or Chromium window opens. Log in with BankID or MinID, and the window closes by itself once you're in. Set `CLEARSKY_BROWSER` if your browser isn't found.

The login is kept in the GNOME keyring (`secret-tool`), or in `~/.config/clearsky/flyt-session.json` (mode 600) if there's no keyring. Clearsky renews the login itself. When Visma ends the login, the School panel links you to Settings to log in again.

There is no public API. This uses the one the portal itself uses, as documented by [skolectl](https://github.com/langtind/skolectl), so it can break when Visma changes the portal.

## Notifications

While `clearsky serve` runs, it checks GitHub, Jira mentions and Slack every 3 minutes (`CLEARSKY_POLL_MINUTES`). When something new needs you (a review request, a PR turning to your move, a mention), you get a desktop notification with an **Open** button on workdays from 07:00 until two hours after your workday ends. Dismissed and muted items stay quiet. Banners go straight to the desktop over D-Bus (`gdbus`), because Ubuntu's AppArmor profile for `notify-send` blocks the click on **Open**; a newer banner for the same item replaces the old one. Without D-Bus it falls back to `notify-send` (`CLEARSKY_NOTIFY=notify-send` forces it), and without either, the bell in the top bar turns on browser notifications instead. `CLEARSKY_NOTIFY=off` turns them off. New things also get a dot in the page and a count in the tab title until you've looked. A review request notifies when it's (re-)requested, not on every push or comment; a GitHub thread you were mentioned in notifies once; a status that flips back and forth notifies once; more than two at a time become one banner. `GET /api/notifications/log` lists the last 100 sent, to see why something came.

## Copilot chat

**✦ Copilot** in the top bar opens a chat with the GitHub Copilot CLI on your machine (`copilot`, logged in with your work account). The first message includes what's on your dashboard, so you can ask things like "what should I do first?". Answers link Jira keys and PRs with hover cards.

In the panel you can pick the model and reasoning effort, how much Copilot may do: **Ask** (Allow/Deny buttons for each step, using Copilot's Agent Client Protocol mode), **Assisted** (Copilot's safety judge approves steps), **Full**, Read only, or Plan only, extra allowed or denied tool patterns, and click a skill to use it. Copilot runs in the Clearsky folder (or `COPILOT_CWD`), so the skills below are available. If `copilot` isn't on your PATH, Clearsky looks under nvm, or set `COPILOT_BIN`. Clearsky's own tokens are not passed to it.

**＋ PR or ticket** attaches pull requests and Jira tickets to your next message: pick from what's on your dashboard, or paste a key (SSP-1234), `org/repo#12` or a link. Clearsky adds their details (description, status, files and reviews, latest comments) in front of your message, so you don't have to explain what you mean. The ✦ on any PR or ticket row (and in Do next) asks about it, or runs one of your skills on it, in a new chat with that item attached.

Type **/** in the message box for skills and, in Ask mode, every slash command your Copilot offers (`/review`, `/plan`, `/compact`…), plus `/new`, `/history` and `/ref` for the panel.

The ☰ menu at the top left has the tabs, Copilot and Settings, and a Light / Dark / Auto theme switch (saved per device). On a wide screen Copilot sits beside the page; on a phone it fills the screen. In Chrome, 🎤 next to Send lets you talk instead of typing; the browser sends the audio to Google to turn it into text, and nothing is sent to Copilot until you press Send.

Tabs along the top of the panel hold the chats that are working or waiting on you, plus the ones you used lately here, each with a status dot. Click one, or press Alt+1…9, to switch; Alt+N starts a new chat. Switching (or reloading the page) doesn't stop a chat: it carries on in the background, and when you come back you see any question it's waiting on and follow it to the end. **Stop** ends a turn on purpose.

**History** lists your Copilot sessions as Copilot itself knows them, whether you started them here, in a terminal or in your editor, with ones open elsewhere marked. Click one to see the conversation and carry on with it. The chat you had open comes back after a page reload.

Sessions show up next to the PR or ticket they are about: one you started from that row or attached it to, one running in a checkout of the PR's branch, or one with the PR or ticket key in its title or branch. A dot shows if it is working (green), waiting for you (blue) or needs your OK (amber), and a click reopens it; the ✦ menu also offers **↩ Continue**. Any session that is working or waiting, linked or not, is listed in the **Copilot sessions** card under Needs you, and counted in the summary line.

## Copilot skills

`.github/skills/` contains these skills for GitHub Copilot (agent mode in VS Code and the Copilot CLI):

- **triage-my-work:** runs `clearsky --json` and sorts everything into Do now / Today / Later / Waiting on others.
- **review-my-queue:** goes through your review requests, smallest and re-reviews first, and drafts review notes. It never submits a review unless you tell it to.
- **continue-work:** checks a PR or ticket (CI, conflicts, unresolved review comments, what the ticket still asks for), then carries on with what's left after asking once. It never merges, approves, force-pushes or posts comments without asking. From ✦ on a PR in Clearsky, the chat runs in your local clone of that repository (found under `~/dev`, or `CLEARSKY_CODE_DIRS`).

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
