#!/usr/bin/env bash
# test-switch.sh — round-trip test for switch-to-bundle.sh.
#
# Runs the switch and its revert against a COPY of the live profile, then asserts
# the copy returns to exactly the state it started in. The live profile is never
# written to; if this test ever modifies it, that is the bug.
#
#   test-switch.sh [--dsh-home /data] [--profile web]
#
# STATE-AGNOSTIC BY DESIGN. An earlier version hardcoded "expect 1 insert after
# revert", which is only true when the live profile still uses the insert form.
# Once the switch was applied for real, that assertion failed against reality.
# This version records the starting state and asserts a return to it, so it is
# correct both before and after the switch.
#
# Four real bugs were caught here rather than in production:
#   1. `COUNT=$(grep -c ... || echo 0)` produced "0\n0", so a clean switch
#      reported FAIL.
#   2. Backups were taken unconditionally, so --revert snapshotted the already
#      stripped file and then "restored" nothing, leaving the menu unmounted.
#   3. The insert removal stopped at the first name match, orphaning the sibling
#      `name:` line. On one instance YAML silently absorbed the stray key into
#      the preceding mapping; on another it hard-failed the parse. Checking only
#      `id:` lines passed the whole time -- hence the whole-name check below.
#   4. A missing pyyaml silently reported "ok" for the YAML check. A verification
#      that did not run must never look like one that passed.

set -uo pipefail

DSH_HOME=/data
PROFILE=web
HERE="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
SWITCH="$HERE/switch-to-bundle.sh"

while [ $# -gt 0 ]; do
  case "$1" in
    --dsh-home) DSH_HOME="$2"; shift 2 ;;
    --profile)  PROFILE="$2";  shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

LIVE="$DSH_HOME/profiles/$PROFILE"
[ -f "$LIVE/package.json" ] || { echo "no live profile at $LIVE" >&2; exit 1; }
[ -x "$SWITCH" ] || { echo "switch-to-bundle.sh not executable at $SWITCH" >&2; exit 1; }

SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT
mkdir -p "$SCRATCH/profiles/$PROFILE"
cp -a "$LIVE/package.json" "$LIVE/cordis.patch.yml" "$SCRATCH/profiles/$PROFILE/"

# Live's own state, captured before the scratch is normalized -- section 4
# asserts live is unchanged, so it must compare against live's own count, not
# the normalized baseline's.
LIVE_MENTIONS_BEFORE="$(grep -c 'dsh-applications' "$LIVE/cordis.patch.yml" 2>/dev/null || true)"

SCRATCH_PKG="$SCRATCH/profiles/$PROFILE/package.json"
SCRATCH_PATCH="$SCRATCH/profiles/$PROFILE/cordis.patch.yml"

FAIL=0
ok()   { printf '  \033[32mok\033[0m   %s\n' "$*"; }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$*"; FAIL=1; }
skip() { printf '  \033[33mskip\033[0m %s\n' "$*"; }

in_bundles() {
  python3 -c "
import json,sys
b=json.load(open(sys.argv[1]))['dsh']['profile']['bundles']
print('yes' if 'dsh-applications' in b else 'no')" "$SCRATCH_PKG"
}
# Count the plugin NAME, not just `id:` -- the orphan bug preserved the name
# while dropping the id, so an id-only check stayed green on a corrupt file.
mentions()  { grep -c 'dsh-applications' "$SCRATCH_PATCH" 2>/dev/null || true; }
id_rows()   { grep -c 'id: *dsh-applications' "$SCRATCH_PATCH" 2>/dev/null || true; }

yaml_parses() {
  node -e "
const fs=require('fs'), path=require('path');
const pnpm='/opt/dsh/node_modules/.pnpm';
const d=fs.readdirSync(pnpm).find(x=>x.startsWith('yaml@'));
if(!d){ console.error('noyaml'); process.exit(2); }
const YAML=require(path.join(pnpm,d,'node_modules','yaml'));
try{ YAML.parse(fs.readFileSync(process.argv[1],'utf8')); }
catch(e){ console.error(e.message); process.exit(1); }
" "$1" 2>/dev/null
}

# ---- normalize the scratch to the INSERT form -------------------------------
# The round trip only exists between the two forms: insert -> bundle -> insert.
# Once the live profile has been switched, it is ALREADY bundle-form, so
# reverting it changes state rather than restoring it -- the first version of
# this test failed for exactly that reason. So build the pre-switch shape
# explicitly: drop our plugin from bundles, and append the insert the plugin
# now carries. The test then exercises a real transition either way.
PLUGIN_PATCH="$HERE/../cordis.patch.yml"
[ -f "$PLUGIN_PATCH" ] || { echo "missing $PLUGIN_PATCH" >&2; exit 1; }

