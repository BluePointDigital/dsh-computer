#!/bin/bash
# Start a virtual display, then idle so the container can be `docker exec`'d into.
set -u

GEOMETRY="${SCREEN_GEOMETRY:-1440x900x24}"
DISP="${DISPLAY:-:99}"
READY=/tmp/.computer-ready

rm -f "$READY"

if ! xdpyinfo -display "$DISP" >/dev/null 2>&1; then
  # /tmp survives `docker stop` / `docker start`, so a lock file from the
  # previous run outlives its server. Xvfb then refuses to start with
  # "Server is already active for display 99", and every GUI call fails with
  # "unable to open X server". Clear the stale lock, but only when no X server
  # is actually running.
  if ! pgrep -x Xvfb >/dev/null 2>&1; then
    rm -f "/tmp/.X${DISP#:}-lock" "/tmp/.X11-unix/X${DISP#:}"
  fi
  # -ac disables access control so any local client may connect.
  Xvfb "$DISP" -screen 0 "$GEOMETRY" -nolisten tcp -ac >/tmp/xvfb.log 2>&1 &
fi

for _ in $(seq 1 100); do
  if xdpyinfo -display "$DISP" >/dev/null 2>&1; then break; fi
  sleep 0.1
done

if xdpyinfo -display "$DISP" >/dev/null 2>&1; then
  # A window manager gives usable focus/placement and makes `xdotool
  # windowactivate` meaningful. Optional: the box works without one, but
  # windows then sit at 0,0 with no decorations and never take focus.
  if ! pgrep -x openbox >/dev/null 2>&1; then
    openbox >/tmp/openbox.log 2>&1 &
  fi
  echo "display $DISP ready at $GEOMETRY" > "$READY"
else
  { echo "display $DISP FAILED to start"; tail -n 20 /tmp/xvfb.log 2>/dev/null; } > "$READY"
fi

# Keep the container alive; the real work arrives via docker exec.
exec sleep infinity
