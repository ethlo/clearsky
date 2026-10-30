#!/bin/sh
# Lets Clearsky's sandbox (srt) run on Ubuntu 24.04 and newer, where AppArmor takes
# capabilities away from what bwrap starts. Only srt's seccomp helper in this checkout gets
# them back; user namespaces stay restricted for everything else. Needs sudo; run it yourself:
#
#   sh scripts/ubuntu-sandbox.sh          # install
#   sh scripts/ubuntu-sandbox.sh --remove # undo
set -eu
DIR=$(cd "$(dirname "$0")/.." && pwd)
case "$(uname -m)" in aarch64|arm64) arch=arm64 ;; *) arch=x64 ;; esac
helper="$DIR/node_modules/@anthropic-ai/sandbox-runtime/vendor/seccomp/$arch/apply-seccomp"
local=/etc/apparmor.d/local/bwrap-userns-restrict
rule="  $helper px -> clearsky_srt_seccomp,  # clearsky"

[ -f /etc/apparmor.d/bwrap-userns-restrict ] || { echo "No bwrap-userns-restrict profile here: nothing to do."; exit 0; }
if [ "${1:-}" = --remove ]; then
  sudo sed -i '/# clearsky$/d' "$local" 2>/dev/null || true
  sudo rm -f /etc/apparmor.d/clearsky-srt
  sudo apparmor_parser -r /etc/apparmor.d/bwrap-userns-restrict
  sudo apparmor_parser -R "$DIR/contrib/apparmor/clearsky-srt" 2>/dev/null || true
  echo "Removed."; exit 0
fi
[ -x "$helper" ] || { echo "srt isn't installed in $DIR (run npm install there first)." >&2; exit 1; }
case "$helper" in *[[:space:]]*) echo "The path has spaces, which this can't handle: $helper" >&2; exit 1 ;; esac
sudo install -m 644 "$DIR/contrib/apparmor/clearsky-srt" /etc/apparmor.d/clearsky-srt
sudo touch "$local"
sudo sed -i '/# clearsky$/d' "$local"
echo "$rule" | sudo tee -a "$local" >/dev/null
sudo apparmor_parser -r /etc/apparmor.d/clearsky-srt /etc/apparmor.d/bwrap-userns-restrict
echo "Done: srt's helper at $helper may now set up its filter."
