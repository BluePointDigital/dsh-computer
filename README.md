<div align="center">

# Applications for DeepSeek Harness

**Deploy apps. Manage containers. Give your agent a real computer.**

Portainer-style visibility · CapRover-style deployment simplicity · Built into DSH

[![Release](https://img.shields.io/badge/release-v0.6.3-4561ee?style=flat-square)](https://github.com/BluePointDigital/dsh-computer/tree/v0.6.3)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A520-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Docker](https://img.shields.io/badge/Docker-Compose_v2-2496ed?style=flat-square&logo=docker&logoColor=white)](https://docs.docker.com/compose/)
[![License](https://img.shields.io/badge/license-MIT-555?style=flat-square)](#license)

[Features](#what-you-get) · [Install](#install) · [Deploy an app](#deploy-an-app) · [Desktop & CLI](#a-real-computer-for-your-agent) · [Documentation](#documentation)

</div>

---

**dsh-computer** brings an Applications page and a persistent Linux desktop to the
DeepSeek Harness. One package—`dsh-applications`—ships both the web plugin and the
agent's `docker-computer` skill.

Existing containers appear automatically. New applications deploy from a template,
a Docker image or a Compose document. No registration or adoption step to see and
manage what's already running.

## What you get

| | Capability |
|---|---|
| **Icon launcher** | A responsive app grid with coloured icons, direct Start/Open actions and one-click All, Running, Stopped, Needs attention and Infrastructure views. |
| **Automatic discovery** | See containers in every state, with Compose services grouped into applications. Search and status counts include infrastructure instead of silently hiding it. |
| **Simple deployment** | Choose a template, enter an image or paste/upload Compose. Fill in settings and click **Deploy**. |
| **Application controls** | Each icon’s **⋯** menu offers Start, Stop, Restart, Remove and Details/Logs/Terminal shortcuts. Saved deployments also offer Redeploy and revision rollback from their history. |
| **Live visibility** | Service health, CPU and memory usage, streaming logs, log search and downloads. |
| **Interactive terminals** | Open a real shell inside a service, directly from its details page. |
| **Editable configuration** | Load a saved definition, change environment or deployment settings, then save and redeploy. |
| **Embedded applications** | Open web apps and the desktop inside the harness, or in a new tab. |
| **Persistent storage** | Keep application data by default when removing an app. Save deployment definitions and credentials outside the source tree. |

### The everyday workflow

```text
                ┌─ Template ────────┐
Deploy app ─────┼─ Container image ─┼──→ Deploy ──→ Watch progress ──→ Open
                └─ Docker Compose ─┘                                 │
                                                                     ↓
                                           Logs · Terminal · Configuration
```

## Install

### Requirements

- **DeepSeek Harness:** `>=0.2.0-rc.2 <0.2.1-0`
- **Node.js:** 20 or newer, plus `pnpm`
- **Docker:** an accessible daemon; nested Docker is supported
- **Compose v2:** required for application deployment
- **Desktop:** build the included image when you want the Linux computer

### Install the pinned release

From the DSH web profile directory:

```bash
cd /data/profiles/web
pnpm add github:BluePointDigital/dsh-computer#v0.6.3

# Register the plugin and skill; build the desktop image if it is missing.
bash node_modules/dsh-applications/bin/install.sh install

# Provision the checksum-verified Compose plugin in private persistent storage.
node node_modules/dsh-applications/bin/install-compose.mjs
```

Restart DSH **between turns**, then refresh the browser and open **Applications**.
For a custom profile or home directory, pass `--profile NAME` and
`--dsh-home DIR` to the installer.

The plugin should be registered **once**, through the profile's bundle list. The
installer handles the wiring; a dependency alone does not register the agent skill.
See the [installation guide](<INSTALLATION.md>) for configuration and the
[development guide](<DEVELOPING.md>) for release and activation procedures.

## Deploy an app

Open **Applications → Deploy application**, then choose your source:

| Source | Supply |
|---|---|
| **Template** | Pick an app and fill in its required settings. |
| **Container image** | An image tag or digest, optional web port, environment values and persistent data paths. |
| **Docker Compose** | A self-contained Compose document, interpolation values and a frontend service/port if it has a web interface. |

Click **Deploy**. The manager saves the definition privately and shows validation,
image download, startup and readiness progress. Failed deployments remain visible
with diagnostics.

### Manage it in place

Each application has five detail tabs:

**Overview** · **Logs** · **Terminal** · **Configuration** · **Deployments**

Saved deployments support configuration edits, redeployment and revision rollback.
Discovered containers get lifecycle controls, inspection, logs and terminal access
without importing a definition. Discovery does not reconstruct their original
Compose source.

> **Your data stays by default.** Removing an app keeps persistent volumes unless
> you explicitly choose to delete them. Rolling back a deployment restores its
> definition—not a database snapshot.

### Web app access

Use the harness's existing hostname or IP with a stable assigned application port:

```text
Harness     https://harness.example.com
App one     https://harness.example.com:20000/
App two     https://harness.example.com:20001/
```

Configure the TCP range and TLS once; the default range is **20000–20099**. Apps
own their URL root, with HTTP and WebSocket support—no per-app DNS or cookie
rewriting. Set `appAccess: ports` and the public harness origin to select this
layout explicitly.

Apps use their own authentication. Ports separate browser origins, but cookies
remain shared by hostname. An app that blocks embedding can open in a new tab.
See [hosting configuration](<INSTALLATION.md#shared-host-application-ports-default>)
for HTTP/IP, direct HTTPS and ingress setups.

## A real computer for your agent

The included skill provides a stateful Debian container with Chromium, a virtual
display and a persistent home directory. The agent can install software, run
commands, drive the browser and share a desktop view with you.

```bash
C=/data/skills/docker-computer/bin/computer

$C up                     # Create or start the workspace computer
$C up --desktop           # Start its shared desktop viewer
$C exec 'uname -a'         # Run a command inside
$C sh                     # Open a shell
$C status                 # Inspect the computer
$C down                   # Stop it without removing its state
```

The home directory survives container replacement. Software installed in the
container layer survives stop/start, but not replacement. The desktop image is
built from the included [Dockerfile](<image/Dockerfile>).

## Scope

This is a **single-engine application manager**, not a Kubernetes or multi-host
orchestrator. Deployment currently uses prebuilt images; Git builds and Dockerfile
build pipelines are not included.

Compose deployments support multi-service applications, named volumes, networks,
health checks and dependencies. They use self-contained definitions rather than
arbitrary host files, external resources or privileged Docker passthrough. See the
[manager guide](<APPLICATIONS-MANAGER.md>) for supported fields and recovery behavior.

## Development & verification

```bash
npm ci --legacy-peer-deps
npm test

# Optional acceptance checks; require the documented local Docker/browser setup.
npm run test:runtime-browser
npm run test:runtime-live
npm run test:ports-browser
```

**v0.6.3 verification:** 197 automated Node tests and 54 proxy/password/catalog
checks passed, including direct and PATH-based CLI invocation through absolute,
relative and chained symlinks. Prior Chromium acceptance exercised the icon grid in dark/light and mobile layouts,
stopped-container filters, direct Start, inspection without starting a container,
streamed logs, terminal input and deployment submission. The unchanged deployment
engine also has real Docker Compose acceptance for two-service deployment,
redeployment, data retention and lifecycle operations.

## Documentation

| Guide | Contents |
|---|---|
| [Applications manager](<APPLICATIONS-MANAGER.md>) | Deployment, discovery, controls, private configuration and recovery |
| [Installation](<INSTALLATION.md>) | Plugin setup, application routing, ports and TLS |
| [Development](<DEVELOPING.md>) | Local development, testing, releases and activation |
| [Agent skill](<SKILL.md>) | Computer, desktop and CLI procedures |
| [Port verification](<PORTS-VERIFICATION.md>) | Shared-host transport and browser acceptance evidence |

## License

MIT
