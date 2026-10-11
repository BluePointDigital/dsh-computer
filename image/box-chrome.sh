#!/bin/bash
# box-chrome — launch Chromium on the box's virtual display.
#
# Why this exists: HOME is a bind mount, so Chromium's profile directory
# survives `docker stop/start` AND `docker rm`. A SingletonLock left behind by a
# container that no longer exists makes Chromium show a modal
# "The profile appears to be in use by another Chromium process" dialog instead
# of loading the page. Every screenshot then captures that dialog.
#
# Run under nohup from the agent side, e.g.:
#   nohup box-chrome https://example.com >/tmp/chrome.log 2>&1 &
set -u

PROFILE="${BOX_CHROME_PROFILE:-$HOME/.config/box-chrome}"
mkdir -p "$PROFILE"

# Optional CDP endpoint for element-level control (see box-cdp.mjs). Off by
# default: a debugging port can drive the whole signed-in browser, so it is
# opt-in per launch rather than always-on.
CDP_ARGS=()
if [ -n "${BOX_CHROME_CDP_PORT:-}" ]; then
  # --remote-allow-origins is required or Chrome 403s the CDP websocket for
  # clients that send an Origin header.
  CDP_ARGS+=(--remote-debugging-port="$BOX_CHROME_CDP_PORT" --remote-allow-origins='*')
fi

# Clear stale singleton locks. Safe: the previous owner died with its container.
rm -f "$PROFILE/SingletonLock" "$PROFILE/SingletonSocket" "$PROFILE/SingletonCookie"

exec chromium \
  --no-sandbox \
  --disable-gpu \
  --disable-dev-shm-usage \
  --no-first-run \
  --no-default-browser-check \
  --disable-features=Translate,BackForwardCache \
  --hide-crash-restore-bubble \
  --user-data-dir="$PROFILE" \
  "${CDP_ARGS[@]}" \
  --window-size="${BOX_CHROME_SIZE:-1400,860}" \
  --window-position=0,0 \
  "$@"
