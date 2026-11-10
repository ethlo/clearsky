# Plugins

Clearsky ships as a core (GitHub, Jira, calendars, Copilot, links) and everything else is a plugin you add. A plugin is a plain folder: a `clearsky-plugin.json` that says what it is and what it reaches, and one ES module that does the work. There's no build step and nothing to `npm install`; a plugin has no dependencies, like Clearsky itself. These have a repo of their own and are in Clearsky's catalog (`plugins/catalog.json`): Slack (MCP), Confluence, Grafana and Visma Flyt Skole. `clearsky add slack-mcp` adds one from its repo, at the version the catalog pins.

## Adding one

```sh
clearsky add github:someone/clearsky-weather      # a GitHub repo; also gitlab: and codeberg:
clearsky add github:someone/plugins/weather#v1.2  # a folder in a repo, at a tag, branch or commit
clearsky add https://git.example.com/me/plug.git  # any git repo, fetched with your own git login
clearsky add npm:clearsky-weather@1.2.0           # an npm package
clearsky add ./my-plugin                          # a folder here
clearsky add visma-flyt                               # one from the catalog: its repo, at the pinned tag
```

Settings → Plugins does the same: paste where it comes from, **Look at it**, then **Add**. Either way Clearsky first fetches it and shows its manifest (hosts, programs, files, settings, and whether it runs in the sandbox), and nothing of the plugin has run yet: a git clone brings no hooks, and npm packages are fetched with `--ignore-scripts`. What you add is what you looked at. Clearsky loads plugins when it starts, so restart after adding one (Settings has the button).

Settings → Plugins lists every plugin the same way, Clearsky's own GitHub, Jira, Calendar and Links included. Each has a page with how it's doing, its logins and settings, and what it holds and reaches.

`clearsky plugins` lists what's added and what the catalog has, `clearsky update [name]` fetches again from where it came from, and `clearsky remove name` takes it out (`--data` also removes what it kept).

A private repo on github.com works with your gh login: while fetching, git asks `gh auth git-credential` for it. Nothing is stored and there's no token to make. Other hosts use whatever login your git has.

## Versions

Where you add a plugin from says which version you get:

| You add | You get | Update |
|---|---|---|
| `github:someone/clearsky-weather` | the newest commit on its default branch | takes the new commits |
| `github:someone/clearsky-weather#v1.2.0` | that tag | fetches v1.2.0 again; it stays there |
| `github:someone/clearsky-weather#<commit>` | that commit | stays there |
| `npm:clearsky-weather@1.2.0` | that version | stays there |
| `npm:clearsky-weather` | npm's latest | takes a newer one |

`clearsky update --check` (or **Check for updates** on its page in Settings) looks at the repo's tags and branch without fetching any code, and lists newer version tags. `clearsky update weather --to v1.3.0` moves it to one, and `--to ''` goes back to following the branch. In Settings each newer tag gets a **Look at** button.

Every update is shown before it's taken. If the new version reaches anything the old one didn't (a host, a program, a file, a door, a secret setting, or running outside the sandbox), Settings shows it and the terminal asks. A tag that comes back as different code from when you added it is called out, since a published tag shouldn't move. `~/.config/clearsky/plugins.json` records each plugin's source, commit and a hash of its files, so it doubles as your lock file: a plugin whose files changed is not loaded.

## Where things live

| What | Where |
|---|---|
| The list of what you added, and how each runs | `~/.config/clearsky/plugins.json` |
| A plugin's code (read only to it) | `~/.local/share/clearsky/plugins/<name>/code` |
| What it keeps | `~/.local/share/clearsky/plugins/<name>/data` |
| Its settings | `~/.config/clearsky/.env`, like every other setting |

## The sandbox

