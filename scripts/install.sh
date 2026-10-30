#!/bin/sh
# Install or update Clearsky with one command:
#
#   sh scripts/install.sh                 # from a checkout: installs that checkout
#   CLEARSKY_REPO=<git url> sh install.sh # or clone it first
#   sh scripts/install.sh --service       # also start it at login (systemd user service)
#
# It adds Clearsky to your app menu (its own window), puts `clearsky` and Anthropic's sandbox runtime (`srt`, for Settings → Copilot → Sandbox)
# on your PATH with npm, and makes ~/.config/clearsky. It never uses sudo: system packages it
# can't install (bubblewrap, socat, ripgrep for the sandbox) are listed with the command to run.
# Running it again updates everything.
#
# CLEARSKY_DIR     where to clone it when not run from a checkout (~/.local/share/clearsky)
# CLEARSKY_REPO    the git repository to clone, when not run from a checkout
# CLEARSKY_BRANCH  the branch to install (main)
set -eu

SERVICE=0 SANDBOX=1
for a in "$@"; do
  case "$a" in
    --service) SERVICE=1 ;;
    --no-sandbox) SANDBOX=0 ;;
    -h|--help) sed -n '2,15p' "$0" 2>/dev/null; exit 0 ;;
    *) echo "unknown option $a" >&2; exit 2 ;;
  esac
done

say() { printf '\033[1m%s\033[0m\n' "$*"; }
warn() { printf '  ! %s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

# ---- Node 22 or newer, through nvm when that's how Node is installed here.
node_ok() { have node && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ]; }
if ! node_ok && [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "${NVM_DIR:-$HOME/.nvm}/nvm.sh"
  nvm use 22 >/dev/null 2>&1 || { say "Installing Node 22 with nvm"; nvm install 22; }
fi
node_ok || { echo "Clearsky needs Node 22 or newer (https://nodejs.org, or nvm install 22)." >&2; exit 1; }
have git || { echo "Clearsky needs git." >&2; exit 1; }

# ---- The code: this checkout, or a clone kept up to date.
here=$(cd "$(dirname "$0")/.." 2>/dev/null && pwd || true)
if [ -n "$here" ] && [ -f "$here/bin/clearsky.mjs" ]; then
  DIR=$here
  say "Using the checkout in $DIR"
else
  DIR=${CLEARSKY_DIR:-$HOME/.local/share/clearsky}
  if [ -d "$DIR/.git" ]; then
    say "Updating $DIR"
    git -C "$DIR" pull --ff-only
  else
    say "Cloning Clearsky into $DIR"
    [ -n "${CLEARSKY_REPO:-}" ] || { echo "Set CLEARSKY_REPO to the git repository to install from, or run this from a checkout." >&2; exit 1; }
    git clone --branch "${CLEARSKY_BRANCH:-main}" "$CLEARSKY_REPO" "$DIR"
  fi
fi

# ---- clearsky and srt on your PATH (npm links the checkout, so updates need no reinstall).
# Its own dependencies (the sandbox runtime, srt, is the only one) go next to the code.
say "Installing what Clearsky needs"
if [ "$SANDBOX" = 1 ]; then (cd "$DIR" && npm install --no-fund --no-audit --omit=dev); else (cd "$DIR" && npm install --no-fund --no-audit --omit=dev --omit=optional); fi
say "Installing clearsky with npm"
if [ "$SANDBOX" = 1 ]; then
  npm install -g --no-fund --no-audit "$DIR" @anthropic-ai/sandbox-runtime  # srt on your PATH too
else
  npm install -g --no-fund --no-audit "$DIR"
fi

# ---- Settings live here, readable only by you.
mkdir -p "$HOME/.config/clearsky"
chmod 700 "$HOME/.config/clearsky"
[ -f "$HOME/.config/clearsky/.env" ] || { : > "$HOME/.config/clearsky/.env"; }
chmod 600 "$HOME/.config/clearsky/.env"

# ---- What else it uses, and how to get what's missing.
say "Checking tools"
pm=""
if have apt-get; then pm="sudo apt-get install -y"; elif have dnf; then pm="sudo dnf install -y"; elif have pacman; then pm="sudo pacman -S"; elif have brew; then pm="brew install"; fi
if [ "$SANDBOX" = 1 ] && [ "$(uname -s)" = Linux ]; then
  missing=""
  have bwrap || missing="$missing bubblewrap"
  have socat || missing="$missing socat"
  have rg || missing="$missing ripgrep"
  if [ -n "$missing" ]; then warn "the Copilot sandbox needs:$missing  ->  ${pm:-install}$missing"; else echo "  sandbox: bubblewrap, socat and ripgrep are there"; fi
  if [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" = 1 ]; then
    warn "Ubuntu limits user namespaces, which the sandbox needs. See the srt README (Ubuntu 24.04+ note) before turning it on."
  fi
fi
have gh || warn "GitHub CLI (gh) not found: Settings can log you in with it (https://cli.github.com), or use a token"
have acli || warn "Atlassian CLI (acli) not found: Jira needs it (https://developer.atlassian.com/cloud/acli/guides/install-acli/)"
have pdftotext || warn "pdftotext not found: school weekly plans in PDF need it  ->  ${pm:-install} poppler-utils"
have copilot || [ -n "$(ls "$HOME"/.nvm/versions/node/*/bin/copilot 2>/dev/null | head -1)" ] || warn "GitHub Copilot CLI not found: the Copilot panel needs it (npm install -g @github/copilot)"

# ---- Clearsky in its own window: an entry in your app menu that runs `clearsky app`.
if [ "$(uname -s)" = Linux ]; then
  apps="$HOME/.local/share/applications"
  mkdir -p "$apps"
  cat > "$apps/clearsky.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Clearsky
Comment=What needs you today, at work and at home
Exec=$(command -v node) $DIR/bin/clearsky.mjs app
Icon=$DIR/web/icon-512.png
Terminal=false
Categories=Office;
StartupWMClass=Clearsky
DESKTOP
  have update-desktop-database && update-desktop-database "$apps" >/dev/null 2>&1 || true
  echo "  app menu: Clearsky (opens it in a window of its own)"
fi

# ---- Start it at login, when asked.
if [ "$SERVICE" = 1 ]; then
  have systemctl || { echo "--service needs systemd" >&2; exit 1; }
  unit="$HOME/.config/systemd/user/clearsky.service"
  mkdir -p "$(dirname "$unit")"
  nodebin=$(dirname "$(command -v node)")
  sed -e "s#^WorkingDirectory=.*#WorkingDirectory=$DIR#" \
      -e "s#^ExecStart=.*#ExecStart=$nodebin/node bin/clearsky.mjs serve#" \
      -e "s#^Environment=PATH=.*#Environment=PATH=$nodebin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin#" \
      "$DIR/contrib/clearsky.service" > "$unit"
  systemctl --user daemon-reload
  systemctl --user enable clearsky >/dev/null
  # A running Clearsky restarts when its chats are idle; otherwise start it.
  if systemctl --user is-active --quiet clearsky; then clearsky restart || true; else systemctl --user start clearsky; fi
  say "Clearsky runs at login: http://127.0.0.1:7777  (logs: journalctl --user -u clearsky -f)"
else
  say "Done. Start it with:  clearsky serve   then open http://127.0.0.1:7777/settings"
  echo "  (or run this again with --service to start it at login)"
fi
