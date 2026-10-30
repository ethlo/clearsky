#!/bin/sh
# Starts Clearsky inside its container, with a keyring of its own: gh, acli, Copilot and the
# school login keep their logins in a keyring (acli has no other place), and a container has
# none. So this runs a D-Bus session with gnome-keyring in it, kept in
# ~/.config/clearsky/container/ (mounted from your machine, mode 700), so a login survives
# rebuilds. Your machine's own keyring and logins are never touched.
#
# Log in once after the first start:  clearsky docker login
set -eu

if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ]; then exec dbus-run-session -- "$0" "$@"; fi

KEEP="$HOME/.config/clearsky/container"
mkdir -p "$KEEP/keyrings" "$KEEP/gh" "$KEEP/acli" "$HOME/.local/share" "$HOME/.config"
chmod 700 "$KEEP" "$KEEP/keyrings" "$KEEP/gh" "$KEEP/acli"
# Home in here is a scratch folder: point the tools' login folders into the kept one.
ln -sfn "$KEEP/keyrings" "$HOME/.local/share/keyrings"
ln -sfn "$KEEP/gh" "$HOME/.config/gh"
ln -sfn "$KEEP/acli" "$HOME/.config/acli"

# The keyring is encrypted with a random password kept beside it (the folder is yours only).
PASS="$KEEP/keyring-password"
[ -s "$PASS" ] || (umask 077; head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$PASS")
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-$(mktemp -d)}"
gnome-keyring-daemon --daemonize --unlock --components=secrets < "$PASS" > /dev/null
gnome-keyring-daemon --start --components=secrets > /dev/null
# For `docker compose exec`, which starts outside this session: where to find the keyring.
(umask 077; echo "DBUS_SESSION_BUS_ADDRESS='$DBUS_SESSION_BUS_ADDRESS'; XDG_RUNTIME_DIR='$XDG_RUNTIME_DIR'; export DBUS_SESSION_BUS_ADDRESS XDG_RUNTIME_DIR" > "$HOME/.session-bus")

[ $# -gt 0 ] || set -- serve
exec node /opt/clearsky/bin/clearsky.mjs "$@"
