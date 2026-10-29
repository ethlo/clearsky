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
  - **GNOME Online Accounts:** add your work Google account under Settings → Online Accounts with Calendar switched on, and set `CALENDAR_EMAIL`. Clearsky reads the calendar Evolution syncs locally, from its SQLite cache via `node:sqlite`, so it needs no login of its own. Use `EVOLUTION_CALENDARS` to pick other calendars by name.
  - **iCal link:** in Google Calendar, open Settings, pick your calendar, then **Integrate calendar**, and copy **Secret address in iCal format** into `GOOGLE_CALENDAR_ICS`. Workspace admins often turn this off.
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

On the page, the ↻ on each panel reloads just that panel (Shift-click reloads everything), and ✕ hides an item until it changes, for example when a new commit or comment arrives.

The server also answers JSON on 127.0.0.1: `/api/source/<github|jira|jiraMentions|slack|calendar>`, `/api/plan`, `/api/work` (everything), `/api/standup`, `/api/issue/<KEY>` and `/api/pr?repo=<org/repo>&number=<n>`. Add `?refresh=1` to skip the cache.

## Copilot skills

`.github/skills/` contains two skills for GitHub Copilot (agent mode in VS Code and the Copilot CLI):

- **triage-my-work:** runs `clearsky --json` and sorts everything into Do now / Today / Later / Waiting on others.
- **review-my-queue:** goes through your review requests, smallest and re-reviews first, and drafts review notes. It never submits a review unless you tell it to.

Inside this repo Copilot picks them up automatically. To have them in every repo, copy them to your personal skills folder:

```sh
mkdir -p ~/.copilot/skills && cp -r .github/skills/* ~/.copilot/skills/
```

Then ask Copilot "triage my work" or "review my queue".

## Notes

- **Now / Next** treats back-to-back meetings (under 5 minutes apart) as one busy block and counts free time until the next meeting or `CLEARSKY_WORKDAY_END`. It then picks tasks in this order: PRs ready to merge, fresh Slack and Jira mentions, reviews (re-reviews and small ones first), your blocked PRs, and in-progress Jira work. A task is picked only if its rough time estimate fits.
- Jira data comes from `acli jira workitem search --json` and `acli jira workitem view <KEY> --fields comment --json`. `comment list` is not used, because it flattens comments to plain text and drops @mentions. Each candidate issue costs one `acli` call, run 4 at a time, and at most 40 issues are checked.
- Jira mentions are found with `comment ~ currentUser()` over the last 14 days. Each match is then confirmed by finding your account id in a mention in the comment's rich text. Mentions stay listed for the whole window; Jira's "seen" state isn't available. You can override the search with `JIRA_MENTIONS_JQL`.
- The server listens on 127.0.0.1 only and caches results for 2 minutes. Use the Refresh button to force a fetch.
- `npm test` runs the tests against a mocked GitHub and Slack, plus a fake `acli`.
