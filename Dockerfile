# Clearsky in a Linux container: the same on Linux, macOS and Windows (Docker Desktop).
#
# The container is also Copilot's fence: it sees only what docker-compose.yml mounts. Paths
# inside are the same as on your machine (your home is mounted at the same place and the
# container runs as you), so chats, worktrees and Copilot's session state line up.
#
#   docker compose up -d --build     then open http://127.0.0.1:7777 (and "Install app" in the browser)
FROM node:22-bookworm-slim

ARG GH_VERSION=2.62.0
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates curl poppler-utils ripgrep openssh-client unzip \
    && curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_$(dpkg --print-architecture).tar.gz" \
      | tar -xz -C /usr/local --strip-components=1 \
    && arch=$(dpkg --print-architecture) \
    && curl -fsSL -o /usr/local/bin/acli "https://acli.atlassian.com/linux/latest/acli_linux_${arch}/acli" && chmod 755 /usr/local/bin/acli \
    && npm install -g --no-fund --no-audit @github/copilot \
    && rm -rf /var/lib/apt/lists/* /root/.npm \
    # No ssh keys in here: git talks to GitHub over https with gh's login (GH_TOKEN).
    && git config --system url.https://github.com/.insteadOf git@github.com: \
    && git config --system --add url.https://github.com/.insteadOf ssh://git@github.com/ \
    && git config --system credential.https://github.com.helper '!gh auth git-credential'

WORKDIR /opt/clearsky
COPY package.json package-lock.json ./
# srt isn't needed in here: the container is the sandbox.
RUN npm ci --omit=dev --omit=optional --no-fund --no-audit
COPY . .

ENV CLEARSKY_BIND=0.0.0.0 \
    CLEARSKY_SUPERVISED=1 \
    COPILOT_SANDBOX=off \
    CLEARSKY_IN_CONTAINER=1
EXPOSE 7777
CMD ["node", "bin/clearsky.mjs", "serve"]
