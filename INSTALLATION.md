# Applications installation contract — v0.2.5

## Changing an embed configuration

Editing an app's embed settings (adding `webRewrite`, changing the port or path)
versions its script/style URLs with a `?dsha=` token derived from that
configuration. Without it a browser keeps the app bundle it cached while the
previous configuration was live — apps serve bundles `immutable` — so the app
would keep using the old URLs and appear broken after an otherwise correct
change. Every app load also carries a fresh per-load salt, so opening an app
always fetches current files even when nothing about the configuration changed;
no user action or cache clearing is needed. The salt is consumed by the proxy and
never forwarded, so apps see an unmodified query string.

Every embedded document is also opted out of translation (`translate="no"` on
`<html>` plus a `notranslate` meta, and `translate="no"` on the frame). A page
translator rewrites text nodes into elements of its own; React then removes nodes
whose parent it no longer owns and the app dies with `removeChild`. A translator
works per document, so this opt-out has to be written into the app's own HTML by
the proxy — an attribute on the embedding iframe would not cover the app.

## Durable listings and existing containers

The legacy catalog is seeded once into private `catalog.yaml` under the app state
root using atomic no-clobber creation. Subsequent package upgrades cannot replace
it. An explicit COMPUTER_APPS_FILE remains supported and operator-owned; back up
that location separately. Migrate existing package customizations **before**
installing the new package. A missing/corrupt catalog is not repaired by guessing.

Existing-container registrations live in private `existing.json`, separate from
installer-owned containers. Startup/refresh discovery exposes labelled orphans in
My apps and other unlisted TCP containers under Add existing container. Discovery
never starts, adopts or embeds anything. Human review confirms port, entry path,
optional exact sockets/JS prefixes and same-origin trust. Registration binds to
immutable container identity and current configuration; no create, rm, volume,
network or port-publication command is issued. Auto-remove and unsupported
host/none/shared network containers are rejected. Imported app lifecycle permits
Launch/Stop and Forget listing only. Missing originals remain visible and are not
recreated or replaced by a same-name container. Forget changes only the registry.

This is metadata recovery, not a sandbox: existing container privileges remain
unchanged and are disclosed in review. Discovery is limited to this instance's
Docker daemon, not remote host containers. Completed/cancelled/failed installer
journals are retained under collapsed Installation history.


## Surface

- My apps: Open, Launch/Stop, Logs, Uninstall for managed apps; legacy catalog
  actions remain compatible. All apps navigation uses the fixed viewer callback.
- Add app: three stock recipes, dedicated setup-conversation draft, Advanced form.
- Review: image/tag + immutable content id, entry/socket paths, JS adaptation,
  resource caps, data targets, environment key names, container command and trust.
- Progress: durable per-operation state/events. Credentials and raw Docker errors
  are not in review/job output. Logs redact saved literal environment values.
- Recovery: explicit cleanup of interrupted owned work, no silent restart/retry.

New agent sessions use the installed public sessions.create/using,
conversation.input.for().setDraft(), and uiWorkspace.openSession APIs. Selecting
Open setup conversation does not send a model prompt or approve anything.
The setup prompt constrains agents to the same prepare/review installer workflow.
The user reviews the draft, sends it, then approves the plan from Add app.
This is not a permission boundary against an operator-level agent with shell
access; normal operator tools remain available. No Agent Teams/new Bot required.

## Durable private storage

`COMPUTER_APPS_STATE` or `$DSH_HOME/.dsh-applications` owns version-1 registry JSON,
job journals and private credential files. GUI and CLI use the same environment
root. No config-only override that silently splits their registries is supported.
Owner-only real directories (0700), files (0600), and atomic fsync/rename writes;
symlink roots and paths inside /workspace/node_modules are refused.
A kernel flock coordinates cross-process mutations and releases on process death.
Only one mutation/install executes at a time; a second operation receives retry
instructions rather than racing. Reads can still report progress while work runs.
Linux/util-linux flock, Node >=20 and a reachable Docker daemon are required.

Existing operator apps.yaml is retained as the legacy catalog. New registry ids
must not collide; GUI/CLI fail closed on malformed registry instead of replacing
or hiding it. Installed definitions survive package dependency reinstall.

## Side effects and approval

