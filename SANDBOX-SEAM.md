# The sandbox seams — investigated, not adopted

**Date:** 2026-10-14 · **Status:** closed, do not rebuild · **Question:** should
`docker-computer` become a first-class DSH sandbox backend?

**Answer: the seam exists, it is a different seam than it looks, and for this
project it is the wrong trade.** This records the investigation so it is not
repeated. Everything below was read from the installed 0.2.0-rc.2 packages or
measured live; nothing is inferred from third-party READMEs.

## 1. `SandboxProvider` is not the seam for a container

It is tempting: DSH registers a `sandbox` service, `dsh-bash-sandbox` consumes
it, and the ecosystem ships alternative backends (`sandbox-micro`, `sandbox-nono`,
`sandbox-mxc`). But the contract rules a container out in its own module doc
(`@deepseek-ai/dsh-sandbox/lib/types/index.d.ts:1-5`):

> *"wrap exact subprocess argv under a host-path file policy. **Containers,
> microVMs, and remote execution replace the surrounding capability seam instead;
> this service shares the host kernel and filesystem.**"*

A box has its own kernel namespace and filesystem. It does not belong here, by
design rather than by omission.

One thing this cleared up: `confine(argv, policy, signal)` returns
`Promise<ConfinedArgv>` — **it is async**, so the "can't start a container inside a
synchronous call" objection does not apply. That was the reason to look; it is no
longer the reason to stop.

## 2. The real seam is `ctx.provide()` on `subprocess` and `fs`

Both are ordinary Cordis services (`dsh-subprocess/lib/index.js:88`
`super(ctx, "subprocess")`), and a plugin can *replace* them. Verified against a
working implementation rather than guessed — `dsh-podman/src/index.ts:130-145`:

```js
const subprocess = createSubprocessProvider(resolver);
ctx.provide("subprocess", subprocess);
ctx.provide("fs", createFilesystemProvider(resolver, {...}));
ctx.provide("spillStore", createSpillStore(ctx, resolver));
```

So "the agent's bash and file tools run inside a container" is achievable on
0.2.0-rc.2. The question is only whether it is worth it.

## 3. The cost, measured

| Path | Surface | Size |
|---|---|---|
| Replace `fs` | **17 methods** — `resolve`, `processPath`, `processPathFromHostPath`, `fileUrl`, `contains`, `readText`, `streamText`, `readBytes`, `readByteRange`, `lstat`, `writeText`, `stat`, `listDir`, `mkdir`, `remove`, `editText`, `watch` | 1,850 TS lines **plus a 34,328-line Go** guest agent (dsh-podman) |
| Replace `subprocess` alone | **4 methods** — `resolveExecutable`, `terminalEnvironment`, `spawn`, `spawnTerminal` | ~150 lines of JS |

The cheap path has one genuinely elegant property: if the box bind-mounts the
workspace at the **same absolute path**, the host's `fs` and the container's
`subprocess` address identical bytes, so file tools stay fast and versioned while
every *command* runs isolated. The box already bind-mounts (`.dsh-computer/home`
→ `/home/agent`), so this is a familiar trick.

## 4. Why we are not doing it

1. **It inverts the premise.** The box is a machine the user and the agent
   *share*, watchable over VNC. Routing `fs` through `docker exec` makes the
   agent's files stop being the user's files. Routing only `subprocess` keeps the
   bytes shared but turns every `ls`, `grep`, `cat` and `git status` into a
   container round trip.
2. **Most commands are file work** and need no isolation. Our heavyweight work
   (apt installs, builds, GUIs) already goes to the box explicitly and correctly.
3. **It claims a service the harness depends on.** `ctx.provide` is global; a
   conflict or a bug in that layer breaks the harness's own bash, not just us.

**Decision: keep the box an explicit, stateful machine the agent drives through
the CLI, with the typed affordance (`propose_program`) for turning containers into
programs.** The containers-as-programs model is what no other plugin does; the
sandbox layer is where everyone else already competes.

## 5. What was taken instead

The cheap hardening, tested rather than assumed:

- **`--pids-limit 2048` on the box** — every managed app already had it; the box,
  which runs the most code, did not. Measured safe: boot, `sudo -n id -u` → `0`,
  `apt-get install jq` → `jq-1.6`, Chromium reaches 9 processes.
- **`--security-opt no-new-privileges` is impossible on the box, not merely
  unwise.** Measured on a throwaway box: `sudo -n id -u` fails with *"The 'no new
  privileges' flag is set, which prevents sudo from running as root"* and
  `apt-get install` fails with it. Passwordless sudo is the feature; the flag is
  mutually exclusive with it. `--read-only` fails for the same reason.
  `SKILL.md` now says so where a future change would look.
- **`--offline`** (`--network none`) already existed and remains the right switch
  for untrusted work.

## 6. If it is ever revisited

The trigger would be a client requiring *every* agent command isolated, not just
the heavy ones. Then spike the `subprocess`-only replacement (~150 lines) against
the four-method contract, keep `fs` on the host, and bind-mount the workspace at a
matching path. Do **not** start from the full `fs` replacement: 17 methods and a
guest agent is a second product, and it costs the live shared workspace that is
the point of this one.
