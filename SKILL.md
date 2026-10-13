---
name: docker-computer
# Block scalars, not plain scalars: a bare ": " anywhere in a description is
# illegal YAML and makes DSH drop the skill from the catalog *silently*.
description: >-
  Spin up and drive a stateful Linux "computer" inside a Docker container — a
  full Debian box with a virtual display, Chromium, and root-capable package
  installs. Use when a task needs a real machine rather than a single command:
  multi-step GUI work, installing software, persistent scratch state, or a
  desktop the user can watch.
whenToUse: >-
  A task needs state that outlives one command (installed packages, files, a
  running app), a GUI to drive or screenshot, or a sandbox to install arbitrary
  software into. Requires the Docker daemon to be reachable.
---

# Docker Computer

A machine, not a command. This runs **one named container you keep**, with a
bind-mounted home directory, a virtual display, and passwordless sudo inside.

Everything below was verified against the live box. Error strings are quoted
verbatim so they can be grepped when they reappear.

## Quick start

This skill is installed **system-wide at `/data/skills/docker-computer`**, so it is
available from every workspace. It resolves state from the directory it is
*invoked* from — the nearest ancestor containing a `.dsh` marker — so each
workspace gets its own box, container name, and home directory.

**On a box where this skill was just installed**, run `bin/install.sh` once. It
wires the GUI menu, builds the box image if absent, and reports whether Docker is
actually usable. If it reports missing capability, say so plainly rather than
proceeding — a box with no daemon is a box where this skill cannot work.

```bash
C=/data/skills/docker-computer/bin/computer

$C up                              # create + start (idempotent, ~5s)
$C exec 'uname -a; whoami'         # run anything inside
$C shot page.png                   # screenshot the display -> prints host path
$C up --desktop                    # ...plus a live viewer for the user
```

Then read the printed PNG path with the image reader. **Never report a GUI
result you have not looked at.**

## Command surface

| Command | Does |
|---|---|
| `up [--desktop] [--offline] [--no-password] [--cpus N] [--mem 4g] [--geometry WxH] [--port N]` | create/start the box; `--desktop` adds the viewer |
| `status` | container, display geometry, ports, home size |
| `boxes` | every box on the host, across all workspaces |
| `cdp` | element-level browser control (snapshot/click/fill/…) |
| `apps <cmd>` | machine-level application catalog — see *Applications* below |
| `exec <cmd...>` | run a shell command inside (via `bash -lc`) |
| `sh` | shell inside |
| `put <host> <box>` / `get <box> <host>` | copy files in / out |
| `shot [name.png]` | screenshot → prints host path |
| `click <x> <y> [btn]` / `type <text>` / `key <keysym>` | input |
| `windows` / `ps` / `log [n]` | inspect |
| `down` | stop, **keep everything** |
| `destroy` | remove container, **keep the home mount** |
| `build` | rebuild the image |

## The mental model: two layers of state

This is the thing to get right, and it is the whole reason this exists.

| Layer | Holds | `down`+`up` | `destroy` |
|---|---|---|---|
| **Bind mount** `<workspace>/.dsh-computer/home` → `/home/agent` | your files | survives | **survives** |
| **Container layer** `/usr`, `/etc`, `/tmp`, installed packages | `apt install`, running processes | survives | **lost** |

So: `down`/`up` is a reboot (state intact). `destroy` is a reimage (home intact,
software gone). Put anything you want to keep in `/home/agent`.

## Driving the GUI

The display is `:99` at 1440x900 by default, exported via `ENV DISPLAY` so it
reaches every `docker exec`. `openbox` runs as window manager.

Launch Chromium with the bundled helper, never bare `chromium`:

```bash
$C exec 'nohup box-chrome https://example.com >/tmp/chrome.log 2>&1 & sleep 10'
$C shot shot.png
```

`box-chrome` exists because HOME is a bind mount: Chromium's profile directory
**outlives the container**, and a `SingletonLock` left by a dead container makes
Chromium show a modal dialog instead of the page. Every screenshot then captures
that dialog. The helper clears the stale locks and pins `--user-data-dir`.

