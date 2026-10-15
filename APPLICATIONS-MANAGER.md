# Runtime Applications manager

The Applications page is a deployment and management interface: **Portainer-style
visibility with CapRover-style simple deployment**, while apps open within the
harness. Docker is the runtime source of truth, not a catalog registration gate.

**Status:** implemented source, not a released/installed/activated production
change. The supplied Chromium fixture acceptance succeeded for inventory, details,
SSE logs, xterm typing, private configuration not loading automatically, and
one-click deployment submission. That fixture uses a backend fixture. **Real
nested-Docker Compose acceptance also passed:** two-service deployment, automatic
discovery, frontend readiness, redeploy with retained volume data, stop/start and
scratch cleanup. Full regression suite: 194 Node tests plus 41 proxy, 12 password
and 3 catalog-retry checks passed. No release installation or harness restart is
implied by those results.

## What appears automatically

- All containers visible to this instance's **nested Docker daemon**, including
  stopped, failed and unhealthy containers. This is not remote host discovery.
- Containers with the same Compose project label appear as one application, with
  individual services beneath it. Search and infrastructure filtering keep the
  normal application list readable without hiding the underlying resources.
- Existing catalog, installed and registered metadata can enrich these entries;
  a new registration, migration or acceptance step is **not required** to list,
  inspect, view logs, open a terminal or use supported lifecycle controls.
- A discovered container/project is not automatically adopted as a saved
  deployment. Inspection does **not** reconstruct a portable Compose definition,
  original environment file, build context or revision history.