A plugin you add runs in a sandbox of its own. Each fetch, and each time you open one of its items, is a new process under srt (the same sandbox runtime as Copilot's, bubblewrap on Linux and sandbox-exec on macOS) with only that plugin's rules:

- **Network**: only the hosts in its manifest, through srt's proxy. A plugin that lists none has no network.
- **Files**: it reads its own code, its data folder and system files outside your home. The rest of your home is out of sight: your code, `~/.ssh`, browser profiles, `~/.config/clearsky`. It writes only its data folder.
- **Settings and logins**: it gets its own settings and nothing else. Clearsky starts it with an empty environment, so no token of Clearsky's or yours gets in.
- **Code**: Clearsky never imports it. The hooks that turn its data into rows, reminders, events and stand-up lines run in the sandbox right after `fetch()`, and their output comes back as data.

Its files are hashed when it's added, and git plugins are pinned to the commit. If the files change after that, the plugin isn't loaded until you run `clearsky update` or add it again. Without srt installed, sandboxed plugins don't run at all, and Settings and `clearsky plugins` say so.

Some plugins can't work like that. School opens a browser for a BankID login and keeps the session in your keyring; Grafana holds your Grafana logins for Copilot chats that mustn't see them. Such a plugin says why in `outside`, and it runs inside Clearsky, as you. Clearsky adds one from elsewhere only when you say you trust it (`--trust`, or the box in Settings). The plugins in `plugins/` are part of Clearsky, reviewed with it, and run inside.

## Writing one

```
clearsky-weather/
  clearsky-plugin.json
  source.mjs
  package.json        (only to publish on npm)
```

`clearsky-plugin.json`:

```json
{
  "name": "weather",
  "label": "Weather",
  "version": "1.0.0",
  "description": "Rain on your bike days.",
  "clearsky": 1,
  "entry": "source.mjs",
  "area": "personal",
  "panel": { "title": "Weather", "zone": "track" },
  "settings": {
    "WEATHER_PLACE": { "label": "Place", "hint": "Latitude,longitude", "secret": false }
  },
  "enabledWhen": ["WEATHER_PLACE"],
  "hosts": ["api.met.no"],
  "clis": [],
  "secrets": [],
  "files": []
}
```

| Field | What it's for |
|---|---|
| `name` | Its id: 2 to 31 lowercase letters, digits and `-`. It can't be one of Clearsky's own sources. |
| `clearsky` | The plugin API it's written for. This Clearsky has 1, and refuses a plugin for a newer one. |
| `entry` | Its module, inside the folder. |
| `area` | `work` or `personal` (default): which tab its page is on. |
| `panel` | Its page: `title`, `zone` (`needs` puts its rows with what needs you, `track` keeps them on its page), `view: "table"` for an inbox, and `page: false` for a `needs` plugin whose rows need no page of their own (Slack's are in Mentions). |
| `settings` | Fields on its page under Settings → Plugins, saved to `.env`. Only these reach the plugin. `"team": true` lets a [team pack](team-pack.md) set one (never a secret). A field can have a `pattern` (a regular expression Settings checks) with a `patternHint`, a `link` (`{ "label", "url" }`) to where you get the value, and a `type`: `"list"` or `"map"` get a row per item (a map's rows are a name and a value), saved as `a, b` and `a=x, b=y`. `item` and `valueItem` are examples shown in an empty row, and `empty` says what an empty list means. |
| `enabledWhen` | Settings that must be filled in before Clearsky fetches anything. |
| `hosts` | All it may reach. `*.example.com` covers the subdomains. |
| `clis` | Programs it may run through `ctx.run`. |
| `secrets`, `files`, `note` | What it keeps, shown on its page under Settings → Plugins. |
| `outside` | Only if it can't work in the sandbox: why, in words. |
| `doors` | Commands it offers Copilot chats, `[{ "name": "grafana", "about": "…" }]`. Only with `outside`. |

The manifest wins over the code: what it reaches and holds is what you were shown.

`source.mjs` exports the hooks (the full contract is at the top of `lib/sources.mjs`):

```js
export default {
  async fetch(ctx) {
    const [lat, lon] = ctx.env.WEATHER_PLACE.split(',');
    const f = await ctx.json(`https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${lat}&lon=${lon}`);
    return { rain: f.properties.timeseries.slice(0, 12).some((t) => t.data.next_1_hours?.details?.precipitation_amount > 0) };
  },
  items: (d) => [{ key: 'today', title: d.rain ? 'Rain before noon' : 'Dry morning' }],
  attention: (d) => (d.rain ? [{ key: 'rain', title: 'Take the bus' }] : []),
  events: () => [],
  standup: () => null,
};
```

Besides `fetch`, a plugin can have:

| Hook | What it does |
|---|---|
| `items(data)` | Rows for its page (or for what needs you, with `zone: "needs"`). A row can be a mention (`kind: "mention"`, counted in Mentions), with Reply as its action (`next: "reply"`), a line saying why (`why`), its link's label (`open`) and the PR or ticket it's about (`ref: "pr:org/repo#1"` or `"issue:KEY-1"`). |
| `attention(data)` | What notifies you when it's new. A plugin you just added starts quiet, so you don't get a burst of old ones. |
| `events(data)` | Calendar entries; `fyi: true` ones show but don't take your time. |
| `standup(data, since)` | Lines for Yesterday and Today. |
| `plan(data)` | Work plugins: tasks Now / Next can pick for a free slot, `{ key, title, detail, url, why, minutes }`. Slack's: answer a fresh mention. |
| `markdown(data)` | Work plugins: their part of `clearsky --md`, `{ title, lines }`. |
| `detail`, `attachment` | Read an item in full inside Clearsky, with its files. |
| `login`, `logins` | A login started from Settings, or several with a button each (Grafana's environments). Plugins that run inside only. |
| `keepAlive(ctx)`, `vpnTargets(env)` | Keep a web session from expiring; name hosts behind your VPN for its check. Inside only. |
| `doors` | Commands for Copilot chats, see below. Inside only. |

`ctx` has `env` (its own settings), `fetch` and `json` (which refuse hosts not in the manifest), `run(bin, args)` (only its `clis`) and `dataDir` (its data folder, in the sandbox). A plugin that runs inside Clearsky can instead export a function, `export default (lends) => ({ … })`, to get what Clearsky lends it, such as `lends.findBrowser()`.

To try it while you write it, `clearsky add ./clearsky-weather` and restart; add it again after each change (the hash check stops a changed copy from loading).

## Doors

A Copilot chat runs in a sandbox that holds none of your logins. A door is how a plugin that runs inside Clearsky does something for it with what the plugin holds: the chat runs `grafana logs test '{app="api"}'` (or `door grafana …` for any plugin's door), and Clearsky passes it to the plugin's `doors.grafana.run(argv, door)`, which answers with `{ code, stdout, stderr }`. The door decides what to ask first: `door.ask({ title, detail })` puts a card in the chat and resolves to your answer, and Grafana asks for production that way. `door.vpn()` says whether the VPN is up. Clearsky logs every call in the agent log, removes secrets from the output and cuts it at 200,000 characters. Its `hint(env)` is a line added to Copilot's instructions so chats know the door is there.

A door has to be listed in the manifest's `doors`, needs `outside` (a sandboxed plugin can't hold anything a chat shouldn't see, so it has nothing to lend), and can't take a name Clearsky uses itself, such as `git`, `acli` or `outside`.

## Publishing one

Put the folder in a git repo, and people add it with `clearsky add github:you/clearsky-weather`. Tag releases as `v1.2.0` (any `vX.Y.Z` or `X.Y.Z` tag counts) so people can pin one and see when there's a newer one, and don't move a tag once it's out. A plugin that's only for your company can live in a private repo, or in the team pack's own repo (see [team packs](team-pack.md)). For npm, add a `package.json` with a `files` list that has `clearsky-plugin.json` and your code, and `npm publish`; people add it with `clearsky add npm:clearsky-weather`. The catalog's plugins are made that way: each `plugins/clearsky-<name>/` folder is a whole repo (manifest, code, README, LICENSE, tests and a CI workflow), and `node scripts/split-plugins.mjs` makes each one a git repo tagged with its version, printing the `gh repo create` commands to push them. For a new release, clone the plugin's repo next to your checkout first: the script then puts the folder's code on top as one commit, tags it, and prints the push.

## The catalog

`plugins/catalog.json` names the plugins anyone gets with a short name, each pinned to a tag:

```json
{ "plugins": [{ "name": "flyt", "aka": ["visma-flyt"], "folder": "clearsky-visma-flyt", "from": "github:ethlo/clearsky-visma-flyt#v1.0.0" }] }
```

`clearsky add visma-flyt` is then `clearsky add github:ethlo/clearsky-visma-flyt#v1.0.0`. A new release of a plugin is a new tag in its repo and a one-line change to the pin here. Anyone who added a plugin from its folder in `plugins/` (before it had a repo) keeps it working from that folder, and gets **Move to its repo** in Settings → Plugins (or `clearsky add visma-flyt`). Once a folder is deleted from `plugins/`, a plugin still added from it says where it lives now. A plugin that's gone for good is listed under `retired` with what to use instead (`{ "name": "slack", "use": "slack-mcp", "why": "…" }`): anyone who still has it added is told, and its old name adds the new one.

A plugin's tests that load it the way Clearsky does need a Clearsky checkout: `test/core.mjs` finds it in `CLEARSKY_CORE`, or in the Clearsky the folder sits in.

## What's next

A plugin can't add Copilot skills yet; a team pack can. Doors only come from plugins that run inside, so a sandboxed plugin has no way to answer a chat.
