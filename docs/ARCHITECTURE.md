# Architecture

CS Bridge is a Slurm session manager first and a Dev Tunnel client second. Everything runs in the local VS Code
extension host (`extensionKind: ["ui"]`): it drives the cluster through the OS `ssh` binary, opens a Microsoft
Dev Tunnel to the compute node, and hands the final attach to VS Code's remote-SSH URI handler. Nothing listens
for inbound connections on the cluster.

```text
Local VS Code                              Remote HPC cluster
┌──────────────────────────┐               ┌──────────────────────────┐
│  CS Bridge sidebar       │── OS ssh ────▶│  SSH host                │
│  (Preact webviews)       │               │  (sbatch, sacct, sinfo)  │
│                          │               │                          │
│  SSH ControlMaster pool  │               │  Compute node:           │
│  ~/.cybershuttle/        │               │  ┌──────────────────┐    │
│    ssh_config            │               │  │  Linkspan        │    │
│    ssh_keys/             │               │  │  ├─ sshd         │    │
│    ssh_control/          │               │  │  └─ Dev Tunnel ──┼────┼──▶ devtunnels.ms
│                          │               │  └──────────────────┘    │
│  Dev Tunnels SDK         │◀─ Dev Tunnel ─│                          │
│  (forwards 127.0.0.1:N   │               └──────────────────────────┘
│   to compute-node sshd)  │
└──────────────────────────┘
         │
         ▼
  vscode-remote://ssh-remote+<alias>-<last 6 of session name>/…
  (OS ssh dials 127.0.0.1:N using the per-session
   SSH host in ~/.cybershuttle/ssh_config)
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
   in-memory script is dropped (`slurmLaunch.ts`).
6. **Poll.** `SessionMonitor` runs one `setInterval` per active session — no central loop. Before the job runs it
   polls `sacct` and applies `computeStatusTransition`; once it runs it pings Linkspan over the Dev Tunnel and
   falls back to a `sacct` cross-check only after repeated health failures (`sessionSupport.ts`, `sessionMachine.ts`).
7. **Remote sshd.** `ensureRemoteSession` asks Linkspan for an SSH server that accepts the session's public key,
   named by a `ref` derived from that key, so Linkspan answers a repeat with the server already running. The session
   reaches `ready_to_connect`.
8. **Connect.** `connectDevTunnel` composes the step: `connectSessionToTunnel` forwards the control port through an
   in-process `TunnelRelayTunnelClient` and binds `127.0.0.1:N`, whose every connection rides Linkspan's
   `/api/v1/forward/{sshPort}`, and returns that port; `addSshConfigEntry` writes the per-session SSH host, and only
   on success does `openOrFocusWindow` open `vscode-remote://ssh-remote+<alias>/…`.
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
mirrors the Dev Tunnels SDK's management and relay clients over cs-plane, so `tunnelSupport.ts`'s session-level
functions run on either. A `Transport` (`transport.ts`) is that client pair plus the launch and the run's release;
`transportFor` picks one, and nothing else branches on `transport`.

| Step | Link behaviour |
|---|---|
| Sign-in | CILogon device grant brokered by cs-plane; the credential lives in SecretStorage |
| Prepare | `prepareLaunch` defines the cs-plane session once (`planeId`), stops any live run, attaches with `tunnelModes: ["link"]`; the job script gets `--tunnel-mode link --tunnel-link-args '--url …'` |
| Submit | Linkspan 0.22.0 or newer; the link token rides `LINKSPAN_LINK_TOKEN=… sbatch --export=ALL` over the persistent shell's stdin |
| Forward | `/access` gives the connect token, held in memory; each forwarded port is a `127.0.0.1` listener whose every connection opens a WebSocket to `/sessions/{id}/forward/{port}`; VS Code 1.101 or newer for Node's built-in WebSocket |
| Poll, connect | as for a Dev Tunnel, with Linkspan's API reached through a forward of its control port |
| Stop, delete | release (`POST /stop`) the cs-plane session; delete also `DELETE`s it |

## The per-session SSH host

