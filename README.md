# dsh-computer

A stateful Linux computer for the [DeepSeek Harness](https://github.com/deepseek-ai) — a real Debian
box in a Docker container with a virtual display, Chromium, root-capable package installs, and a
persistent home directory.

This repository ships **two halves of one capability as a single package**:

| Half | What it is | How it lands |
|---|---|---|
| **The plugin** (`package.json`, `lib/`, `cordis.patch.yml`) | A DSH client+server plugin that puts an **Applications** menu in the Web GUI | `dsh.bundle.patch` — the profile lists the package as a bundle, and it appears in the Plugins panel with a toggle |
| **The skill** (`SKILL.md`, `bin/`, `image/`) | The agent-facing procedure that makes the capability *usable* | Discovered from a skill root as a loose `SKILL.md` |

The point of the single-package layout is that **one dependency delivers both**. A package installed
under a profile's `node_modules/` is simultaneously a bundle (for the plugin) and a valid skill root
(for the skill), so there is no separate copy step and no hand-appended config to drift out of sync.

## Install

```bash
# 1. Declare the dependency (pins a version)
cd /data/profiles/web
pnpm add github:BluePointDigital/dsh-computer#v0.1.2

# 2. Wire the rest: register the bundle, link the skill into the skill root,
#    build the box image if absent, then verify the whole stack.
bin/install.sh
```

`bin/install.sh` is idempotent and safe to re-run.

A restart is required after step 2: `dsh.profile.bundles` is the composition root, and
`patchReload: live` covers only the patch layer (`cordis.patch.yml`), not the bundle list.

`SKILL.md` is what makes the agent aware the capability exists — and `bin/install.sh verify` is what
stops it from *believing* it has a computer when dockerd is missing.

## Requirements

- A reachable Docker daemon (nested dockerd is fine)
- `node` >= 20, `pnpm`
- For the desktop/VNC half: a browser and, optionally, Tailscale for remote access

## Usage

```bash
bin/computer up            # create/start the box (idempotent)
bin/computer up --desktop  # ...and serve the display at http://<host>:<port>/vnc.html
bin/computer status        # container, display, ports, home size
bin/computer exec 'uname -a'
bin/computer sh            # shell inside
bin/computer apps          # the catalog the Applications menu renders
```

## Layout

```
package.json        the plugin manifest (name: dsh-applications) + dsh.bundle.patch
cordis.patch.yml    the bundle's mount row — the plugin's own declaration
lib/                plugin code: index.js (server), client.js (GUI), proxy.js
SKILL.md            the skill the agent reads
bin/computer        the CLI: up / exec / sh / status / apps / build
bin/install.sh      idempotent wiring + verification
bin/switch-to-bundle.sh   migrate a profile from a hand-appended insert to a bundle
bin/test-switch.sh  round-trip test for the above, against a copy of the profile
image/              Dockerfile + box provisioning scripts
```

## Notes on the bundle form

A profile can mount this plugin two ways, and **exactly one must be present** — both at once
instantiates it twice:

- **bundle form (preferred)** — the package is listed in `dsh.profile.bundles`; its own
  `cordis.patch.yml` supplies the mount row. The Plugins panel lists it and gives it a toggle.
- **insert form (legacy)** — a hand-appended `- insert:` in the profile's `cordis.patch.yml`.
  Applies live, but the panel cannot see it and it has no toggle.

`bin/switch-to-bundle.sh` migrates between them. It does both edits atomically, backs up first, and
refuses to leave the plugin mounted twice.

## Status / caveats

- **Verified:** the plugin mounts via the bundle form and appears in the Plugins panel; the box
  starts, serves its display, and runs commands; `bin/install.sh verify` passes.
- **How the skill reaches the agent:** skills are found by scanning skill *roots*, and a profile's
  `node_modules/` is not one — so a dependency install alone does not surface `SKILL.md`. The list of
  roots *is* configurable (`customSkillDirs`), and discovery accepts a loose `SKILL.md` at a root, so
  pointing it at this package would work — but that setting lives in the **agent preset** config
  (`preset-cordis`), not the profile, so it is not a profile-level toggle. `bin/install.sh` therefore
  links the package into the user skill root (`<dshHome>/skills/<skill-name>`), which every agent on
  the host sees. `watchFollowSymlinks` defaults to true, so the link is watched like a real directory.
- The image is **not** in this repository; build it from `image/Dockerfile`.

## License

MIT
