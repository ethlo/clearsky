#!/bin/sh
# Logs gh, acli and Copilot in inside Clearsky's container, into its own keyring:
#   docker compose exec -it clearsky clearsky-login            (all three)
#   docker compose exec -it clearsky clearsky-login acli       (just one: gh, acli or copilot)
# Each prints a link and a code to open in your browser. Settings in Clearsky can do gh and
# acli too.
set -eu
. "$HOME/.session-bus"
want="${1:-all}"
if [ "$want" = all ] || [ "$want" = gh ]; then
  gh auth status >/dev/null 2>&1 && echo "gh: logged in" || gh auth login --hostname github.com --git-protocol https --web
fi
if [ "$want" = all ] || [ "$want" = acli ]; then
  # --web needs your browser to reach back into the container; if it can't, log in with an
  # API token instead: acli jira auth login --site <you>.atlassian.net --email <you> --token < token.txt
  acli jira auth status >/dev/null 2>&1 && echo "acli: logged in" || acli jira auth login --web
fi
if [ "$want" = all ] || [ "$want" = copilot ]; then
  copilot login
fi
