# Architecture

CS Bridge is a Slurm session manager first and a Dev Tunnel client second. Everything runs in the local VS Code
extension host (`extensionKind: ["ui"]`): it drives the cluster through the OS `ssh` binary, opens a Microsoft
Dev Tunnel to the compute node, and hands the final attach to VS Code's remote-SSH URI handler. Nothing listens
for inbound connections on the cluster. An EC2 instance **(experimental)** is a session whose backend is the instance
instead of a Slurm job: it is reached over plain SSH, with no Linkspan or tunnel, and rides the same lifecycle.

```text
Local VS Code                              Remote HPC cluster
┌──────────────────────────┐               ┌──────────────────────────┐
│  CS Bridge sidebar       │── OS ssh ────▶│  SSH host                │
│  (Preact webviews)       │               │  (sbatch, sacct, sinfo)  │
│                          │               │                          │
│  SSH ControlMaster pool  │               │  Compute node:           │
│  extension storage:      │               │  ┌──────────────────┐    │
│    ssh_config            │               │  │  Linkspan        │    │
│    ssh_keys/             │               │  │  ├─ sshd         │    │
│  temp: ControlMaster     │               │  │  └─ Dev Tunnel ──┼────┼──▶ devtunnels.ms
│                          │               │  └──────────────────┘    │
│  Dev Tunnels SDK         │◀─ Dev Tunnel ─│                          │
│  (forwards 127.0.0.1:N   │               └──────────────────────────┘
│   to compute-node sshd)  │
└──────────────────────────┘
         │
         ▼
  vscode-remote://ssh-remote+<alias>-<last 6 of session name>/…
  (OS ssh dials 127.0.0.1:N using the per-session
   SSH host in the extension's ssh_config)
```

## Session lifecycle

1. **SSH host and resources.** The user picks an SSH host from `~/.ssh/config` and sets partition, Slurm account,
   CPUs, memory, GPUs and walltime. Partitions, Slurm accounts and limits come from `sinfo` and `sacctmgr` over SSH
   (`slurmSupport.ts`).
2. **Dev Tunnel first.** `prepareLaunch` pins a random control port, creates the Dev Tunnel, and mints a host
   token for the job (`sessionSupport.ts`, `tunnelSupport.ts`). `buildSlurmScript` bakes the port and the Dev Tunnel
   id into the job script; the token travels in the sbatch environment (`slurmParse.ts`).
3. **Slurm gate.** `checkSlurmAvailability` runs `sinfo` on the SSH host; a non-zero exit aborts the launch. Slurm is
   mandatory (`slurmLaunch.ts`).
4. **Agent install.** If `~/.cybershuttle/bin/linkspan` is missing, behind the latest release or below 0.22.0,
   `installLinkspan` fetches `linkspan_Linux_<arch>.tar.gz` from the Linkspan GitHub release, stages it, and moves it
   into place mode `0700`. `uname -m` values `x86_64`, `aarch64` and `arm64` map to the two published assets
   (`linkspan_Linux_x86_64.tar.gz`, `linkspan_Linux_arm64.tar.gz`); anything else is refused by name.
5. **Submit.** The script is base64-piped into `sbatch`, and the host token rides `LINKSPAN_TUNNEL_HOST_TOKEN=… sbatch
   --export=ALL`, so it never lands on the cluster filesystem. The parsed job id is kept on the session record and the
   provider's draft of the script is dropped (`slurmLaunch.ts`).
6. **Poll.** `SessionMonitor` runs one `setInterval` per active session — no central loop. Before the job runs it
   polls `sacct` and records the reading; once it runs it pings Linkspan over the Dev Tunnel and
   falls back to a `sacct` cross-check only after repeated health failures (`sessionSupport.ts`, `sessionMachine.ts`).
7. **Remote sshd.** `ensureRemoteSession` asks Linkspan for an SSH server that accepts the session's public key,
   named by a `ref` derived from that key, so Linkspan answers a repeat with the server already running. The session
   reaches `ready_to_connect`.
8. **Connect.** `connectTransport` composes the step: `connectSessionToTunnel` forwards the control port through an
   in-process `TunnelRelayTunnelClient` and binds `127.0.0.1:N`, whose every connection rides Linkspan's
   `/api/v1/forward/{sshPort}`, and records that port on the session; `syncSshConfig` renders the extension's
   `ssh_config` and the `remote.SSH.serverInstallPath` map from the records on every change, and only once they are
   written does `openOrFocusWindow` open `vscode-remote://ssh-remote+<alias>/…`.
