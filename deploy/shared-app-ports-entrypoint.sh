#!/bin/sh
# Reload when the existing certificate owner rotates either certificate file.
set -eu
fingerprint() { sha256sum /tls/fullchain.pem /tls/privkey.pem; }
nginx -c /config/nginx.conf -t
before="$(fingerprint)"
nginx -c /config/nginx.conf -g 'daemon off;' &
master=$!
watcher() {
  while kill -0 "$master" 2>/dev/null; do
    sleep 60
    after="$(fingerprint)"
    if [ "$after" != "$before" ]; then
      if nginx -c /config/nginx.conf -t && nginx -c /config/nginx.conf -s reload; then before="$after"; fi
    fi
  done
}
watcher &
watch=$!
trap 'kill "$watch" "$master" 2>/dev/null || true; wait "$master" 2>/dev/null || true' TERM INT EXIT
wait "$master"