For non-browser apps: start them the same way (`nohup <app> &`), then `$C windows`
to confirm a window mapped before screenshotting.

## Traps (each one cost real time)

- **`sudo` works inside the box, not outside it.** In the box you're
  `agent` (uid 1000) with passwordless sudo — `sudo apt-get install` works, which
  is what makes this "a computer". On the *host* you have no capabilities at all
  (`NoNewPrivs: 1`, `CapEff: 0`). Do not confuse the two.
- **Never `pkill -f chromium` inside the box.** The pattern matches the
  `bash -lc '...chromium...'` shell running your command, so it kills itself
  mid-command: no output, no error, nothing happens. Use `pkill -x chromium`.
- **A stale X lock breaks every GUI call after a restart.** Symptom:
  `unable to open X server ':99'` and `Fatal server error: Server is already
  active for display 99`. `/tmp` survives `docker stop/start`, so the lock
  outlives its server. The entrypoint clears it — but if you see this after
  editing the image, that logic is what regressed.
- **`chmod +x` is not enough for a shebang script.** A build-context file at mode
  600 becomes **711** — executable but not *readable*, and a shebang script must
  be readable to exec. The container dies instantly with exit **126**,
  `/bin/bash: /entrypoint.sh: Permission denied`. Use `chmod 755` explicitly.
  (Symptom: `computer up` reports `(exited)`.)
- **`du` lies about screenshot size.** It reports allocated blocks, so a real
  92 KB PNG shows as `4.0K`. Use `ls -l` when size matters.
- **`--no-sandbox` is mandatory and prints a warning banner.** Chromium runs
  unprivileged; without the flag it aborts. The banner
  "You are using an unsupported command-line flag: --no-sandbox" at the top of
  screenshots is expected, not a failure.
- **`--shm-size=1g` is set by the wrapper.** The default 64 MB `/dev/shm` crashes
  Chromium on real pages.
- **A restarted app container has NO viewer.** `docker start` brings X back but
  *not* `x11vnc`/`websockify` — those are a second step (`box-desktop`). Stop then
  start an app and the port is published with nothing behind it: healthy
  container, dead viewer, `HTTP 000`, and it looks like the app broke. Every
  `apps up` path goes through `app_ensure_viewer`, which also **waits until the
  port is actually accepting** before returning — so a printed URL is a working
  URL, not a promise. (Reported by the user after `stop`/`start`; the first fix
  covered create but not restart.)
- **The box image has neither `ss` nor `netstat`.** `command -v ss` exits **127**.
  Detect listeners by reading `/proc/net/tcp`, where ports are hex (`6080` →
  `17C0`). A detector that silently finds nothing is worse than none: it
  degrades into restarting a *live* viewer on every `up` and drops the user's
  session mid-look.
- **`/tmp` survives `docker stop/start`**, so `/tmp/.computer-ready` can be a
  stale marker from the *previous* run. Probe X itself (`xdpyinfo`) rather than
  trusting that file alone — `box-desktop` started against a dead display exits
  **0** having done nothing.
- **`patchReload: "live"` is inert — every patch change needs a `dsh web` restart.**
  The profile declares it, but the string `patchReload` occurs **zero** times across
  `/opt/dsh` on 0.2.0-rc.2, and the `hmr` plugin is configured with `root: []`.
  `applyEntryPatches` runs at **boot**; plugin config is consumed in `apply()` at
  mount. So `install.sh`'s `cordis.patch.yml` insert — the thing that mounts the
  Applications menu — does **not** appear until the harness restarts. Verified
  2026-10-12 by grep. What *is* live: edits to skill files (the filesystem skill
  watches its roots) and the client half (reloaded on a page refresh, since client
  revisions derive from mtime/size).
