#!/usr/bin/env bash
#
# docker-computer — self-install / repair and capability check.
#
# WHY THIS EXISTS
#   The skill ships four things that must agree with each other:
#     1. bin/computer          the CLI the agent runs
#     2. apps.yaml             the app allowlist
#     3. image/Dockerfile      the box image the CLI launches
#     4. lib/ + package.json   the dsh-applications GUI package (at the root)
#   Items 1-3 need no wiring: the agent reads SKILL.md and runs bin/computer.
#   Item 4 DOES: it is an npm package that must be declared by the *profile*
#   and referenced from cordis.patch.yml, or the Applications menu never mounts.
#
#   That wiring used to be a hand-made symlink in the profile's node_modules.
#   `pnpm install` prunes undeclared node_modules content, so any routine
#   profile rebuild deleted the menu with no error. This script declares the
#   dependency instead, so `pnpm install` recreates it rather than removing it.
#
#   Why `link:` and not `file:`: this profile sets nodeLinker: hoisted, under
#   which `file:` installs a *hardlinked copy*. Edits still reach it via the
#   hardlink, but newly added files do not, and any atomic-replace editor breaks
#   the link. `link:` always symlinks, so the plugin stays live-editable.
#
# IDEMPOTENT. Safe to re-run. Changes nothing that is already correct.
#
# USAGE
#   bin/install.sh [install|verify] [--profile NAME] [--dsh-home DIR]
#     install (default)  wire the plugin, build the image if absent, then verify
#     verify             report state only; writes nothing, exits non-zero on fault
#
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"
PLUGIN_DIR="$SKILL_DIR"
IMAGE_DIR="$SKILL_DIR/image"
IMAGE_TAG="dsh-computer:bookworm"
PLUGIN_NAME="dsh-applications"
# The skill's own name, from SKILL.md frontmatter -- this is the directory
# name in the skill root, not the package name.
SKILL_NAME="$(sed -n 's/^name:[[:space:]]*//p' "$SKILL_DIR/SKILL.md" | head -1 | tr -d '"' | tr -d "'")"
SKILL_NAME="${SKILL_NAME:-docker-computer}"

MODE="install"
DSH_HOME="${DSH_HOME:-/data}"
PROFILE="${DSH_PROFILE:-web}"

while [ $# -gt 0 ]; do
  case "$1" in
    install|verify) MODE="$1"; shift ;;
    --profile) PROFILE="${2:?}"; shift 2 ;;
    --dsh-home) DSH_HOME="${2:?}"; shift 2 ;;
    -h|--help) sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
PATCH_FILE="$PROFILE_DIR/cordis.patch.yml"

