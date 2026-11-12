# Clearsky design docs

Written in Markdown next to the code. The `.html` files are rendered from them with `npm run docs`, and `npm test` fails when a rendered file is out of date.

- [How Clearsky works](architecture.md): the parts, the sources, Now / Next, Copilot, and security.
- [Where your tickets live](trackers.md): Jira, GitHub Issues or no tracker, and the `ticket` command chats use.
- [The agent behind your chats](agents.md): GitHub Copilot CLI or Claude Code, and how modes, skills and the sandbox carry over.
- [Team packs](team-pack.md): a team's shared setup, joined with one command.
- [Clearsky on Windows](windows.md): through WSL2, used from the Windows browser.
- [Plugins](plugins.md): adding sources on their own, each in a sandbox of its own, and writing one.
- [Clearsky in a container, reachable from the phone](remote-access.md): on hold, design only.
- [Clearsky on the work phone, over the home network](lan-access.md): on hold, design only.
