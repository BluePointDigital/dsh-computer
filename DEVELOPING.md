# Developing this repo

Two install shapes, one script. Knowing which one you are about to produce is the
whole game — they are not interchangeable, and `install.sh` silently switches
between them.

## Where this lives

This repo root **is** a DSH workspace: `/workspace/dsh-computer`, with a `.dsh/`
marker at the root. So a session started here resolves its own box identity
(`computer status` reports `dsh-computer-f78d205b`, distinct from the box belonging
to `Docker Testing`), and the `docker-computer` skill is available from it because
that skill is installed system-wide at `/data/skills/docker-computer`.

The repo root doubling as the workspace root means workspace-local state
(`.dsh-computer/`, `.dsh/`) lands beside the source, and both are gitignored.

This folder is inside the Syncthing tree, so source replicates to
the Windows peer — which is intended, since `node_modules` and the box home are
excluded by `/workspace/.stignore`.

## The two shapes

| | Production | Development |
|---|---|---|
| Profile specifier | `github:BluePointDigital/dsh-computer#v0.1.8` | `link:/path/to/checkout` |
| `node_modules/dsh-applications` | a fetched tarball | a **symlink** to your checkout |
| Edits take effect | only after a re-install | immediately (client half on page reload) |
| Reproducible | yes — pinned + integrity hash | no — whatever is on disk |
| How you get it | edit `package.json`, `pnpm install` | `bin/install.sh` from the checkout |

**`bin/install.sh` always produces the `link:` shape** (`WANT_LINK="link:$REL_PATH"`),
and it *refuses* to proceed when the profile declares a `github:` specifier.

> **The footgun:** running `bin/install.sh` from a checkout against a live profile
> **converts production into development**. That is fine on a scratch instance and
> wrong on one you care about. Read what it reports before accepting it.

## Releasing (the production path)

```bash
# 1. in the checkout: bump and commit
$EDITOR package.json          # version, e.g. 0.1.8 -> 0.1.9
git add -A && git commit -m "0.1.9: ..."
git tag -a v0.1.9 -m "0.1.9: ..."
git push origin main v0.1.9

# 2. on each instance: point the profile at the new tag
#    (currently olympus, director and dsh-damon)
$EDITOR /data/profiles/web/package.json     # #v0.1.8 -> #v0.1.9
pnpm install --no-frozen-lockfile

# 3. verify, do not assume
/data/skills/docker-computer/bin/computer apps list --json
```

A version bump is cheap; the install is a few seconds. **Prefer it over `link:` for
anything you intend to keep**, because a pinned tag is the only shape that survives
a `pnpm install` without the whole dependency being replaced.

## What needs a restart, and what does not

- **`lib/index.js` (server half) — restart.** It is loaded once at mount.
- **`lib/client.js` (client half) — page reload.** Bundle revisions derive from mtime/size.
- **`bin/computer` (the CLI) — nothing.** It is executed per invocation, read from disk.
- **`SKILL.md` — nothing.** The filesystem skill watches its roots.
- **`cordis.patch.yml` (patch layer) — restart, always.** `patchReload: "live"` is
  **inert** on 0.2.0-rc.2: the string occurs zero times across `/opt/dsh` and `hmr`
  is configured `root: []`.

## Where state lives

Application state (per-app VNC passwords) is at **`$DSH_HOME/.dsh-applications`**,
overridable with `COMPUTER_APPS_STATE`. It is deliberately **not** under the skill
directory: that resolves through a symlink into a pnpm-managed package, which any
`pnpm install` replaces wholesale and which silently deleted every password once.
Resolution falls back to the running container's `VNC_PASSWORD`, so a lost cache
self-heals instead of silently mismatching.

## Tests

```bash
bash test/apps-password.test.sh     # 12 checks: password resolution order
node test/proxy.test.mjs            # rewrites, gzip guard, SSE, real socket frames
npm test                          # deterministic installer + existing regressions
RUN_INSTALLER_SMOKE=1 node test/installer-browser.test.mjs  # isolated real UI/daemon
RUN_DESKTOP_SMOKE=1 node test/desktop.test.mjs   # optional real-browser integration
```

`bin/install.sh verify` checks the mount, the patch insert, the app catalog and the
daemon — run it after any layout change. A green check is a claim about what was
checked, not about what works; that distinction has cost this repo three bugs.