ok()   { printf '  \033[32mok\033[0m   %s\n' "$*"; }
warn() { printf '  \033[33mwarn\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$*"; }
step() { printf '\n%s\n' "$*"; }

FAILED=0

# ---------------------------------------------------------------- preconditions
step "Preconditions"
[ -f "$PLUGIN_DIR/package.json" ] || { bad "package manifest missing: $PLUGIN_DIR/package.json"; exit 1; }
ok "skill at $SKILL_DIR"

if [ -d "$PROFILE_DIR" ]; then
  ok "profile '$PROFILE' at $PROFILE_DIR"
else
  bad "profile directory not found: $PROFILE_DIR"
  echo "       Pass --profile NAME / --dsh-home DIR, or create the profile first:"
  echo "       dsh rescue --from-default-profile web"
  exit 1
fi

if [ ! -f "$PATCH_FILE" ]; then
  warn "no cordis.patch.yml yet; one will be created"
fi

# --------------------------------------------------------- 1. declare the dep
step "1. Declare $PLUGIN_NAME in the profile"

# Relative link path, so the profile stays portable if DSH_HOME moves.
REL_PATH="$(realpath --relative-to="$PROFILE_DIR" "$PLUGIN_DIR")"
PKG_JSON="$PROFILE_DIR/package.json"

if [ ! -f "$PKG_JSON" ]; then
  bad "no package.json in $PROFILE_DIR"; exit 1
fi

CURRENT="$(node -e "
  try { const p=require('$PKG_JSON');
    console.log((p.dependencies&&p.dependencies['$PLUGIN_NAME'])||''); }
  catch(e){ console.log('__PARSE_ERROR__'); }" 2>/dev/null || echo '__PARSE_ERROR__')"

if [ "$CURRENT" = "__PARSE_ERROR__" ]; then
  bad "package.json is not valid JSON — refusing to edit"; exit 1
fi

WANT="link:$REL_PATH"
if [ "$CURRENT" = "$WANT" ]; then
  ok "already declared: $PLUGIN_NAME = $WANT"
elif [ "$MODE" = "verify" ]; then
  bad "declared as '${CURRENT:-<absent>}', expected '$WANT'"
  FAILED=1
else
  cp -a "$PKG_JSON" "$PKG_JSON.pre-install-$(date +%Y%m%d-%H%M%S)"
  node -e "
    const fs=require('fs'), f='$PKG_JSON';
    const p=JSON.parse(fs.readFileSync(f,'utf8'));
    p.dependencies=p.dependencies||{};
    p.dependencies['$PLUGIN_NAME']='$WANT';
    // Keep dependency keys sorted so re-running never churns the file.
    p.dependencies=Object.fromEntries(Object.keys(p.dependencies).sort().map(k=>[k,p.dependencies[k]]));
    fs.writeFileSync(f, JSON.stringify(p,null,2)+'\n');
  "
  ok "declared $PLUGIN_NAME = $WANT   (backup written)"
fi

# ----------------------------------------------------- 2. materialize the link
step "2. Materialize the link in node_modules"
LINK="$PROFILE_DIR/node_modules/$PLUGIN_NAME"

if [ "$MODE" = "install" ]; then
  if command -v pnpm >/dev/null 2>&1; then
    # CI=true because this script is non-interactive BY DESIGN. Without it pnpm
    # aborts with ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY when it decides the
    # modules directory needs a full re-link -- which is what happened on
    # a second deployment, 2026-10-11. It aborts rather than proceeding, so nothing is
    # destroyed, but the dependency is never materialized.
    ( cd "$PROFILE_DIR" && CI=true pnpm install --ignore-scripts >/tmp/dsh-install-pnpm.log 2>&1 ) \
      && ok "pnpm install completed" \
      || { warn "pnpm install failed; see /tmp/dsh-install-pnpm.log"; }
  else
    warn "pnpm not on PATH; falling back to a direct symlink"
  fi
fi

# Fallback / assertion: ensure the symlink exists and points at our plugin.
if [ -L "$LINK" ] && [ "$(readlink -f "$LINK")" = "$(readlink -f "$PLUGIN_DIR")" ]; then
  ok "$PLUGIN_NAME -> $(readlink "$LINK") (symlink)"
elif [ "$MODE" = "verify" ]; then
  bad "$PLUGIN_NAME is not a symlink to $PLUGIN_DIR"
  [ -e "$LINK" ] && echo "       present as: $(stat -c %F "$LINK" 2>/dev/null) -> $(readlink -f "$LINK")"
  FAILED=1
else
  mkdir -p "$PROFILE_DIR/node_modules"
  rm -rf "$LINK"
  # The link lives INSIDE node_modules, so its relative target needs one more
  # "../" than the path written into package.json (which resolves from the
  # profile dir). Using $REL_PATH here produces a link that resolves to nothing,
  # silently -- caught in the field, 2026-10-11.
  REL_FROM_NM="$(realpath --relative-to="$PROFILE_DIR/node_modules" "$PLUGIN_DIR")"
  ln -s "$REL_FROM_NM" "$LINK"
  # Verify rather than assume. A symlink that does not resolve is worse than
  # none: the menu mounts, and then every request fails.
  if [ "$(readlink -f "$LINK")" = "$(readlink -f "$PLUGIN_DIR")" ]; then
    ok "created symlink $PLUGIN_NAME -> $REL_FROM_NM"
  else
    bad "created a symlink that does NOT resolve ($REL_FROM_NM -> $LINK)"
    FAILED=1
  fi
fi

# A link that exists but resolves to nothing fails the whole install, not just
# the block above -- this catches a dangling link left by an earlier run.
if [ -L "$LINK" ] && [ ! -e "$LINK" ]; then
  bad "$PLUGIN_NAME is a DANGLING symlink -> $(readlink "$LINK")"
  FAILED=1
fi

# ------------------------------------------------- 2b. make the SKILL visible
step "2b. Link the skill into a skill root"

# The plugin and the skill ship in one package, but they are discovered by two
# different subsystems. node_modules/ satisfies the first and not the second:
# skills are found by scanning skill ROOTS, and a profile's node_modules is not
# one. (The list of roots IS configurable -- `customSkillDirs` -- but it lives in
# the agent PRESET config, not the profile, so it is not a profile-level toggle.)
# So: link this package into the user skill root, which every agent on the host
# sees. watchFollowSymlinks defaults to true, so the link is watched like a real
# directory and edits to SKILL.md take effect without a restart.
SKILL_ROOT="${DSH_HOME}/skills"
SKILL_LINK="$SKILL_ROOT/$SKILL_NAME"

if [ ! -d "$SKILL_ROOT" ]; then
  warn "no skill root at $SKILL_ROOT -- skipping the skill link"
  echo "       The plugin will mount, but the agent will not know the skill exists."
elif [ "$(readlink -f "$SKILL_LINK" 2>/dev/null)" = "$(readlink -f "$PLUGIN_DIR")" ]; then
  ok "skill already linked: $SKILL_LINK -> $PLUGIN_DIR"
elif [ -e "$SKILL_LINK" ] && [ ! -L "$SKILL_LINK" ]; then
  # A real directory here is a full copy, not our link. Overwriting it would
  # destroy whatever the operator put there.
  ok "a real skill directory already exists at $SKILL_LINK (left alone)"
  echo "       It is not a link to this package; update it separately if you"
  echo "       want this package's SKILL.md to be the one that loads."
elif [ "$MODE" = "verify" ]; then
  bad "skill not linked: $SKILL_LINK does not point at $PLUGIN_DIR"
  echo "       The plugin mounts, but the agent cannot see SKILL.md."
  FAILED=1
else
  [ -L "$SKILL_LINK" ] && rm -f "$SKILL_LINK"
  REL_SKILL="$(realpath --relative-to="$SKILL_ROOT" "$PLUGIN_DIR")"
  ln -s "$REL_SKILL" "$SKILL_LINK"
  if [ "$(readlink -f "$SKILL_LINK")" = "$(readlink -f "$PLUGIN_DIR")" ]; then
    ok "linked skill: $SKILL_LINK -> $REL_SKILL"
  else
    bad "created a skill link that does NOT resolve"
    FAILED=1
  fi
fi

# ----------------------------------------------------------------- 3. mount
step "3. Register the mount"

# Exactly one of two valid forms must be present; both at once double-mounts.
#   bundle form (preferred) -- `dsh-applications` in dsh.profile.bundles. The
#        plugin's own cordis.patch.yml supplies the row, the GUI Plugins panel
#        lists it, and it gets an on/off toggle. Needs a RESTART: bundles are
#        the composition root and are NOT covered by patchReload: live.
#   insert form (legacy)    -- a hand-appended `- insert:` in the profile patch.
#        Applies live, but is invisible to the Plugins panel with no toggle.
#        That invisibility is why the Applications menu could not be seen or
#        disabled from the GUI. Prefer the bundle form.
PROFILE_PKG="$PROFILE_DIR/package.json"

IN_BUNDLES=no
if [ -f "$PROFILE_PKG" ] && python3 -c "
import json,sys
b=json.load(open(sys.argv[1]))['dsh']['profile']['bundles']
sys.exit(0 if sys.argv[2] in b else 1)" "$PROFILE_PKG" "$PLUGIN_NAME" 2>/dev/null; then
  IN_BUNDLES=yes
fi

HAS_INSERT=no
if [ -f "$PATCH_FILE" ] && grep -q "id: *$PLUGIN_NAME" "$PATCH_FILE"; then
  HAS_INSERT=yes
fi

if [ "$IN_BUNDLES" = yes ] && [ "$HAS_INSERT" = yes ]; then
  bad "mounted TWICE — in dsh.profile.bundles AND as a profile insert"
  echo "       Remove one, or the plugin is instantiated twice."
  FAILED=1
elif [ "$IN_BUNDLES" = yes ]; then
  ok "declared as a bundle (Plugins panel lists it, with a toggle)"
elif [ "$HAS_INSERT" = yes ]; then
  warn "mounted via the legacy profile insert"
  echo "       Works, but the GUI Plugins panel will not list it and it has no"
  echo "       toggle. Migrate with:"
  echo "         $SKILL_DIR/bin/switch-to-bundle.sh --dsh-home $DSH_HOME --profile $PROFILE"
elif [ "$MODE" = "verify" ]; then
  bad "not mounted — neither in dsh.profile.bundles nor as a profile insert"
  FAILED=1
else
  [ -f "$PROFILE_PKG" ] && cp -a "$PROFILE_PKG" "$PROFILE_PKG.pre-install-$(date +%Y%m%d-%H%M%S)"
  python3 -c "
import json,sys
pkg, name = sys.argv[1], sys.argv[2]
d = json.load(open(pkg))
b = d['dsh']['profile'].setdefault('bundles', [])
if name not in b:
    b.append(name)
    json.dump(d, open(pkg,'w'), indent=2)
    open(pkg,'a').write('\n')
" "$PROFILE_PKG" "$PLUGIN_NAME"
  ok "added to dsh.profile.bundles"
  warn "RESTART REQUIRED — bundles are the composition root"
  echo "       patchReload: live does not cover this; the plugin's own"
  echo "       cordis.patch.yml supplies the mount row at boot."
fi

# ------------------------------------------------------------- 4. box image
step "4. Ensure the box image"
if ! command -v docker >/dev/null 2>&1; then
  bad "docker CLI not found — this skill cannot work here"
  FAILED=1
elif ! docker info >/dev/null 2>&1; then
  bad "docker daemon not reachable — the skill will not work here"
  echo "       (The skill's box launches containers. Without a daemon, the agent"
  echo "        would read SKILL.md and confidently believe it had a computer.)"
  FAILED=1
else
  ok "docker daemon reachable"
  if docker image inspect "$IMAGE_TAG" >/dev/null 2>&1; then
    ok "image $IMAGE_TAG present"
  elif [ "$MODE" = "verify" ]; then
    bad "image $IMAGE_TAG absent — run bin/install.sh"
    FAILED=1
  else
    echo "       building $IMAGE_TAG (first run only; a few minutes)"
    docker build -t "$IMAGE_TAG" "$IMAGE_DIR" >/tmp/dsh-image-build.log 2>&1 \
      && ok "image built" \
      || { bad "image build failed; see /tmp/dsh-image-build.log"; FAILED=1; }
  fi
fi

# ---------------------------------------------------------------- 5. verify
step "5. Verification"
if node /opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js --profile "$PROFILE" --dump-config 2>/dev/null \
     | grep -q "id: $PLUGIN_NAME"; then
  ok "profile composes and $PLUGIN_NAME is mounted"
else
  warn "could not confirm the mount via --dump-config"
  echo "       (Not fatal if the harness is running elsewhere; check the GUI sidebar.)"
fi

step "Result"
if [ "$FAILED" -eq 0 ]; then
  echo "  All checks passed. The Applications menu is mounted."
  if [ "$MODE" = "install" ] && [ "${IN_BUNDLES:-no}" = "yes" ]; then
    echo "  It is declared as a bundle, so it appears in the GUI Plugins panel with"
    echo "  a toggle. A RESTART is required for the mount to take effect — and if"
    echo "  this was a fresh install, one is needed anyway for the new dependency."
  else
    echo "  Already mounted; nothing further needed."
  fi
  echo "  Agent-facing usage: read SKILL.md, then run: bin/computer --help"
else
  echo "  One or more checks FAILED (see above). Do not assume the skill works."
  exit 1
fi
