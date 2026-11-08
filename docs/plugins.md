# Plugins

Clearsky ships as a core (GitHub, Jira, calendars, Copilot, links) and everything else is a plugin you add. A plugin is a plain folder: a `clearsky-plugin.json` that says what it is and what it reaches, and one ES module that does the work. There's no build step and nothing to `npm install`; a plugin has no dependencies, like Clearsky itself. Three ship with Clearsky in `plugins/`: Slack, Grafana and School (`flyt`). If you had Slack or Grafana set up before they became plugins, Clearsky adds them for you once.

## Adding one

```sh
clearsky add github:someone/clearsky-weather      # a GitHub repo; also gitlab: and codeberg:
clearsky add github:someone/plugins/weather#v1.2  # a folder in a repo, at a tag, branch or commit
clearsky add https://git.example.com/me/plug.git  # any git repo, fetched with your own git login
clearsky add npm:clearsky-weather@1.2.0           # an npm package
clearsky add ./my-plugin                          # a folder here
clearsky add flyt                                 # one that ships with Clearsky
```

Settings → Plugins does the same: paste where it comes from, **Look at it**, then **Add**. Either way Clearsky first fetches it and shows its manifest (hosts, programs, files, settings, and whether it runs in the sandbox), and nothing of the plugin has run yet: a git clone brings no hooks, and npm packages are fetched with `--ignore-scripts`. What you add is what you looked at. Clearsky loads plugins when it starts, so restart after adding one (Settings has the button).

`clearsky plugins` lists what's added and what ships with Clearsky, `clearsky update [name]` fetches again from where it came from, and `clearsky remove name` takes it out (`--data` also removes what it kept).

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
| `settings` | Fields under Settings → Other sources, saved to `.env`. Only these reach the plugin. A field can have a `pattern` (a regular expression Settings checks) with a `patternHint`, and a `link` (`{ "label", "url" }`) to where you get the value. |
| `enabledWhen` | Settings that must be filled in before Clearsky fetches anything. |
| `hosts` | All it may reach. `*.example.com` covers the subdomains. |
| `clis` | Programs it may run through `ctx.run`. |
| `secrets`, `files`, `note` | What it keeps, shown in Settings → Modules. |
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

Put the folder in a git repo, and people add it with `clearsky add github:you/clearsky-weather`. Tag releases so they can pin one (`#v1.0.0`). For npm, add a `package.json` with a `files` list that has `clearsky-plugin.json` and your code, and `npm publish`; people add it with `clearsky add npm:clearsky-weather`. The plugins in `plugins/` each have their own `package.json`, so they can be published on their own the same way.

## What's next

A plugin can't add Copilot skills yet; a team pack can. Doors only come from plugins that run inside, so a sandboxed plugin has no way to answer a chat.