- **App state lived inside the package, so `pnpm install` deleted it.** `APPS_STATE`
  defaults to `$SKILL_DIR/.state`, and `/data/skills/docker-computer` is a symlink
  into `node_modules/dsh-applications` -- a pnpm-managed directory that any install
  replaces *wholesale*. A routine v0.1.4 -> v0.1.5 upgrade wiped every
  `<id>.vnc-password` with no error. The viewer kept enforcing the password it was
  created with, the CLI reported `""`, and the GUI rendered a blank one. State now
  defaults to `${DSH_HOME:-$HOME}/.dsh-applications`, and resolution falls back to
  the **running container's `VNC_PASSWORD`** -- the daemon is the authority, the file
  is only a cache -- so a lost cache self-heals instead of silently mismatching.
  `test/apps-password.test.sh` covers the order. Never put state under `$SKILL_DIR`.
- **Apps are ON DEMAND by default — that is now policy, not accident.** `autostart`
  is **false** unless a catalog entry says otherwise, so most containers deliberately
  do *not* return after a harness reboot; `computer apps up <id>` is how they come
  back. Only `autostart: true` gets `--restart unless-stopped`.
- **Even so, never trust the restart policy.** After the 2026-10-11 reboot, apps
  that *were* `unless-stopped` still did not all return — only **1 of 5** came
  back; the rest sat at `Exited (255)` while `docker info` cheerfully reported
  `running=5`. `docker ps -a` was the only truthful source, and
  `computer apps up <id>` is the fix (which, via `app_ensure_viewer`, returns a
  desktop app *with* its viewer). Check `docker ps` after any reboot.
- **A catalog value read inside `$(...)` cannot fail the command.** `die` in a
  command substitution exits only the subshell, so the caller sees an empty
  string and — if empty means "unset" — silently takes a default. The first cut of
  `autostart` did exactly that: it printed the error and then reported
  `autostart: false` with exit status **0**. Catalog values are therefore
  validated once in `apps_validate`, from `apps_load`, in the main shell.
- **The dbus/GCM errors in `/tmp/chrome.log` are noise.** `Failed to connect to
  the bus` and `PHONE_REGISTRATION_ERROR` do not stop rendering.
- **Files come back as `node:node`.** The box's `agent` is uid 1000 to match the
  host user, so bind-mounted output is readable *and writable* by your own file
  tools. Images that run as root would give you `root:root` and break that.
- **Containers cannot see the host.** No `/data`, no session files, only the
  bind mount. That is mostly a feature.
- **Network is `bridge` by default** (needed to install packages). Use
  `--offline` for `--network none` on untrusted work. **Do not add
  `--network host` casually** — from inside, the bridge gateway reaches the DSH
  GUI's port.

## Security posture — read before using on untrusted input

- No `--privileged`. The only host path mounted is the home dir, which lives
  *inside* the session workspace, so the workspace sandbox still bounds it.
- Caps: `--cpus 2 --memory 4g --shm-size 1g` by default.
- **What the daemon can actually reach — CORRECTED.** The nested daemon runs as
  root *inside this container's user namespace*, so it can bind-mount any path
  **this container can see** (`/data`, the workspace, the home mount) — and nothing
  else. It cannot reach the host. Verified on the live box: `uid_map` is
  `0 165536 65536` (root here is unprivileged uid 165536 out there), `CapEff` is
  `0000000000000000` (zero capabilities), `Seccomp: 2` is active, no host block
  devices are visible, and there is no host `docker.sock`. The nested daemon's
  "host" *is* this container — `docker run -v /etc/hostname` reads our own hostname.
  An earlier version of this file claimed the daemon "can bind-mount any host path";
  that was wrong and led to bad reasoning about blast radius.
- **The blast radius still deserves respect, for a different reason.** `/data` holds
  profiles, credentials and the graph-memory database, the Chromium profile holds
  live logins, and the tailnet identity lives in this container. The escalation path
  is **container → tailnet → other machines**, not container → host root.
- **Desktop mode exposes a viewer to the tailnet.** It is bound to the tailscale
  address only, password-protected, and the raw RFB port never leaves loopback —
  but it is a real remote desktop. Do not enable it on an untrusted network.