9. **Attach.** VS Code's remote-SSH URI handler runs the OS `ssh` binary against that alias, installs VS Code
   Server, and attaches the window to the compute node. CS Bridge pins that alias's
   `remote.SSH.serverInstallPath` to node-local `/tmp/cs-vscode/<sessionId>`, keeping the server off the shared
   network home where stalls miss the ptyHost heartbeat.

## Experimental features

`features.ts` names each feature and its stage. An experimental feature runs only with `csbridge.experimentalFeatures`,
and every gate calls `enabled('<feature>')`. A gate covers entry points only, so turning the switch off never strands a
live run. Markdown tags an experimental feature **(experimental)** after its name, plain in a heading.

| Step | Change |
|---|---|
| Start experimental | add the feature as `'experimental'`, gate its entry points and tag its prose |
| Graduate | mark it `'stable'`, which turns every gate on for everyone, and drop its tags |
| Retire the flag | delete the entry and inline each `enabled()` call naming it |

## The link transport (experimental)

With `csbridge.experimentalFeatures` on and `csbridge.transport` set to `link`, a session's run goes through cs-plane
(`plane.ts`) instead of a Dev Tunnel; the record's `transport` and `planeId` fields select and key it. `linkTunnel.ts`
mirrors the Dev Tunnels SDK's management and relay clients over cs-plane. A `Transport` (`transport.ts`) is that
client pair plus the launch and the run's release; `transportFor` picks one, the session-level steps in the same module
run on either, and nothing else branches on `transport`.

| Step | Link behaviour |
|---|---|
| Sign-in | CILogon device grant brokered by cs-plane; the credential lives in SecretStorage |
| Prepare | `prepareLaunch` defines the cs-plane session once (`planeId`), stops any live run, attaches with `tunnelModes: ["link"]`; the job script gets `--tunnel-mode link --tunnel-link-args '--url …'` |
| Submit | Linkspan 0.22.0 or newer; the link token rides `LINKSPAN_LINK_TOKEN=… sbatch --export=ALL` over the persistent shell's stdin |
| Forward | `/access` gives the connect token, held in memory; each forwarded port is a `127.0.0.1` listener whose every connection opens a WebSocket to `/sessions/{id}/forward/{port}` |
| Poll, connect | as for a Dev Tunnel, with Linkspan's API reached through a forward of its control port |
| Stop, delete | release (`POST /stop`) the cs-plane session; delete also `DELETE`s it |

## EC2 instances (experimental)

An EC2 session is a session record with an `ec2` field (region, instance type, image, login user, public IP); its `alias`
is `aws-<region>` and `jobId` the instance id, so the store, cross-window sync, window heartbeats, `csHostAlias`, the
remote-window detection and the card's actions apply unchanged. The lifecycle is the Slurm one with the backend swapped:
Every step a session's remote side needs goes through one `Backend` interface (`sessionSupport.ts`): `start`, `stop`,
`connect`, `remove` for the provider and `tick`, `end` for the monitor. `SlurmBackend` holds the Slurm job's version
and `ec2Session.ts` the instance's, over `ec2.ts`, the API calls with no `vscode` import. `aws.ts` holds the sign-in: an access key in VS Code's secret storage, restored on
activation, whose first call lists the account's regions. Sign-in also adopts every tagged instance without a record.

| Step | EC2 behaviour |
|---|---|
| Create | the menu's **Create Cloud VM** pages pick region, type and image; the record lands `not_started`, with no instance yet |
| Start | `RunInstances` with `resolve:ssm:` for the image's latest AMI, or `StartInstances` for a stopped one; the first launch in a region creates the default VPC if the account lacks one, one AWS-generated key pair per machine saved beside the session SSH keys, and one security group opening port 22 |
| Poll | `DescribeInstances` every 5 s through `computeEc2Transition`; `preparing` holds until port 22 accepts a connection, which sets `connectionInfo.sshPort` and reaches `ready_to_connect` |
| Connect | writes the per-session SSH host (public IP, port 22, the image's user, the region's key) and opens the window in the user's home |
| Stop | waits out a pending boot, `StopInstances`, then holds the task until the instance reads `stopped`; a reload resumes it like a Slurm stop |
| Delete | `TerminateInstances`; an instance terminated outside CS Bridge fails its session |

