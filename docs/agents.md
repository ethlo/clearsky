# The agent behind your chats

Clearsky's chats run in **GitHub Copilot CLI** or in **Claude Code**. Pick one in **Settings → Copilot → Agent**, or in a team pack (`CLEARSKY_AGENT`: `copilot` or `claude`). Each uses its own login, so there's no token to make.

Both speak the [Agent Client Protocol](https://agentclientprotocol.com), which is how Clearsky already talks to a chat. So the chat panel, its Allow and Deny cards, history, hand-offs, skills, background jobs and the sandbox with its doors work the same with either.

| | GitHub Copilot CLI | Claude Code |
|---|---|---|
| Install | `npm install -g @github/copilot` | `npm install -g @agentclientprotocol/claude-agent-acp` (Claude Code's ACP adapter) |
| Login | Copilot's own (`copilot`, then `/login`) | Claude Code's own (`claude`, then `/login`) |
| Modes | Copilot's flags (`--allow-all-tools`, `--deny-tool`, `--mode plan`) | Claude Code's permission modes, set for each session |
| Model | the chat's picker (`--model`) | the chat's picker (`opus`, `sonnet`, `haiku` or a `claude-…` name, as `ANTHROPIC_MODEL`) |
| Reasoning effort | the chat's picker | Claude Code's own setting |
| More folders | `--add-dir` | the session's extra folders |
| Skills | `.github/skills` and `~/.copilot/skills` | `.claude/skills`, `.github/skills` and `~/.claude/skills` |
| Its state, writable in the sandbox | `~/.copilot`, `~/.cache/copilot` | `~/.claude`, `~/.cache/claude` |
| Its hosts in the sandbox | `*.githubcopilot.com` | `api.anthropic.com`, `claude.ai`, `statsig.anthropic.com` |
| Usage page, `usage` line | AI credits from its session logs | not counted: see your Claude or Anthropic account |

Left on **Automatic**, it's Copilot when the Copilot CLI is installed, else Claude Code when its adapter is, so nothing changes for people who had Copilot.

## Modes

Clearsky's modes stay the same, and each becomes one of Claude Code's permission modes:

| Clearsky | Claude Code | What happens |
|---|---|---|
| Ask | `default` | Claude Code asks before edits and commands; the question shows as Allow and Deny. |
| Sandboxed | `bypassPermissions`, inside srt | Anything inside the sandbox runs. Leaving it (a push, a GitHub or Jira change, a new host) goes through Clearsky's doors and asks you, as with Copilot. |
| Full access | `bypassPermissions` | Everything runs without asking. |
| Read only, Plan only | `plan` | It reads and plans, and changes nothing. |

In the sandbox Claude Code keeps its settings file in `~/.claude` (`CLAUDE_CONFIG_DIR`), next to its login, because it can't write in the rest of your home there. It has no built-in GitHub tools, so nothing reaches GitHub past the gate. MCP servers you set up for Claude Code yourself are its own; Clearsky doesn't add any.

## What is Copilot-only for now

- **Usage:** credits come from Copilot's session logs. With Claude Code the Usage page and `usage` say they aren't counted.
- **Open elsewhere:** Copilot marks a session open in a terminal or editor, so the menu shows it as open. Claude Code sessions show from Clearsky's own chats, and from its session list.
- **Compaction notes:** `/compact` reports what it removed from Copilot's log only.

Stand-up, the review queue and the reviewer (`review`) work with either: the stand-up summary is written by the agent you picked, and the reviewer is a fresh read-only session of it.

## Settings

| Setting | What |
|---|---|
| `CLEARSKY_AGENT` | `copilot`, `claude`, or empty for automatic |
| `COPILOT_BIN` | where the Copilot CLI is, if not on PATH |
| `CLAUDE_ACP_BIN` | where `claude-agent-acp` is, if not on PATH |

The Copilot settings (model, mode, folders, sandbox, hosts, VMs) apply to whichever agent you picked; they keep their names so nothing you set before changes.
