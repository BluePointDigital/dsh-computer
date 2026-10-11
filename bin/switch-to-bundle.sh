#!/usr/bin/env bash
# switch-to-bundle.sh — move dsh-applications from a hand-appended profile insert
# to a proper bundle, so the GUI's Plugins panel lists it (with a toggle) like
# every other plugin we install.
#
# WHY THIS IS ONE SCRIPT AND NOT TWO EDITS
# The bundle and the profile-level insert must change together. Either alone
# leaves the plugin mounted twice -- the bundle patch inserts the row and the
# profile insert inserts it again. So this does both, backs up first, and
# verifies the result is exactly one mount before declaring success.
#
# THIS NEEDS A RESTART. `dsh.profile.bundles` is the composition root, not the
# patch layer. HMR watches exact profile patch paths ("live profile patch files
# outside Cordis module roots"), so `patchReload: live` does NOT cover a bundles
# change -- it takes the fullReload path, which restarts the process. Expect the
# GUI to drop for ~10s.
#
#   switch-to-bundle.sh --dsh-home /data --profile web          # switch + verify
#   switch-to-bundle.sh --dsh-home /data --profile web --revert # go back

set -euo pipefail

DSH_HOME=/data
PROFILE=web
PLUGIN_NAME=dsh-applications
REVERT=0

while [ $# -gt 0 ]; do
  case "$1" in
    --dsh-home) DSH_HOME="$2"; shift 2 ;;
    --profile)  PROFILE="$2";  shift 2 ;;
    --revert)   REVERT=1; shift ;;
    -h|--help)  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
PKG="$PROFILE_DIR/package.json"
PATCH="$PROFILE_DIR/cordis.patch.yml"
STAMP="$(date +%Y%m%d-%H%M%S)"

ok()   { printf '  \033[32mok\033[0m   %s\n' "$*"; }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$*"; }
warn() { printf '  \033[33mwarn\033[0m %s\n' "$*"; }

[ -f "$PKG" ]   || { echo "no package.json at $PKG" >&2; exit 1; }
[ -f "$PATCH" ] || { echo "no cordis.patch.yml at $PATCH" >&2; exit 1; }

# Backups are taken ONLY on the switch path. Taking one here unconditionally was
# a real bug: on --revert the script would snapshot the already-stripped patch
# file, then "restore from the newest backup" and restore nothing. Caught by the
# round-trip test -- live profile unaffected.
if [ "$REVERT" != "1" ]; then
  # The loader tolerates a missing cordis.patch.yml, but JSON is unforgiving.
  cp -a "$PKG" "$PKG.pre-bundle-$STAMP"
  cp -a "$PATCH" "$PATCH.pre-bundle-$STAMP"
fi

if [ "$REVERT" = "1" ]; then
  python3 - "$PKG" "$PROFILE_DIR/cordis.patch.yml" "$PLUGIN_NAME" <<'PY' "$PATCH"
import json, sys, re
pkg, patch, name = sys.argv[1], sys.argv[2], sys.argv[3]
d = json.load(open(pkg))
b = d["dsh"]["profile"]["bundles"]
if name in b:
    b.remove(name)
    json.dump(d, open(pkg, "w"), indent=2)
    open(pkg, "a").write("\n")
    print(f"  removed {name} from bundles")
else:
    print(f"  {name} was not in bundles")
PY
  # A revert that strips the bundle but leaves the insert gone would unmount the
  # menu entirely -- the exact opposite of a revert. Restore the patch file from
  # the newest pre-switch backup so the prior, working mount comes back.
  NEWEST=$(ls -1t "$PATCH".pre-bundle-* 2>/dev/null | head -1)
  if [ -n "$NEWEST" ]; then
    cp -a "$NEWEST" "$PATCH"
    ok "restored the profile insert from $(basename "$NEWEST")"
  elif ! grep -q "$PLUGIN_NAME" "$PATCH"; then
    warn "no backup found and no insert present -- the menu will NOT mount"
    warn "re-run the switch instead, or re-add the insert by hand"
  fi
  ok "reverted (restart to apply)"
  exit 0
fi

# ---- 1. add to dsh.profile.bundles -----------------------------------------
python3 - "$PKG" "$PLUGIN_NAME" <<'PY'
import json, sys
pkg, name = sys.argv[1], sys.argv[2]
d = json.load(open(pkg))
prof = d["dsh"]["profile"]
b = prof.setdefault("bundles", [])
if name in b:
    print(f"  already listed in bundles")
else:
    b.append(name)
    json.dump(d, open(pkg, "w"), indent=2)
    open(pkg, "a").write("\n")
    print(f"  appended {name} to dsh.profile.bundles")
PY
ok "bundle declared"

# ---- 2. remove the profile-level insert (same step, or it mounts twice) -----
python3 - "$PATCH" "$PLUGIN_NAME" <<'PY'
import re, sys
patch, name = sys.argv[1], sys.argv[2]
src = open(patch).read()
# Drop the managed comment block plus the `- insert:` that follows it. The
# block is contiguous: comment lines, then `- insert:` and its indented rows.
lines = src.splitlines(keepends=True)
out, i, removed = [], 0, False
while i < len(lines):
    ln = lines[i]
    if ln.lstrip().startswith("- insert:") and not removed:
        # An insert item owns EVERY following indented line -- `- id:` AND its
        # sibling rows. An earlier version broke out of this walk as soon as the
        # name matched, which resumed the copy ON the sibling `name:` line and
        # left it orphaned in the file. That corrupted two live profiles:
        # One instance's YAML silently absorbed the stray key into the
        # preceding mapping (worse than an error -- it parsed clean), while
        # another landed at an invalid indent and hard-failed the whole overlay.
        # Consume to the end of the item, never to the first name match.
        j = i
        while j + 1 < len(lines) and lines[j + 1][:1] == " " and lines[j + 1].strip() != "":
            j += 1
        block = lines[i:j + 1]
        if any(name in b for b in block):
            # Walk back over the comment block that documents it.
            while out and (out[-1].lstrip().startswith("#") or out[-1].strip() == ""):
                out.pop()
            out.append("\n")
            i = j + 1
            removed = True
            continue
    out.append(ln)
    i += 1
if removed:
    open(patch, "w").write("".join(out))
    print("  removed the profile-level insert")
else:
    print("  no profile-level insert found for %s" % name)
PY
ok "insert removed"

# ---- 3. verify exactly one mount, before anyone restarts -------------------
echo
echo "  verifying (pre-restart, so still sourced from the insert):"
COUNT=$(grep -c "id: $PLUGIN_NAME" "$PATCH" 2>/dev/null) || COUNT=0
echo "    insert occurrences in patch file: $COUNT"
if [ "$COUNT" = "0" ]; then
  ok "patch file no longer inserts $PLUGIN_NAME"
else
  bad "patch file STILL inserts $PLUGIN_NAME -- would double-mount once the bundle loads"
  echo "       backups: $PKG.pre-bundle-$STAMP , $PATCH.pre-bundle-$STAMP"
  exit 1
fi

python3 - "$PKG" "$PLUGIN_NAME" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
b = d["dsh"]["profile"]["bundles"]
print("    bundles now:", ", ".join(b))
assert sys.argv[2] in b, "not in bundles"
PY

echo
ok "switched. RESTART REQUIRED -- bundles are composition, not patch layer."
echo "     Backups: $PKG.pre-bundle-$STAMP"
echo "              $PATCH.pre-bundle-$STAMP"
echo "     After restart, expect $PLUGIN_NAME under 'Installed' in the Plugins panel."
echo "     Revert with: $0 --dsh-home $DSH_HOME --profile $PROFILE --revert"
