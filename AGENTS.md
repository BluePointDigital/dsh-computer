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

## Before you claim something works

Both suites exist because verification, not code, was the source of every bug here:

```bash
bash test/apps-password.test.sh     # 12 checks: password resolution order
node plugin/test/proxy.test.mjs     # proxy: root-absolute URLs, redirects, cookies
```

A green check is a claim about what was checked, not about what works.