`csHostAlias(alias, sessionName)` is `<alias>-<last 6 characters of the session name>` — for example
`delta-493119` (`sshHostsStore.ts`). One function builds the `~/.cybershuttle/ssh_config` `Host` line, the
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
  (`tunnelSupport`), their cs-plane counterparts **(experimental)** (`linkTunnel`), the transport choice (`transport`),
  the status domain (`sessionMachine`), lifecycle composition (`sessionSupport`) and the on-disk stores. Modules that
  do not import `vscode` unit-test directly; the ones that do cannot be imported under the test runner at all.
- **`src/ui/`** — Preact webviews, one esbuild bundle per view. `logic/` is pure and tested, `components/` renders,
  `platform/vscode.ts` is the only thing that talks to the webview host (`post()` out, `useWebviewState()` in).
- **`resources/`, `scripts/`** — the activity-bar icons, and the `SSH_ASKPASS` helpers (`askpass.js`, `askpass.sh`).

The testability seam is extraction, not injection: to make `vscode`-coupled logic testable, move the pure or
effect-light part into a `vscode`-free module and test that. `slurmLaunch` is the pattern — it takes an injected
`RemoteRunner` and `LogSink`, mutates only the in-memory session, and leaves persistence to its caller.

## Session status model

Statuses are `not_started`, `submitting`, `queued`, `preparing`, `ready_to_connect`, `connecting`, `connected`,
`stopping`, `stopped`, `failed`, `unreachable` (`models.ts`). The predicates that gate behaviour
live in `sessionMachine.ts` as the single source of truth shared by the provider, the monitor and the webview:
`isTerminal` (stopped/failed), `isDeletable` (terminal plus `not_started`), `isStoppable`, `isReachable`
(`ready_to_connect`/`connecting`/`connected`). `computeStatusTransition(current, slurmStatus)` is the pure poll-loop
transition table. `SessionMonitor` owns poll-driven transitions; `SessionProvider` owns user-action transitions and
every dialog.

## SSH transport

`SshManager` holds one persistent `ssh … bash -l` per SSH host and multiplexes every remote command over it, framing
each call with a random marker to demux stdout, stderr and exit code (`sshSupport.ts`, `sshShell.ts`). A per-SSH-host
serial queue keeps one command in flight; a dropped shell reconnects lazily on the next command. This in-process
multiplexing is what makes Windows work, where OpenSSH has no Unix-socket ControlMaster; on Unix a ControlMaster
socket (named by a SHA-256 of the SSH host's alias, to stay under the 104-byte socket-path limit) is layered on as well
so several windows share one authentication. Background polls run in a batch mode that rides an existing shell or
fails fast, so they never raise a 2FA prompt nobody is watching. Password, passphrase and keyboard-interactive
prompts go out through the `SSH_ASKPASS` helper, which IPCs to a `csbridge.sshAuth` webview panel: a
newline-preserving monospace block is what lets a device-flow QR prompt render, which an input box cannot do.

## Persistence and cross-window state

Sessions are one JSON record per id under `~/.cybershuttle/sessions/`, guarded by a cross-process file lock
(`fsSupport.ts`); an `fs.watch` on the directory syncs state across VS Code windows (`extensionStore.ts`). Every
write goes through that locked read-modify-write: windows share these records, so a write that bypasses the lock
drops another window's update. Only reattach references are persisted — `sshTunnelId`, `sshPort`, `region` and
`apiPort`, the last so a reattached session health-pings the Dev Tunnel instead of polling the SSH host — while
secrets and the ephemeral local port stay in memory. On load, `connected` and `connecting` demote to
`ready_to_connect` (the Dev Tunnel connection is gone after a reload). Run history and usage live separately, one file per session under `~/.cybershuttle/metrics/` (`sessionMetricsStore.ts`).

A remote window recognises itself: `extension.ts` reads the workspace URI authority, and in an
`ssh-remote+<alias>` window it scopes the Sessions view to that one session, observe-only, and sets the
`csbridge.remote` context so the SSH Hosts and Run History views hide.

## Build pipeline

`esbuild.js` runs two esbuild contexts plus a codicon copy. The extension bundles `src/extension.ts` to
`out/extension.js` (CJS, `platform: node`, `target: node20`, `vscode` and `node-rsa` external). The webviews bundle
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