Instances carry a `CS-Bridge-User` tag naming the image's login user, which is also the filter that adopts them.

## The per-session SSH host

`csHostAlias(session)` is `<alias>-<last 6 characters of the session name>` — for example
`delta-493119` (`sshHostsStore.ts`). One function builds the `ssh_config` `Host` line, the
`ssh-remote+` authority, and the reverse lookup that tells a remote window which session it belongs to, so all
three stay in lockstep. The alias is what VS Code prints as the window's `[SSH: …]` label, and it never equals a
bare SSH host alias, so it cannot shadow the SSH host used for Slurm.

## Source layout

Four layers, and nothing reaches past its neighbour.

- **`src/*.ts`** — the VS Code surface. `extension.ts` registers everything; one provider per contributed view
  (`sessionProvider`, `sshHostProvider`, `statsProvider`) plus `summaryPanel`, over the `webviewProvider` base that
  renders the nonce-gated CSP shell each bundle loads into. `remoteSessionController` exists only inside a remote
  window, where it owns the walltime status bar and the hand-back to a local window.
- **`src/modules/*.ts`** — the capability layer. SSH (`sshSupport`, `sshShell`, `sshHostsStore`, `sshCommandParser`),
  Slurm (`slurmLaunch`, `slurmParse`, `slurmSupport`), Linkspan's HTTP client (`linkspanSupport`), Dev Tunnels
  (`tunnelSupport`), their cs-plane counterparts **(experimental)** (`linkTunnel`), the transport choice and the
  session-level connect steps (`transport`), EC2 instances **(experimental)** (`ec2`, `aws`), the status domain
  (`sessionMachine`), lifecycle composition
  (`sessionSupport`), the on-disk stores and their migrations (`schema`). Modules that do not import `vscode`
  unit-test directly; the ones that do cannot be imported under the test runner at all.
- **`src/ui/`** — Preact webviews, one esbuild bundle per view. `logic/` is pure and tested, `components/` renders,
  `platform/vscode.tsx` is the only thing that talks to the webview host (`post()` out, `useWebviewState()` in).
- **`resources/`, `scripts/`** — the activity-bar icons, and the `SSH_ASKPASS` helpers (`askpass.js`, `askpass.sh`).

The testability seam is extraction, not injection: to make `vscode`-coupled logic testable, move the pure or
effect-light part into a `vscode`-free module and test that. `slurmLaunch` is the pattern — it takes an injected
`RemoteRunner` and `LogSink`, mutates only the in-memory session, and leaves persistence to its caller.

## Session status model

Statuses are `not_started`, `submitting`, `queued`, `preparing`, `ready_to_connect`, `connecting`, `connected`,
`stopping`, `stopped`, `failed`, `unreachable` (`models.ts`). No status is stored: `deriveStatus` in `sessionMachine.ts`
computes it from the record's facts (`desired`, `observed`, `failure`, `jobId`, `startedAt`, the walltime, `sshPort`)
and this window's live ones (`extensionStore.live`: a launch or connect in flight, a connection held, a poll that failed
to reach the backend), and every reader goes through `statusOf`. Writers record facts, never a status, so a stale reading
cannot revive an ended job and a reload cannot forget a stop. The predicates that gate behaviour live beside it:
`isTerminal` (stopped/failed), `isDeletable` (terminal plus `not_started`), `isStoppable`, `isReachable`
(`ready_to_connect`/`connecting`/`connected`). `SessionMonitor` schedules each live session's ticks and its teardown
through the session's `Backend`; `SessionProvider` owns user actions and every dialog.

## SSH transport

