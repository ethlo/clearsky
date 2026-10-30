# Clearsky in a Linux container: the same on Linux, macOS and Windows (Docker Desktop).
#
# The container is also Copilot's fence: it sees only what docker-compose.yml mounts. Paths
# inside are the same as on your machine (your home is mounted at the same place and the
# container runs as you), so chats, worktrees and Copilot's session state line up.
#
#   node bin/clearsky.mjs docker up     then open http://127.0.0.1:7777 (and "Install app" in the browser)
FROM node:22-bookworm-slim

ARG GH_VERSION=2.62.0
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates curl poppler-utils ripgrep openssh-client unzip \
      dbus gnome-keyring libsecret-tools \
    && curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_$(dpkg --print-architecture).tar.gz" \
      | tar -xz -C /usr/local --strip-components=1 \
    && arch=$(dpkg --print-architecture) \
    && curl -fsSL -o /usr/local/bin/acli "https://acli.atlassian.com/linux/latest/acli_linux_${arch}/acli" && chmod 755 /usr/local/bin/acli \
    && npm install -g --no-fund --no-audit @github/copilot \
    && rm -rf /var/lib/apt/lists/* /root/.npm \
    # No ssh keys in here: git talks to GitHub over https with gh's login.
    && git config --system url.https://github.com/.insteadOf git@github.com: \
    && git config --system --add url.https://github.com/.insteadOf ssh://git@github.com/ \
    && git config --system credential.https://github.com.helper '!gh auth git-credential'

WORKDIR /opt/clearsky
COPY package.json package-lock.json ./
# srt isn't needed in here: the container is the sandbox.
RUN npm ci --omit=dev --omit=optional --no-fund --no-audit
COPY . .
RUN ln -s /opt/clearsky/scripts/container-login.sh /usr/local/bin/clearsky-login \
    # No browser in here: a login that opens one leaves its link for `clearsky docker login`,
    # which opens it in your browser (and prints it, for when that doesn't work).
    && printf '#!/bin/sh\n(umask 077; printf "%%s\\n" "$1" > "$HOME/.config/clearsky/container/open-url")\necho "Open this link in your browser: $1" >&2\n' > /usr/local/bin/xdg-open \
    && chmod 755 /usr/local/bin/xdg-open && ln -s xdg-open /usr/local/bin/x-www-browser && ln -s xdg-open /usr/local/bin/www-browser
ENV BROWSER=/usr/local/bin/xdg-open

ENV CLEARSKY_BIND=0.0.0.0 \
    CLEARSKY_SUPERVISED=1 \
    COPILOT_SANDBOX=off \
    CLEARSKY_IN_CONTAINER=1
EXPOSE 7777
# Runs Clearsky with a keyring of its own for the logins (see the script).
ENTRYPOINT ["/opt/clearsky/scripts/container-start.sh"]
CMD ["serve"]
