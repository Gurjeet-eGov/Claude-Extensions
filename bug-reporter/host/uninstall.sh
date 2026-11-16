#!/usr/bin/env bash
# Removes the eGov Bug Reporter helper registration and its config.
set -euo pipefail
HOST_NAME="com.egov.bug_reporter"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/egov-bug-reporter"
if [ "$(uname)" = "Darwin" ]; then
  AS="$HOME/Library/Application Support"
  BROWSERS=("$AS/Google/Chrome" "$AS/Google/Chrome Beta" "$AS/Google/Chrome Dev" "$AS/Google/Chrome Canary" "$AS/Google/Chrome for Testing" "$AS/Chromium" "$AS/BraveSoftware/Brave-Browser" "$AS/Microsoft Edge")
  CACHE="$HOME/Library/Caches/egov-bug-reporter"
else
  C="${XDG_CONFIG_HOME:-$HOME/.config}"
  BROWSERS=("$C/google-chrome" "$C/google-chrome-beta" "$C/google-chrome-unstable" "$C/google-chrome-for-testing" "$C/chromium" "$C/BraveSoftware/Brave-Browser" "$C/microsoft-edge")
  CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/egov-bug-reporter"
fi
for base in "${BROWSERS[@]}"; do
  rm -f "$base/NativeMessagingHosts/$HOST_NAME.json"
done
if [ "$(uname)" = "Darwin" ]; then APP_DIR="$HOME/Library/Application Support/egov-bug-reporter"; else APP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/egov-bug-reporter"; fi
rm -rf "$CONFIG_DIR" "$CACHE" "$APP_DIR"
[ -L "$HOME/.claude/skills/log-issue-extension" ] && rm -f "$HOME/.claude/skills/log-issue-extension"
echo "Helper unregistered. Remove the extension itself from chrome://extensions."