Preparing a review may pull image layers: these are not execution, but consume
network and disk. That is explained beside Prepare/Review install. Local Desktop
never substitutes a similarly named public image for the built image.
Preparation resolves exact image content and declared VOLUME paths; every image
volume must have a reviewed target, avoiding surprise anonymous volumes.
Approval is bound to job UUID, normalized plan, environment key names, image
content and a 24h review expiry; credential values are stored only privately.
Execution uses the content id, never re-follows the mutable tag. Repeated approval
of a queued job is idempotent; other repeated approval/execution is refused.
Preflight rechecks legacy ids and container existence before reserving intent.

Create: fixed argv, no-new-privileges, CPU/memory/shm caps, PID cap, bounded Docker
logs, on-demand restart by default, optional named volume mounts, private env file.
No host binds, Docker socket, device/capability additions, host networking, raw
Docker flags/build contexts, arbitrary upstream URLs or host port publication.
Docker default capabilities and outbound networking remain; no claim of hostile
code isolation. Apps share the DSH browser origin, and approval explicitly
acknowledges publisher trust. Custom unknown images are not inherently safe.
Environment values are readable by the app and daemon administrators; literal
redaction cannot prevent an app encoding/transmitting its own secret.

## Recovery/removal

Job journal records before effects. Install reserves registry ownership before
creating. Containers carry operation UUID + app id labels; start/log/destructive
actions use inspected container IDs and recheck ownership. Proxy lookup refuses
foreign replacements, even if they reuse the same container name.
A Docker inspect failure does not mean absent: uncertain rollback retains its
registry ownership and prompts explicit recovery. Failed/timeout create still
checks for operation-owned side effects. Cleanup never removes foreign containers,
images or persistent volumes. Downloaded/shared image layers are kept.

Interrupted approvals not yet executing become failed through explicit Recover;
an installed-registry/nonterminal-job crash window is reconciled to ready rather
than deleting the completed app. Active workers hold flock so Recover cannot
remove an in-progress container. Queued jobs have an explicit retry control.
Cancelled/failed/removed installs clear environment secret files after proven
owned-container cleanup. Registry/job metadata remains for diagnostics.

Removing only a managed container through CLI keeps its installed definition;
Launch restores that same reviewed image content and operation-owned volumes.
Uninstall unregisters it and clears its secrets; a fresh Install never adopts data.
Volume names include an install UUID, not just app id. Reusing an app id does not
adopt a previous install's retained data. Named data volumes are never deleted
by rollback or uninstall. This first release does not provide data restoration,
volume deletion, upgrade/recreate or multi-service Compose management. Back up
important data separately; uninstall is not a disk-cleanup promise.

## Readiness and boundaries

The installer proves the selected web entry responds with success/redirect and
that the owned container runs. It does not universally prove SPA routing, every
socket, worker, SRI or app authentication. Prefer native base-path settings;
configured literal webRewrite and exact socket routes have documented limits.
If incompatible, the agent must explain/stop rather than open a new external tab.
Desktop recipe starts X and its viewer through existing image tools.

Tests use Docker mocks for deterministic schema/ownership/failure/secret cases
and real HTTP/WS for proxy/lifecycle. Optional installer-browser test reuses the
installed React platform module code in an isolated test server; it edits no
DeepSeek files and starts no replacement GUI. Setup session services are mocked
in that scratch test; exact public APIs were verified against installed contracts.
Live installed-GUI/session integration still needs a canary after publication.

## CLI example (no credentials in source/chat)

```bash
printf '%s' '{"plan":{"id":"my-web","image":"nginx:1.28-alpine","webPort":80}}' | bin/computer apps prepare
bin/computer apps jobs
# Human reviews/approves from Add app. Operator-only alternative:
bin/computer apps approve JOB_UUID APPROVAL_HASH --trust-publisher
bin/computer apps run JOB_UUID
bin/computer apps recover
bin/computer apps uninstall my-web
```

Agent setup must stop after prepare; it must not interpret user prose or broad
project permission as approval of the exact install review. Secrets are entered
in Advanced or the existing review’s Add / replace environment values input, not
prefilled conversation text. Saving values on a review rotates its approval token
and resets the trust checkbox; the user reviews the environment key names again.

Already-approved workers are process-owned and finish/rollback if the plugin is
disabled while they run; route disposal is not an install cancellation button.
No new worker starts after that plugin lifetime has been disposed. Process restart
still requires explicit recovery/retry from its journals; no silent replay.