- The box is disposable by design — when in doubt, `destroy`.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `up` reports `(exited)` | entrypoint not executable (126) | `chmod 755` in the Dockerfile |
| `unable to open X server ':99'` | stale X lock after restart | entrypoint clears it; rebuild |
| Screenshot is a "profile in use" dialog | stale Chromium `SingletonLock` | use `box-chrome` |
| "Restore pages?" bubble covers the page | Chromium killed without a clean shutdown | `box-chrome` passes `--hide-crash-restore-bubble` |
| Command returns nothing at all | `pkill -f` matched its own shell | use `pkill -x` |
| Screenshot nearly blank | window never mapped, or app died | `$C windows`; read `/tmp/<app>.log` |
| CJK renders as boxes | missing CJK fonts | image ships `fonts-noto-cjk` |

## Desktop mode — give the user eyes and hands

`up --desktop` serves **the same `:99` display the agent drives**, via x11vnc +
websockify + noVNC. It is deliberately *not* a second machine: whatever you click,
the user sees live, and either side can drive. Verified end to end.

```bash
$C up --desktop          # prints the viewer URL and the password
#   viewer    : http://100.76.116.37:6080/vnc.html
#   password  : <generated once, saved to .dsh-computer/vnc-password>
```

The viewer is published on **two** addresses so it is reachable either way:
`127.0.0.1` (for a port-forward) and the **tailscale address** — never `0.0.0.0`.
The raw RFB port 5900 stays **loopback-only**, and the password is enforced end to
end (the server offers security type `2` and no "None"). Re-run `up --desktop` to
bring the viewer back after a restart. `--no-password` disables auth; only on a
trusted tailnet.

For a real TLS link rather than a raw IP, put it behind Tailscale Serve **on its
own port** so it cannot disturb anything already on 443:

```bash
sudo tailscale serve --bg --yes --https=8443 http://127.0.0.1:6080
# -> https://<node>.<tailnet>.ts.net:8443/vnc.html   (Let's Encrypt cert)
sudo tailscale serve --https=8443 off                # to undo
```

Requires root (or `tailscale set --operator=$USER` once). Tailscale Serve needs
noVNC at the **root path** — do not use `--set-path`, or the WebSocket URL
computed by noVNC will not resolve.

## Element-level control — use CDP, not coordinates

`click <x> <y>` is pixel-based. It has no idea what it is clicking, so a layout
shift or a late paint hits the wrong element and **fails silently** — you get back
a plausible screenshot and no error. That is fine for browsing and unacceptable for
anything that spends money or mutates state.

`computer cdp` addresses elements by role/name/text over the DevTools Protocol
instead, against **the same browser the human watches over VNC**:

```bash
$C cdp setup                    # once per container: Node 20+ and playwright-core
$C cdp start                    # relaunch Chromium with CDP (opt-in per launch)

# reads — no flag
$C cdp snapshot                 # ARIA tree: roles + accessible names. Start here.
$C cdp rows                     # table rows as pipe-delimited text
$C cdp text | links | net       # innerText | hrefs | XHR/fetch the page made
$C cdp goto <url> | url | back | tabs

# mutations — deliberately gated
$C cdp --write click 'role=button[name="Sign in"]'
$C cdp --write fill  'role=textbox[name="Email"]' "me@example.com"
```

**Reads are free; `click`/`fill`/`press`/`eval` require `--write`** (or
`COMPUTER_CDP_ALLOW_WRITE=1`). Pointed at a live ad account that turns "click the
wrong thing" from a silent action into a deliberate one. It is a speed bump, not
a sandbox — `eval` runs arbitrary page JS and is gated for exactly that reason.

`net` reads the Resource Timing buffer, so it sees calls made *before* it ran —
use it to confirm an action actually reached the server instead of trusting that
the UI looked right.

Measured difference, same page:

| | `click <x> <y>` | `cdp click <selector>` |
|---|---|---|
| Target missing | exit 0 — **silent** | **non-zero** — says it missed |
| Target off-screen | scroll, re-screenshot, re-estimate | auto-scrolls; no screenshot |
| After a layout shift | clicks whatever moved there | re-resolves the element |
| Screenshot needed first | yes | no |

Notes worth keeping:

- The CDP endpoint is **loopback inside the box** — no new published port.
- `playwright-core` drives the Chromium already in the image, so no second
  browser is downloaded.
