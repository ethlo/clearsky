# Slack for Clearsky

A [Clearsky](https://github.com/ethlo/clearsky) plugin. Slack messages that @mention you, from the last two weeks (`CLEARSKY_MENTION_DAYS`): rows under Needs you, notifications when one is new, and "Reply to …" in Now / Next for the ones from the last day. It only reads, with your user token and the `search:read` scope. It finds messages that @mention you, including in DMs and private channels you are in. It doesn't list every unread DM: Slack's API has no cheap way to do that, and Slack itself already shows them.

## Add it

```sh
clearsky add slack
```

or **Settings → Plugins → Slack → Add**. That's `github:ethlo/clearsky-slack` at the version Clearsky's catalog pins. It runs in a sandbox of its own that reaches only `slack.com`, so it needs the sandbox (`srt`), which Clearsky's installer sets up.

## The token

The link under **Slack user token** in Settings creates the app for you. By hand:

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
4. Under **OAuth & Permissions**, copy the **User OAuth Token** (`xoxp-...`) into **Slack user token** in Settings. It's kept in `~/.config/clearsky/.env` (mode 600) and never shown back.

## Develop

```sh
git clone --depth 1 https://github.com/ethlo/clearsky .clearsky
CLEARSKY_CORE=.clearsky npm test
```

The tests run against a stand-in for Slack's API and load the plugin the way Clearsky does, so they need a Clearsky checkout (see `test/core.mjs`). Release by bumping `version` in `clearsky-plugin.json` and `package.json` and tagging `v<version>`.