`SshManager` holds one persistent `ssh … bash -l` per SSH host and multiplexes every remote command over it, framing
each call with a random marker to demux stdout, stderr and exit code (`sshSupport.ts`, `sshShell.ts`). A command
resolves to its stdout; a non-zero exit, or a shell that could not connect, rejects with an `Error` naming the exit, so no
caller inspects an exit code. A per-SSH-host
serial queue keeps one command in flight; a dropped shell reconnects lazily on the next command. This in-process
multiplexing is what makes Windows work, where OpenSSH has no Unix-socket ControlMaster; on Unix a ControlMaster
socket (named by a SHA-256 of the SSH host's alias, to stay under the 104-byte socket-path limit) is layered on as well
so several windows share one authentication. Background polls run in a batch mode that rides an existing shell or
fails fast, so they never raise a 2FA prompt nobody is watching. Password, passphrase and keyboard-interactive
prompts go out through the `SSH_ASKPASS` helper, which IPCs to a `csbridge.sshAuth` webview panel: a
newline-preserving monospace block is what lets a device-flow QR prompt render, which an input box cannot do.

## Persistence and cross-window state

Sessions, run history and window heartbeats are one JSON record per id under `sessions/`, `runs/` and `windows/` in VS
Code's extension storage, a folder of JSON files. A `JsonDir` (`store.ts`) holds each directory
in memory, so reads are synchronous; writes, and reloads of other windows' writes from a file watcher (`storage.ts`),
run in order on that directory's queue; a patch lands its fields on the record as last written. Every window rewrites its heartbeat until it
closes; a remote window's names its session and the folder URI it has open, which Switch focuses. A live session has one
owner window (`owner`), claimed while no beating window holds it and released when its loop ends: the owner alone
monitors it, holds its relay, connects it and carries out a Stop asked from any window, and a window that loses the claim
stops on its next tick. A record holds only what every window shares; this window's connection state is
`extensionStore.live`, and its Dev Tunnel connect token stays in `tunnelSupport.ts`.

Field names match cs-plane's wire types: a session is `alias`, `account`, `partition`, `rootFolder` and `resources`
(`cores`, `memoryMb`, `wallMinutes`, `gpuType`, `gpuCount`); a run is `Run` with `RunStats` and `samples`.

A remote window recognises itself: `extension.ts` reads the workspace URI authority, and in an
`ssh-remote+<alias>` window it scopes the Sessions view to that one session, observe-only, and sets the
`csbridge.remote` context so the SSH Hosts and Run History views hide.

## Schema migrations

`schema.json` in extension storage holds one version. At activation, before any store reads, `migrate()`
(`store.ts`) applies each step from the version it finds to `SCHEMA_VERSION`, recording the version after each.
Versions 0 and 1 lived in `~/.cybershuttle`; desktop's `legacySteps` (`schema.ts`) import them under a lock in
extension storage, and step 2 replaces the stored status with the facts it derives from. The stores read only the
current shape.

| Change | Rule |
|---|---|
| A persisted field or file changes shape | Bump `SCHEMA_VERSION`, add the step where `openStorage` calls `migrate`, and update `models.ts` and the stores to the new shape only |
| A step | Deterministic and idempotent, so a crash before the version is written reruns it cleanly |
| Storage newer than the build | Refused at activation with an error, never read |

## Build pipeline

`esbuild.js` runs two esbuild contexts plus a codicon copy. The extension bundles `src/extension.ts` to
`out/extension.js` (CJS, `platform: node`, `target: node22`, `vscode` and `node-rsa` external). The webviews bundle
`src/ui/webviews/{sessions,hosts,stats,summary}.tsx` to `out/*.js` (IIFE, `platform: browser`, Preact JSX). Both
share `bundle: true`, sourcemaps off and minification on under `--production`, and the `@` → `src` alias. esbuild
never type-checks: `tsc` does, once per tsconfig, since the root config excludes `src/ui`, which has its own with
DOM libs and Preact JSX. The `.vsix` ships `out/`, `resources/`, `scripts/`, `package.json` and the root
documents; `src/`, `docs/`, `.github/` and `node_modules/` are excluded (see `.vscodeignore`).

## External dependencies

- **[Linkspan](https://github.com/cyber-shuttle/linkspan)** — the agent that runs on the compute node and manages
  the SSH server and the Dev Tunnel host side. Installed by CS Bridge to `~/.cybershuttle/bin/linkspan` on first
  launch. The Linkspan version a release requires is recorded in [CHANGELOG.md](../CHANGELOG.md).
- **Microsoft Dev Tunnels SDK** — `@microsoft/dev-tunnels-{management,connections,contracts}`, used in-process for
  Dev Tunnel CRUD and for the Dev Tunnel client. There is no `devtunnel` CLI and no custom OAuth server:
  authentication is `vscode.authentication.getSession('microsoft', …)`.
- **OS-native OpenSSH** — every SSH connection is made by the system `ssh` binary. Nothing is bundled.
- **VS Code remote-SSH URI handler** — CS Bridge emits a `vscode-remote://ssh-remote+…` URI and whatever provider
  is installed (typically
  [ms-vscode-remote.remote-ssh](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-ssh))
  attaches the window. It is not declared as an `extensionDependencies` entry.
