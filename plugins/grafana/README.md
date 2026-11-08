# Grafana for Clearsky

Lets Copilot chats read logs, metrics and dashboards of your environments with `grafana logs test '{app="api"} |= "error"'` instead of a shell on servers. Read only: it makes only search and query calls, with your Viewer login, which never goes in the sandbox. Environments that ask (any name with "prod" by default) ask in the chat each time, and while the VPN is off it says so instead of failing.

Add it with `clearsky add grafana` or under Settings → Plugins, set **Grafana environments** under Settings → Other sources, and log in to each with your browser there (or give Viewer tokens).