Opening a discovered web app selects an unambiguous endpoint automatically where
possible. If several services/ports are exposed, choose the frontend service,
container web port and entry path in its endpoint controls. This changes launch
metadata, not container ownership or deployment configuration. Apps without a web
endpoint remain manageable. Existing shared-host port behavior is unchanged; see
[the hosting contract](INSTALLATION.md#shared-host-application-ports-default).

## Deploy application

Choose **Deploy application**, then one of:

| Source | Owner supplies |
|---|---|
| Template | A template and any necessary application settings |
| Container image | Image tag/digest, web entry, environment and persistent data paths |
| Docker Compose | One pasted or uploaded self-contained Compose document, environment/interpolation values and frontend service/port |

The owner's **Deploy** click makes one submission which durably saves the source
and queues execution. There is no separate prepare/approve/run sequence in this
new owner-facing flow. Progress reports validation, image pulling, startup and
frontend readiness; a failed deployment remains visible with its diagnostics.
Agents may prepare a definition for the owner, but must not synthesize that owner
click. Legacy proposal/installer APIs remain compatibility surfaces, not required
steps in the new page.

All three paths execute through Docker Compose v2. Select a real frontend service
and container web port; a multi-service definition must identify its frontend.
Use prebuilt images: **Git deployment, Dockerfile/image builds and repository build
contexts are not V1 features**. Local Desktop templates require the existing local
image; they do not silently pull a similarly named public image.

V1 Compose input is self-contained. External includes/extends/env files, file-based
configs/secrets, host bind mounts, externally owned resources and host namespace or
privileged/device/capability access are not supported. Supply interpolation values
through the private environment form, and use project-scoped named data volumes.
An invalid definition reports an error rather than guessing missing infrastructure.
This is a useful multi-service application deployer, not an unrestricted Docker
Compose command passthrough.

### Compose prerequisite

Docker CLI plus **Compose v2** must be available to the executor. Provision the
pinned plugin once, outside the synced workspace and package directory:

```bash
node bin/install-compose.mjs
```

The [persistent installer](bin/install-compose.mjs) downloads Compose **v2.40.3**,
verifies the binary against the release SHA-256 checksum list, and installs it in
`$DSH_HOME/tools/docker/cli-plugins/docker-compose` (home-directory fallback if
DSH_HOME is unset). It supports Linux x64/arm64. The deployment executor selects
that private Docker config when no operator DOCKER_CONFIG is configured. An
operator-provided DOCKER_CONFIG remains authoritative and must expose Compose v2.

Compose v2.40.3 has been provisioned on this instance. This prerequisite does not
install or activate the new Applications plugin, and does not prove a real
application deployment passed.

## Application details and actions

- **Overview:** container/service states, health, image, mounts, networking and
  available runtime resource statistics.
- **Open:** embed the frontend within the harness or open it in a new tab.
- **Logs:** choose a service, follow live output over SSE, search and download.
- **Terminal:** select a running service and `/bin/sh` or `/bin/bash`; interactive
  xterm input/output and resize use a real Docker exec TTY over WebSocket. The
  terminal currently requires a local Unix Docker endpoint and a shell available
  in the container image.
- **Configuration:** inspected runtime settings and environment **key names** for
  discovered apps; explicitly loaded editable source/environment for saved
  deployments. **Save and redeploy** creates a new saved revision and applies it.
- **Deployments:** progress/history and rollback to a saved revision. Redeploy
  recreates from the saved definition; rollback submits an older definition as a
  new deployment revision. Neither operation restores a database or data snapshot.

Start, Stop, Restart and Remove act on the application/project or selected
services as supported. Discovered containers have direct lifecycle controls;
Update, Redeploy and Rollback require a definition saved by this manager. Do not
promise a discovered application's original source can be recovered automatically.
Auto-remove containers cannot be casually stopped/restarted as though those actions
would retain them; the controls report that Docker deletion behavior.

**Removal retains persistent data by default.** Deleting data is a separate
explicit option. For saved projects it can remove their Compose-managed volumes;
for discovered containers Docker's container-removal volume semantics apply, not
a general purge of named volumes. Failed deployment/recovery retains containers
and data for inspection. Back up important data independently.

## Private state and recovery

Definitions, revision source/runtime documents, environment/interpolation values,
project metadata and deployment job journals live under `COMPUTER_APPS_STATE`
(default `$DSH_HOME/.dsh-applications`), outside the synced workspace and dependency
package. Directories are owner-only and files are privately/atomically written.

Normal inventory, details and progress do not return the saved definition or
secret environment values. **Load configuration** is an explicit authenticated
owner action; leaving Configuration clears its editor. Definitions may contain
inline secrets as well as environment values, so do not copy them into source,
chat, screenshots or generic status output. Logs and terminal are the actual
application output and may themselves contain secrets emitted by that application.

A durable queued owner submission can be scheduled after initialization. A worker
interrupted after execution started is marked failed rather than automatically
repeating a partial Compose operation. Existing containers, source, credentials
and volumes remain; inspect Docker state and choose **Redeploy** deliberately.
Interrupted queue commits without a matching project index are failed for explicit
resubmission. Recovery is not an automatic data rollback or cleanup of foreign
containers.

## Implementation and acceptance

The existing plugin loads [runtime-ui.js](lib/runtime-ui.js) from
`/apps/assets/runtime-ui.js`; this is not a separate application/server or a second
Applications sidebar entry. [index.js](lib/index.js) owns authenticated runtime
APIs and asset/terminal routes. The main modules are
[runtime-inventory.js](lib/runtime-inventory.js), [deployments.js](lib/deployments.js)
and [runtime-console.js](lib/runtime-console.js).

```bash
npm run test:runtime-browser  # Chromium UI acceptance with fixture backend
npm run test:runtime-live     # opt-in real nested-Docker Compose smoke; creates scratch resources
```

The live smoke exercises a temporary multi-service deployment, discovery,
frontend readiness, redeploy, retained volume data and lifecycle, then cleans its
scratch resources. It **passed against the actual nested Docker engine** using
Compose v2.40.3. Neither test is installed-DSH-shell/public-ingress acceptance. Follow the separate release,
dependency installation, coordinated restart and existing-GUI verification in
[DEVELOPING.md](DEVELOPING.md). Never restart the harness mid-turn.
