# CS Bridge documentation

How CS Bridge works, for contributors and reviewers. What it does for users is in the [project README](../README.md);
how to build and contribute is in [CONTRIBUTING.md](../CONTRIBUTING.md).

## Overview

With the default Dev Tunnel transport, CS Bridge opens a VS Code window on a Slurm compute node in three moves:

1. It submits a Slurm job over SSH to the cluster's login node. The job runs the Linkspan agent.
2. Linkspan opens an outbound Microsoft Dev Tunnel and, when CS Bridge asks, starts an SSH server on the node.
3. VS Code connects to that SSH server through the tunnel.

The link transport **(experimental)** is an open-source alternative to Microsoft Dev Tunnels, served by Apache
Airavata. EC2 sessions **(experimental)** are for when you need a VM rather than a cluster. CS Bridge launches an
instance and opens VS Code on it. It reaches the instance over SSH at its public IP. No Slurm job or Linkspan is
involved. See [Backends and transports](05-backends-and-transports.md).

The compute node accepts no inbound connection. The cluster sees only SSH sessions to the login node and a Slurm job.

All of CS Bridge runs in the local extension host (`extensionKind: ["ui"]`), including in windows opened on a
compute node. As a result, every window reads the same local storage. This is how a remote window finds its own
session and hands a Stop to the owner window (`extension.ts`, `remoteSessionController.ts`).

## Components

```text
Local VS Code                              Remote HPC cluster
┌──────────────────────────┐               ┌──────────────────────────┐
│  CS Bridge sidebar       │── OS ssh ────▶│  SSH host (login node)   │
│  (Preact webviews)       │               │  sbatch, sacct, sinfo    │
│                          │               │                          │
│  SshManager              │               │  Compute node (the job): │
│  (one shell per SSH host)│               │  ┌──────────────────┐    │
│  extension storage:      │               │  │  Linkspan        │    │
│    ssh_config, ssh_keys/ │               │  │  ├─ control API  │    │
│                          │               │  │  ├─ sshd         │    │
│  Dev Tunnels relay client│◀─ Dev Tunnel ─│  │  └─ tunnel host ─┼────┼──▶ devtunnels.ms
│  (Linkspan control port) │               │  └──────────────────┘    │
│  127.0.0.1:N listener    │               └──────────────────────────┘
│  (WebSocket per socket)  │
└──────────────────────────┘
         │
         ▼
  VS Code Remote-SSH opens vscode-remote://ssh-remote+<session host>/…
  and its ssh dials 127.0.0.1:N
```

Two separate paths reach the cluster:

- **Control path.** CS Bridge runs the system `ssh` binary against the login node. It uses it to discover
  partitions, submit, poll and stop Slurm jobs (`scancel`), and install Linkspan.
- **Work path.** With the Dev Tunnel transport, the tunnel carries only Linkspan's control port. A local listener,
  `127.0.0.1:N`, carries each SSH connection over a WebSocket to Linkspan's `/api/v1/forward/{sshPort}`. Linkspan
  relays it to the node's SSH server. With the link transport **(experimental)**, the listener's WebSocket goes to
  Airavata's `/sessions/{id}/forward/{sshPort}`. Airavata forwards any port a Linkspan task serves. Remote-SSH connects
  to `127.0.0.1:N`. With the Dev Tunnel transport, Linkspan's API calls go over HTTPS to the tunnel's
  `*.devtunnels.ms` endpoint for the control port. A window without the relay client samples usage through `srun` on
  the login node.

## Terms

| Term | Meaning |
|---|---|
| SSH host | An SSH config entry for a cluster's login node. CS Bridge merges `~/.ssh/config` with the system `ssh_config`. It can edit the first and only reads the second. |
| SSH host alias | The name of an SSH host, such as `delta`. It is stored as the session field `alias`. |
| Login node | The machine an SSH host points at, where Slurm commands run. |
| Session | A saved request for a compute node: SSH host, partition, account and resources. It can be started many times. |
| Run | One start of a session, from submit to end. The Run History view lists runs. |
| Linkspan | The agent CS Bridge installs on the cluster and runs inside each job. It hosts the tunnel and starts SSH servers on request. |
| Control port | The port Linkspan serves its API on, inside the job. It is the only port a Dev Tunnel carries. |
| Dev Tunnel | A Microsoft relay that both ends connect out to. Neither end needs an open port. |
| Relay client | The local end of the tunnel, held by one window. |
| Per-session SSH host | A generated `ssh_config` entry that Remote-SSH uses to reach one session. Its name is `<alias>-<last 6 characters of the session name>`. These docs write it as `<session host>`. |
| Owner window | The local window that polls, connects and stops a live session. The record's `owner` names it. There is normally one. Windows restored together can each claim it briefly. |
| Heartbeat | A file each window rewrites every 20 s. A window without a recent one counts as closed. |
| Remote window | A VS Code window opened on a compute node. |
| Backend | What a session runs on: a Slurm job, or an EC2 instance **(experimental)**. |
| Transport | How the work path is carried: a Dev Tunnel, or link **(experimental)**, an open-source alternative to Microsoft Dev Tunnels served by Airavata. |

## Documents

Read in this order the first time. Each document also stands on its own.

| Document | Covers |
|---|---|
| [Session lifecycle](01-session-lifecycle.md) | a session from creation through start, monitoring, connect, end and delete |
| [Session status](02-session-status.md) | how a status is derived from recorded and live facts |
| [Cross-window state](03-cross-window-state.md) | shared records, heartbeats, the owner window, reattach and remote windows |
| [SSH](04-ssh.md) | the per-session SSH host, SSH host management and the SSH transport to the login node |
| [Backends and transports](05-backends-and-transports.md) | the `Backend` and `Transport` interfaces, the Dev Tunnel transport and feature flags |
| [Link transport](06-link-transport.md) | the Airavata work path **(experimental)** |
| [EC2 instances](07-ec2.md) | sessions on EC2 **(experimental)** |
| [Extension surface](08-extension-surface.md) | views, commands, settings, the menu, webview messages, card actions, Run History and logging |
| [Source layout](09-source-layout.md) | where the code lives, how to extend it, invariants and tests |
| [Storage](10-storage.md) | files on disk, record shape, reset steps and schema migrations |
| [Build and dependencies](11-build.md) | esbuild, type checking, packaging and external dependencies |