- `cdp setup` puts Node into `/usr/local`, which is **not** the bind mount:
  re-run after `docker rm`. `cdp start` self-heals by calling it if missing.
- `links` prints the **raw href attribute**, not resolved `a.href` — the resolved
  form does not match `a[href="..."]` in a selector.

**The real cost is coordination, not capability.** There is one display and one
cursor. If the user is driving, your clicks fight theirs, and a resize or a window
the user moves invalidates coordinates you computed a moment ago. Announce when
you take the wheel, and `shot` before you act rather than trusting stale state.

## Applications — the machine-level catalog

`computer up` gives **one workspace** a box. `computer apps` runs **the machine's**
applications: a catalog of launchable containers that belongs to no workspace.

The split is deliberate. Which applications exist and which are running is a
property of the *machine*, not of one project — so the catalog lives beside this
skill and per-app state lives in Docker, which is the registry of record.
`apps list` is a view over `docker ps` filtered by label, so there is no second
state file to drift. (This is the one part of the skill that is not
workspace-resolved, and it should stay that way.)

```bash
$C apps list                 # catalog + live state
$C apps up desktop           # launch; prints the viewer URL + password
$C apps status desktop       # EFFECTIVE posture, read back from the daemon
$C apps exec desktop bash    # shell inside a running app
$C apps down desktop         # stop, keep state
$C apps rm desktop           # remove container, keep the state volume
$C apps discover             # local images not yet catalogued
```

Shipped: `desktop` (full Debian desktop + viewer on :6081), `shell` (minimal
Debian with a persistent home), `whoami` and `nginx` (HTTP dashboards, proxied
same-origin at `/apps/web/<id>/`).

### Apps are on demand, unless you say otherwise

`autostart` defaults to **false**: a container is expected to wait for
`computer apps up <id>`, not to resurrect itself. `autostart: true` opts one in
deliberately, and is the only thing that yields `--restart unless-stopped`. The
policy is re-bound on every `apps up` via `docker update`, so editing the catalog
takes effect on the next `up` rather than only at creation. An unparseable value
is an error — see the validation trap above for why that needed its own pass.

### The safety design *is* the schema

`apps up` takes an app id and **nothing else** — no image name, no docker flags.
The catalog has no field for `--privileged`, `--network host`, `--cap-add`,
`--device`, or a host mount, so those are not *rejected*, they are
**unrepresentable**.

Being precise, because the loose version of this claim is wrong: the parser is
fail-closed on **structure** (a line that is not `key: value` is an error, never
skipped), but it does not gatekeep key *names* — an unrecognised key is carried
through and simply never read. That is safe only because the launcher's flag set
is fixed, so an unknown key has no path to becoming a docker argument. The safety
comes from the fixed `run` invocation, not from the parser's suspicion.

Every launch is also pinned: `--security-opt no-new-privileges`, `--pids-limit
2048`, cpus/memory/shm caps, and viewers bound to **loopback + tailnet only**
(`0.0.0.0` is not expressible either). Persistent state is a **named volume**
(`dsh-app-<id>-home`), never a host path.

Verified: `apps rm` → `apps up` retains everything written to `/home/agent`, and
`apps status` reports the daemon's real posture (`privileged: false`,
`capadd: []`, `binds: [dsh-app-shell-home:/home/agent]`) rather than what we
intended to pass.

### Ports

`6080` belongs to the workspace box (`up --desktop`), so app viewers use
**6081–6099**. Two viewers on one port fail quietly: the container starts, the
port shows as published, and nothing answers.

### Adding an app

Use **Applications → Add app**. Choose a recipe (HTTP Echo, Nginx, Linux Desktop),
prepare an Advanced single-container plan, or open a dedicated setup conversation.
The conversation opens with a draft, not an auto-sent request. An agent may research
and **prepare** a plan; it must not approve/execute it on the user's behalf.

The UI and `computer apps` share AppManager. Definitions, jobs and credentials are
stored under `COMPUTER_APPS_STATE` (default `$DSH_HOME/.dsh-applications`), outside
node_modules and synced workspace. Existing operator `apps.yaml` remains a legacy
allowlist; new installed ids may not override it. Do not edit the package catalog
to install new apps.

