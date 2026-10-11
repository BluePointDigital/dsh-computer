#!/usr/bin/env bash
# Regression: the app viewer password must survive the loss of its state file.
#
# `APPS_STATE` used to default to `<skill>/.state`, and the skill directory is a
# symlink into a pnpm-managed package. Any `pnpm install` replaces that package
# wholesale, so the state vanished silently -- the viewer kept enforcing a
# password the CLI could no longer report, and the GUI rendered a blank one.
# Observed live on a v0.1.4 -> v0.1.5 upgrade.
#
# Resolution order under test: new path -> legacy path (migrated) -> running
# container env (recovered + re-persisted). A read-only lookup must never mint a
# credential; only `apps up` may generate one.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPUTER="$HERE/../bin/computer"

# Source the functions without running the CLI dispatch.
DISPATCH="$(grep -nE '^case "\$\{?1' "$COMPUTER" | head -1 | cut -d: -f1)"
head -n "$((DISPATCH - 1))" "$COMPUTER" > /tmp/.computer-funcs.$$.sh
# shellcheck disable=SC1090
source /tmp/.computer-funcs.$$.sh 2>/dev/null || true
rm -f /tmp/.computer-funcs.$$.sh

SKILL_DIR=/tmp/fake-skill; DSH_HOME=/tmp/fake-dsh
APPS_STATE="$DSH_HOME/.dsh-applications"; APPS_STATE_LEGACY="$SKILL_DIR/.state"
APPS_PREFIX="dsh-app"; APPS_FILE=/tmp/fake-apps.yaml
BIND_IP=127.0.0.1; PUBLIC_URL=""; GEO="1440x900"; WORKSPACE=/tmp/fake-ws

app_cname() { printf '%s-%s' "$APPS_PREFIX" "$1"; }
# `docker inspect -f '<fmt>' <name>` -- the NAME is the 4th argv.
docker() {
  [ "$1" = inspect ] || return 1
  case "$4" in
    *dsh-app-desktop) printf 'PATH=/usr/bin\nVNC_PASSWORD=%s\nHOME=/home/agent\n' "$STUB_PW" ;;
    *) return 1 ;;
  esac
}

pass=0; fail=0
chk() { if [ "$2" = "$3" ]; then printf '  ok    %s\n' "$1"; pass=$((pass+1));
        else printf '  FAIL  %s (got %q want %q)\n' "$1" "$2" "$3"; fail=$((fail+1)); fi; }

rm -rf "$APPS_STATE" "$APPS_STATE_LEGACY"
STUB_PW=FromContainer1
chk "recovers from the live container"   "$(app_viewer_password desktop)" "FromContainer1"
chk "persisted to the new path"          "$(cat "$APPS_STATE/desktop.vnc-password" 2>/dev/null)" "FromContainer1"
STUB_PW=ShouldNotBeUsed
chk "second call reads the file"         "$(app_viewer_password desktop)" "FromContainer1"

rm -rf "$APPS_STATE" "$APPS_STATE_LEGACY"; mkdir -p "$APPS_STATE_LEGACY"
printf 'LegacyPw9' > "$APPS_STATE_LEGACY/desktop.vnc-password"
STUB_PW=Unused
chk "honours the legacy path"            "$(app_viewer_password desktop)" "LegacyPw9"
chk "migrates to the new path"           "$(cat "$APPS_STATE/desktop.vnc-password" 2>/dev/null)" "LegacyPw9"

rm -rf "$APPS_STATE" "$APPS_STATE_LEGACY"; STUB_PW=""
pw="$(app_vnc_password shell)";          chk "generates when nothing exists" "${#pw}" "10"

rm -rf "$APPS_STATE"; STUB_PW=LiveViewerPw
chk "recovers instead of regenerating"   "$(app_vnc_password desktop)" "LiveViewerPw"

rm -rf "$APPS_STATE"; STUB_PW=""
if app_viewer_password ghost >/dev/null 2>&1; then printf '  FAIL  read-only invented a credential\n'; fail=$((fail+1));
else printf '  ok    read-only returns failure\n'; pass=$((pass+1)); fi
[ -f "$APPS_STATE/ghost.vnc-password" ] && { printf '  FAIL  wrote a file\n'; fail=$((fail+1)); } \
                                       || { printf '  ok    wrote no file\n'; pass=$((pass+1)); }

rm -rf "$APPS_STATE" "$APPS_STATE_LEGACY"; STUB_PW=F0gpS1CxiN
chk "the exact lost-state scenario"      "$(app_viewer_password desktop)" "F0gpS1CxiN"

printf '\n  %d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
