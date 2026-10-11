#!/bin/bash
# box-desktop — serve this box's existing display to a human viewer.
#
# This is the tier-3 "eyes and hands" layer. x11vnc shares the SAME :99 display
# the agent drives, and websockify+noVNC expose it over HTTP. It is deliberately
# NOT a second desktop: whatever the agent clicks, the viewer sees live.
set -u

DISP="${DISPLAY:-:99}"
PORT="${NOVNC_PORT:-6080}"
RFB_PORT="${VNC_PORT:-5900}"
PW="${VNC_PASSWORD:-}"

# Restart cleanly if a previous viewer is still around.
pkill -x x11vnc >/dev/null 2>&1 || true
pkill -f '/websockify' >/dev/null 2>&1 || true
sleep 1

VNC_ARGS=(-display "$DISP" -forever -shared -rfbport "$RFB_PORT" -localhost -quiet -noxdamage)
if [ -n "$PW" ]; then
  VNC_ARGS+=(-passwd "$PW")
else
  VNC_ARGS+=(-nopw)
fi
nohup x11vnc "${VNC_ARGS[@]}" >/tmp/x11vnc.log 2>&1 &

for _ in $(seq 1 40); do
  pgrep -x x11vnc >/dev/null 2>&1 && break
  sleep 0.25
done

# -localhost on x11vnc keeps the raw RFB port off the network; only the
# websockify proxy is published. The password is still enforced end-to-end.
nohup websockify --web=/usr/share/novnc "$PORT" "localhost:${RFB_PORT}" \
  >/tmp/websockify.log 2>&1 &

for _ in $(seq 1 40); do
  pgrep -f '/websockify' >/dev/null 2>&1 && break
  sleep 0.25
done

echo "x11vnc: $(pgrep -x x11vnc >/dev/null 2>&1 && echo up || echo DOWN)" \
     "websockify: $(pgrep -f '/websockify' >/dev/null 2>&1 && echo up || echo DOWN)" \
     "port: $PORT" \
     "auth: $([ -n "$PW" ] && echo password || echo none)"