Prepare a plan through stdin (do not include credentials in a chat or source file):

```bash
printf '%s' '{"plan":{"id":"my-web","name":"My web","image":"nginx:1.28-alpine","webPort":80}}' | computer apps prepare
computer apps jobs
```

The returned review includes an image content id and approval hash. **Stop and ask
the human to approve in Applications → Add app.** Explicit operator CLI approval
is also supported: `computer apps approve <job-id> <hash> --trust-publisher`, then
`computer apps run <job-id>`. Agent-generated text is not approval.

Supported plan fields: id/name/description, image with tag or digest, webPort,
webPath, canonical webSockets/webRewrite arrays, integer cpus/memoryMb/shmMb,
volumes as `[{"target":"/data"}]`, command argv array, env object, viewer/localImage
booleans, and autostart (false by default). Unknown fields are rejected. No host
mounts, arbitrary Docker flags, added capabilities, devices or host networking.
New managed apps publish **no host ports**; the embedded proxy reaches the bridge.
Docker default capabilities/outbound networking remain. Only trusted publisher
code should be embedded: same-origin app JavaScript is not isolated from DSH.

Preparing review may download an image. Container creation/start happens only
after approval. Images declaring VOLUME directories must list those targets in
the plan; no unreviewed anonymous volume is accepted. The installer pins reviewed
image content, checks web readiness, and rolls back only its operation-owned
container on failure. A ready web endpoint is not proof of every SPA route/socket;
verify the embedded UI before reporting success.

Progress survives requests in `computer apps jobs`. If a worker is interrupted,
`computer apps recover` or **Recover interrupted installs** cleans only owned
partial containers and marks pending work failed. Nothing silently resumes.
Uninstall keeps named data volumes/images, deletes saved environment values, and
never affects another app. Reinstallation uses fresh operation-owned volumes;
retained data is not silently remounted. Restoring retained data is an operator
follow-up, not currently an in-panel volume migration feature.

### The GUI menu — plugin `dsh-applications`

`lib/` + `package.json` at this skill's root are a DSH client+server plugin that puts the catalog in
the Web GUI's left sidebar: an **Applications** entry that swaps the main column
for a panel listing every app, with Launch / Stop / Remove and an embedded live
viewer. Verified end to end — the embedded view renders a live desktop from a
separate container inside the DSH main panel.

It is a two-slot registration, which is all the layout asks for:

| Slot | Kind | Contributes |
|---|---|---|
| `sidebar.panellist` | list | the icon + label. The sidebar owns the button and calls `ctx.layout.selectPanel(id)` itself |
| `main` | keyed | the panel body, under the same `id`/`key` |

The server half serves `/apps/api` over `computer apps`:

```
GET  /apps/api/list      catalog + live state
POST /apps/api/action    { action: up|down|rm, id }
```

Design notes worth keeping:

- **The route is a thin wrapper, not a second implementation.** It knows no
  images; the only caller-supplied value that reaches a subprocess is an app id,
  shape-checked and then re-validated by the CLI against `apps.yaml`. `execFile`
  with an argv array, never a shell.
- **Gate with `ctx.connection.requestRejection(req)`**, not a hand-rolled fence.
  It applies the Host/Origin fence *and* browser authentication. A local fence
  left this the only route in the app that answered without a session.
- The client half is **hand-written** in the loader's bundle format
  (`window.__ModuleLoader__.load({ id, factory })`) using `createElement` — no
  bundler needed. The host supplies `require` for the platform module table
  (React included).
- Client bundle revisions derive from mtime/size, so an edited client half is
  picked up on a **page reload**; the server half needs a DSH restart.
- The embedded viewer is given the per-app VNC password so it connects without a
  prompt. Applications stay inside DSH; there is no New tab action or automatic
  published-origin fallback.

Install — one idempotent command:

```bash
/data/skills/docker-computer/bin/install.sh          # wire + build + verify
/data/skills/docker-computer/bin/install.sh verify   # report only, writes nothing
```

