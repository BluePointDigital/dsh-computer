#!/usr/bin/env bash
# app_require retries a lookup miss from the boot window (see the comment above
# apps_require in bin/computer). The point of the retry is that
#   `apps up <id>` answering "unknown app <id>" is not proof the app is gone.
#
# Two properties, both deterministic:
#   1. a catalog that lacks the app on the first read and gains it a moment later
#      must resolve, rather than failing on the stale read;
#   2. a catalog that never has the app must fail, and say what it does contain.
#
# Uses `apps url`, which resolves an app and reads the viewer URL without Docker,
# so this needs no daemon and starts nothing.
set -uo pipefail
# These regressions target the retained creation-only shell resolver, not runtime discovery.
export COMPUTER_APPS_LEGACY=1

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPUTER="$HERE/../bin/computer"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass=0; fail=0
ok()  { printf '  ok   %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  FAIL %s\n' "$1"; fail=$((fail+1)); }

# $2 is an optional extra app block appended under `apps:`.
write_catalog() {
  cat > "$1" <<EOF
version: 1
apps:
  - id: whoami
    name: Whoami
    image: traefik/whoami:latest
$2
EOF
}

DESKTOP_BLOCK='  - id: desktop
    name: Linux Desktop
    image: dsh-computer:bookworm
    viewer: 6081:6080'

# 1. transient miss -> retry resolves
write_catalog "$TMP/late.yaml" ""
( sleep 2; write_catalog "$TMP/late.yaml" "$DESKTOP_BLOCK" ) &
writer=$!
out="$(COMPUTER_APPS_FILE="$TMP/late.yaml" "$COMPUTER" apps url desktop 2>&1)"
rc=$?
wait "$writer" 2>/dev/null
if [ "$rc" = 0 ] && printf '%s' "$out" | grep -q '6081'; then
  ok "resolves after a transient catalog miss"
else
  bad "did not resolve after the catalog gained the app (rc=$rc): $out"
fi

# 2. permanent miss -> fail, and report what the catalog holds
write_catalog "$TMP/partial.yaml" ""
out2="$(COMPUTER_APPS_FILE="$TMP/partial.yaml" "$COMPUTER" apps url desktop 2>&1)"
rc2=$?
if [ "$rc2" != 0 ] && printf '%s' "$out2" | grep -q "unknown app 'desktop'"; then
  ok "still fails for an app the catalog does not define"
else
  bad "expected a failure for a missing app (rc=$rc2): $out2"
fi
if printf '%s' "$out2" | grep -q 'catalog at' && printf '%s' "$out2" | grep -q 'defines 1 app'; then
  ok "failure names the catalog and its app count"
else
  bad "diagnostic does not identify the catalog: $out2"
fi

printf '\n%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" = 0 ]
