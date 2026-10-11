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
pnpm add github:BluePointDigital/dsh-computer#v0.1.0

# 2. Register it as a bundle so the plugin mounts and appears in the Plugins panel
node -e '
  const fs=require("fs"), p="package.json", d=JSON.parse(fs.readFileSync(p));
  const b=d.dsh.profile.bundles; if(!b.includes("dsh-applications")) b.push("dsh-applications");
  fs.writeFileSync(p, JSON.stringify(d,null,2)+"\n");'

# 3. Build the box image (1.4 GB, from image/Dockerfile — not shipped as a binary)
bin/computer build

# 4. Verify end to end
bin/install.sh verify
```

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
- **Not yet verified:** using this package's own root as a `customSkillDirs` skill root, so that a
  git-dependency install alone surfaces `SKILL.md`. The discovery code accepts a loose `SKILL.md` at
  a root, but this path has not been demonstrated end-to-end — until it is, `SKILL.md` should be
  copied or symlinked into a skill root (`/data/skills/<name>/`).
- The image is **not** in this repository; build it from `image/Dockerfile`.

## License

MIT
