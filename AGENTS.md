# dsh-computer — working notes for agents

This repo root is also a DSH workspace (`/workspace/dsh-computer`, `.dsh/` marker).
The `docker-computer` skill is installed system-wide at `/data/skills/docker-computer`,
so it is available here without being copied. Full detail in `DEVELOPING.md` and
`SKILL.md`; this file is the short version that matters before you touch anything.

## The one thing that will bite you

`bin/install.sh` **always** writes a `link:` dependency and **refuses** a `github:`
one (`WANT_LINK="link:$REL_PATH"`). Running it from a checkout against a live
profile therefore **converts production into development**. The deployed shape on
every instance is the pinned GitHub tag:

```
"dsh-applications": "github:BluePointDigital/dsh-computer#v0.1.8"
```

To deploy a change, use the release loop — never `install.sh` on a live instance:

```bash
# 1. here: bump version, commit, tag, push
# 2. per instance: repoint the tag in /data/profiles/web/package.json
#                  then: pnpm install --no-frozen-lockfile
```

## What needs a restart

| Changed | Effect |
|---|---|
| `lib/index.js` (server half) | needs a `dsh web` restart |
| `lib/client.js` (client half) | picked up on a **page reload** |
| `bin/computer` (CLI) | nothing — read from disk per invocation |
| `SKILL.md`, this file | nothing — the filesystem skill watches its roots |
| `cordis.patch.yml` (a patch layer) | **restart, always** — `patchReload: "live"` is inert on 0.2.0-rc.2 |

Never restart mid-turn.

## State

App state (per-app VNC passwords) lives at `$DSH_HOME/.dsh-applications`, never
under the skill directory — that resolves through a symlink into a pnpm-managed
package, which any `pnpm install` replaces wholesale and which silently deleted
every password once. Resolution falls back to the running container's
`VNC_PASSWORD`, so a lost cache self-heals.

New installed applications use the same private root for versioned registry,
progress journals and private env files. CLI and server share AppManager; agent
setup may prepare plans but must never approve/execute on the human's behalf.
Do not put credentials or the registry in a synced workspace/package directory.
Read INSTALLATION.md before altering installation/recovery behavior.

## Before you claim something works

The suites exist because verification, not code, was the source of every bug here:

```bash
bash test/apps-password.test.sh     # 12 checks: password resolution order
node test/proxy.test.mjs            # HTTP/JS rewrites, gzip guard, SSE, real WebSocket frames
npm test                          # all deterministic installer/proxy/CLI regressions
node test/host-mount-live.mjs       # real app served at a hostname root (skips if absent)
RUN_INSTALLER_SMOKE=1 node test/installer-browser.test.mjs  # isolated Add app → Docker → iframe
RUN_DESKTOP_SMOKE=1 node test/desktop.test.mjs   # optional: real Chromium + running desktop
```

`upgrade-route.test.mjs` mocks CLI/daemon responses but uses real HTTP/WebSocket
connections; it creates/deletes no containers and needs no Docker. The optional
`desktop.test.mjs` uses isolated headless Chromium inside an already-running
`dsh-app-desktop`, without touching its live browser or the harness.
`host-mount-live.mjs` attaches to an already-running app (default
`dsh-app-filebrowser`) and starts its own listener on an ephemeral port; it
creates nothing and skips loudly when the container is absent.

## Host-mounted apps (`webHost`)

Two ways to publish a web app, and the choice is not cosmetic. `/apps/web/<id>/`
is the default and needs nothing but a running DSH, but it only works for apps
that write their URLs as literals — an app that computes them at runtime keeps
calling the origin root, which is the harness, and looks broken while healthy.
`webHost: <name>` serves such an app at the root of its own name, where its
self-derived URLs are correct and **nothing needs rewriting**.

`lib/host-router.js` holds the pure decisions (normalize, index, exact-match);
`lib/host-listen.js` owns the listener. Both are unit-tested, and the load-bearing
assertion is that a root-absolute path reaches the app unchanged — under the path
mount that same request is the bug. If you ever find yourself wanting a rewrite
rule for a host-mounted app, the routing is wrong, not the app.

Two constraints worth knowing before changing this. `dsh-host-webserver` matches
by pathname only and its arbitrary-path seat is already held by the SPA server,
which is why this is a separate listener rather than a DSH route. And it binds
loopback by default because the harness has no login: widening `DSH_APPS_HOST_BIND`
widens what is reachable without passing whatever fronts the instance.

A green check is a claim about what was checked, not about what works.
