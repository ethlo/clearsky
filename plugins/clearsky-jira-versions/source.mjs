// Jira fix versions through Atlassian's remote MCP server: you log in from Settings in your
// browser (OAuth with PKCE; Clearsky registers itself as a client, so there's no token or app to
// create), and Copilot chats add or remove fix versions with `jira-versions …`, after you OK each
// change in the chat. That runs here with your login, which never goes in the sandbox, and
// touches only a ticket's fixVersions (lib/jira-versions.mjs). What it reaches and keeps is in
// clearsky-plugin.json.

import { join } from 'node:path';
import { homedir } from 'node:os';
import { createJiraVersionsMcp, parseCommand, USAGE } from './lib/jira-versions.mjs';

export default (lends, { store, fetchImpl = fetch } = {}) => {
  store ||= lends.mcpOAuth.tokenStore(join(homedir(), '.config', 'clearsky', 'jira-versions-mcp.json'));
  const j = createJiraVersionsMcp({ lends, store, fetchImpl });

  return {
    // What's set up, for Settings → Plugins; Jira itself is only reached through the door.
    async fetch(ctx) {
      j.use(ctx.env);
      return { loggedIn: j.status().loggedIn };
    },

    // One login, with a Log out next to it (Settings → Plugins → Jira versions).
    logins: {
      list(env) { j.use(env); const s = j.status(); return [{ id: 'atlassian', label: 'Atlassian', ...s, canLogOut: s.loggedIn }]; },
      async start(id, env) { j.use(env); return j.login(); },
      async stop(id, env) { j.use(env); j.logout(); },
    },

    doors: {
      'jira-versions': {
        usage: USAGE,
        hint(env) {
          j.use(env);
          if (!j.status().loggedIn) return '';
          return 'To add or remove a Jira ticket\'s fix versions, use `jira-versions add 1.7.0 ABC-1 ABC-2` or `jira-versions remove 1.7.0 ABC-3` (`jira-versions show ABC-1` reads them, `jira-versions help` lists the commands): acli can\'t set fix versions. It asks me once per command, showing each ticket before and after, so put all the tickets for one version in one command. Status moves stay with `acli jira workitem transition --key ABC-1 --status "Done"`.';
        },
        async run(argv, door) {
          j.use(door.env);
          const cmd = parseCommand(argv);
          if (cmd.error) return { code: 2, stdout: '', stderr: `jira-versions: ${cmd.error}\n\n${USAGE}\n`, decided: 'refused' };
          const ask = (detail) => door.ask({ title: 'Change Jira fix versions as you', detail });
          try { return await j.run(cmd, ask); }
          catch (e) { return { code: 1, stdout: '', stderr: `Clearsky: ${e.message}\n`, decided: e.auth ? 'not logged in' : e.site ? 'no site' : 'failed' }; }
        },
      },
    },
  };
};