It declares the plugin in the profile as a `link:` dependency, materializes the
symlink, appends the `cordis.patch.yml` insert if absent, builds the box image if
absent, then verifies. Re-running changes nothing (no churn, no spurious backups).

**Why not a hand-made symlink.** It used to be one (`ln -sfn ...`), which worked
until any `pnpm install` — that prunes *undeclared* `node_modules` content, so a
routine profile rebuild deleted the menu **with no error at all**. Declared, it is
recreated instead of removed. Verified live: the same install pass that added this
dependency also pruned `dsh-memento`, an undeclared leftover of exactly that kind.

**Why `link:` and not `file:`.** This profile sets `nodeLinker: hoisted`, under
which `file:` installs a hardlinked *copy* — in-place edits still reach it, but
newly added files do not, and any atomic-replace editor breaks the link. `link:`
always symlinks, so `lib/*` stays live-editable.

**The tradeoff, and the net under it.** `link:` does not validate its target: point
it at a missing skill and pnpm exits **0** leaving a *dangling* symlink, where
`file:` would have failed loudly. `install.sh verify` is that net — it resolves the
symlink, checks the insert, confirms the daemon and image, and exits non-zero with
a plain statement of what will not work.

Unmount by removing the insert and the dependency, then `pnpm install`.

### HTTP dashboards — `web:`

All application views launch through **`/apps/web/<id>/` on the DSH origin**.
The server reaches the container's private bridge IP; the user's browser only
needs to reach DSH. Published CLI URLs are operator diagnostics, not panel
fallbacks. Legacy `viewer:`-only entries receive a web mount and `/websockify`
automatically. Legacy `webMode: direct` entries show migration guidance instead
of an external frame.

The client probes the mount with `HEAD` and requires `x-dsh-app-proxy` to match
the app id. A bare 200 is insufficient: an unmounted route may serve the DSH
shell. `x-dsh-app-proxy-features` reports `ws` only when all declared upgrade
routes are actually registered, and `js` when `webRewrite` is configured. Missing
required capabilities produce a useful error, never a tailnet-only fallback.

For SPAs without a base-path option, add `webRewrite: /api/` (or a space-separated
list such as `/api/ /rpc/`). This opt-in text rewrite handles literal prefixes in
JavaScript responses only, not JSON/project-relative fragments, computed URLs,
workers or arbitrary routing. Encoded bodies pass through untouched; an upstream
that ignores `Accept-Encoding: identity` needs an app-side fix. Rewritten bodies
have upstream validators removed and `Cache-Control: no-store`; SSE streams
without whole-body buffering.

HTTP and WebSocket requests pass the same DSH trust/authentication gate before
any container lookup. Front-door Authorization and `dsh-auth-*` cookies are not
forwarded to app backends. This is **not an isolation boundary for untrusted app
JavaScript**: same-origin embedded apps must be operator-approved/trusted.

Three things learned the hard way:

- **A black iframe backdrop makes a working dashboard look broken.** The framed
  document's own background is not always composited into a screenshot (seen
  under Xvfb), so a black underlay hides the page. `.dsha-frame` is transparent;
  only the VNC viewer gets `#000`.
- **WebSockets are carried by EXACT routes, one per declared path.**
  `dsh-host-webserver` matches upgrade routes by pathname only
  (`this.upgrades.get(pathname)`) and the prefix table is not consulted, so a
  prefix upgrade proxy is not possible. The catalog therefore **declares** the
  socket paths (`webSockets: /websockify`) and `lib/index.js` registers one exact
  upgrade route per path per app, dialing the container exactly as the HTTP proxy
  does. Nothing is discovered: a route exists only for a declared path.
- **Declaring both `viewer:` and `web:` on the same host port is normal.** That is
  the VNC desktop: noVNC's page and its WebSocket share one listener, and the
  duplicate publication is skipped rather than passed to docker, which would fail
  the launch with "address already in use".

## Verify before trusting

A screenshot that "ran" proves nothing. Read the PNG back and confirm it shows
what you expected. For input, confirm the effect changed — a window title, a new
URL, a changed pixel region — rather than assuming the keystroke landed.