python3 - "$SCRATCH_PKG" <<'PYEOF'
import json, sys
pkg = sys.argv[1]
d = json.load(open(pkg))
b = d["dsh"]["profile"]["bundles"]
if "dsh-applications" in b:
    b.remove("dsh-applications")
    json.dump(d, open(pkg, "w"), indent=2)
    open(pkg, "a").write("\n")
PYEOF

if ! grep -q 'id: *dsh-applications' "$SCRATCH_PATCH"; then
  printf '\n' >> "$SCRATCH_PATCH"
  cat "$PLUGIN_PATCH" >> "$SCRATCH_PATCH"
fi
cp -a "$SCRATCH_PATCH" "$SCRATCH/baseline.patch.yml"

# ---- record the starting state ---------------------------------------------
START_BUNDLES="$(in_bundles)"
START_MENTIONS="$(mentions)"
echo "Round-trip test against a copy of $LIVE"
echo "  normalized baseline: in_bundles=$START_BUNDLES mentions=$START_MENTIONS"
[ "$START_BUNDLES" = "no" ] || bad "could not normalize to insert form"
[ "$START_MENTIONS" != "0" ] || bad "baseline has no insert to remove"
echo

# ---- 1. switch --------------------------------------------------------------
echo "1. switch"
"$SWITCH" --dsh-home "$SCRATCH" --profile "$PROFILE" >/dev/null 2>&1
RC=$?
[ "$RC" = "0" ] && ok "switch exited 0" || bad "switch exited $RC"
[ "$(in_bundles)" = "yes" ] && ok "listed in bundles" || bad "NOT listed in bundles"
[ "$(id_rows)" = "0" ] && ok "profile insert removed" || bad "profile insert still present ($(id_rows))"
[ "$(mentions)" = "0" ] && ok "no orphaned lines (name fully gone)" \
  || bad "$(mentions) mention(s) of the plugin remain -- orphaned row left behind"

if yaml_parses "$SCRATCH_PATCH"; then
  ok "patch file parses as YAML"
else
  RC=$?
  if [ "$RC" = "2" ]; then skip "YAML check (no parser found)"; else bad "patch file does NOT parse -- overlay would fail to load"; fi
fi

# ---- 2. revert --------------------------------------------------------------
echo
echo "2. revert"
"$SWITCH" --dsh-home "$SCRATCH" --profile "$PROFILE" --revert >/dev/null 2>&1
RC=$?
[ "$RC" = "0" ] && ok "revert exited 0" || bad "revert exited $RC"
[ "$(in_bundles)" = "$START_BUNDLES" ] && ok "bundles back to starting state ($START_BUNDLES)" \
  || bad "bundles=$(in_bundles), expected $START_BUNDLES"
[ "$(mentions)" = "$START_MENTIONS" ] && ok "patch file back to starting state ($START_MENTIONS mentions)" \
  || bad "mentions=$(mentions), expected $START_MENTIONS -- revert did not restore"

# ---- 3. round trip is faithful ---------------------------------------------
echo
echo "3. round trip is faithful"
if diff -q "$SCRATCH_PATCH" "$SCRATCH/baseline.patch.yml" >/dev/null; then
  ok "patch file byte-identical to the pre-switch baseline"
else
  bad "patch file differs from the baseline"; diff "$SCRATCH_PATCH" "$SCRATCH/baseline.patch.yml" | head -10 | sed 's/^/       /'
fi
python3 - "$SCRATCH_PKG" <<'PY'
import json, sys
b = json.load(open(sys.argv[1]))['dsh']['profile']['bundles']
ok = 'dsh-applications' not in b
print(('  \033[32mok\033[0m   ' if ok else '  \033[31mFAIL\033[0m ') + 'bundle list back to baseline (plugin absent)')
sys.exit(0 if ok else 1)
PY
[ $? = 0 ] || FAIL=1

# ---- 4. the live profile was never written to -------------------------------
echo
echo "4. the live profile was never written to"
if [ "$(grep -c 'dsh-applications' "$LIVE/cordis.patch.yml" 2>/dev/null || true)" = "$LIVE_MENTIONS_BEFORE" ]; then
  ok "live patch file untouched ($LIVE_MENTIONS_BEFORE mentions)"
else
  bad "live patch file changed -- investigate before anything else"
fi

echo
if [ "$FAIL" = "0" ]; then
  echo "All checks passed. Safe to apply with: $SWITCH --dsh-home $DSH_HOME --profile $PROFILE"
else
  echo "FAILURES above -- do not apply the switch."
fi
exit "$FAIL"
