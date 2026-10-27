# CS Bridge

[![CI](https://github.com/cyber-shuttle/CS-Bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/cyber-shuttle/CS-Bridge/actions/workflows/ci.yml)
[![VS Marketplace](https://vsmarketplacebadges.dev/version-short/cybershuttle.csbridge.svg)](https://marketplace.visualstudio.com/items?itemName=cybershuttle.csbridge)
[![Installs](https://vsmarketplacebadges.dev/downloads-short/cybershuttle.csbridge.svg)](https://marketplace.visualstudio.com/items?itemName=cybershuttle.csbridge)
[![License](https://img.shields.io/github/license/cyber-shuttle/CS-Bridge?color=blue)](LICENSE)

CS Bridge lets you work on a high-performance computing (HPC) cluster's compute node from VS Code as if it were your
own machine. Pick a cluster, say how much CPU, memory, GPU and time you need, and CS Bridge gets you a VS Code
window on the node Slurm gives you, with the editor, terminal and debugger running next to your code and data.

<img src="https://raw.githubusercontent.com/cyber-shuttle/CS-Bridge/HEAD/docs/media/demo-sidebar.webp" alt="Requesting a compute node and watching the job start" width="360">

## What You Can Do

### Use the clusters you already have

The SSH Hosts view lists the hosts in your `~/.ssh/config`. Add a cluster by pasting the `ssh` command you already
use, edit or remove a host, or open a terminal on it.

<img src="https://raw.githubusercontent.com/cyber-shuttle/CS-Bridge/HEAD/docs/media/01-hosts.png" alt="SSH Hosts view" width="360">

### Request a compute node from a form

Choose the partition, Slurm account, CPUs, memory, GPUs and walltime from what the cluster offers. CS Bridge writes
and submits the job; there is no batch script to maintain.

<img src="https://raw.githubusercontent.com/cyber-shuttle/CS-Bridge/HEAD/docs/media/02-new-session.png" alt="New session form" width="360">

### Code on the compute node

Click **Connect** and a new VS Code window opens on the node. Extensions, terminals, debugging and notebooks work as
they do locally, against the node's CPUs and GPUs.

<img src="https://raw.githubusercontent.com/cyber-shuttle/CS-Bridge/HEAD/docs/media/05-remote-window.png" alt="VS Code running on a compute node" width="640">

### Watch your job live

Each session shows its job state, remaining walltime, and its current CPU, memory and GPU use, so you can see a
queued job start and spot an idle or overloaded one.

<img src="https://raw.githubusercontent.com/cyber-shuttle/CS-Bridge/HEAD/docs/media/03-sessions.png" alt="Sessions view with live usage" width="360">

### Keep working across windows and restarts

A session outlives its VS Code window. Close the window and **Connect** again later, **Switch** to a session open in
another window, **Stop** a job to release its allocation, or **Start** a finished session again with the same
resources.

### See how well each run used its allocation

When a session ends, a summary tab shows what it requested, what it used and Slurm's accounting for it. The Run
History view keeps every run's CPU and memory efficiency, so you can right-size the next request.

<img src="https://raw.githubusercontent.com/cyber-shuttle/CS-Bridge/HEAD/docs/media/06-summary.png" alt="Session summary" width="640">

<img src="https://raw.githubusercontent.com/cyber-shuttle/CS-Bridge/HEAD/docs/media/04-run-history.png" alt="Run History view" width="360">

### Get through firewalls without opening ports

Connections reach the compute node through a Microsoft Dev Tunnel that the node opens itself, so the cluster needs
no inbound port and no change from its administrators. A cluster's MFA prompt is answered once and reused while you
work.

### Experimental

Turn on `csbridge.experimentalFeatures` to try these. They may change or disappear between releases.

- **EC2 instances** — sign in to AWS from **CS Bridge: Open Menu**, create a cloud VM by region, instance type and
  image, and start, stop, connect and delete it like any other session.
- **CyberShuttle sign-in** — sign in to CyberShuttle from the menu and connect through it instead of a Dev Tunnel.

<img src="https://raw.githubusercontent.com/cyber-shuttle/CS-Bridge/HEAD/docs/media/07-ec2.png" alt="EC2 instance sessions" width="360">

## Supported Clusters

CS Bridge is tested on the following ACCESS clusters (🟢 supported, 🟡 partially tested, 🔴 unsupported). Any Slurm
cluster whose compute nodes have outbound internet access should work. Results from other clusters are welcome in
the [issue tracker](https://github.com/cyber-shuttle/CS-Bridge/issues).

| Name | Hostname | Slurm | Architecture | Compatibility |
|---|---|---|---|---|
| Anvil | `anvil.rcac.purdue.edu` | 25.11 | x86_64 | 🟢 |
| Bridges-2 | `bridges2.psc.edu` | 22.05 | x86_64 | 🟢 |
| Delta | `login.delta.ncsa.illinois.edu` | 25.11 | x86_64 | 🟢 |
| DeltaAI | `dtai-login.delta.ncsa.illinois.edu` | 25.11 | aarch64 | 🟢 |
| Expanse | `login.expanse.sdsc.edu` | 23.02 | x86_64 | 🟢 |
| Stampede3 | `stampede3.tacc.utexas.edu` | 23.11 | x86_64 | 🟢 |

## Getting Started

You need VS Code 1.101 or newer, SSH access to a Slurm cluster, and a free Microsoft account.

1. Install CS Bridge from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=cybershuttle.csbridge),
   or search for `CS Bridge` in the Extensions view.
2. Open CS Bridge from the activity bar and sign in with a Microsoft account, used only for the Dev Tunnel.
3. Pick an SSH host, or add one by pasting its `ssh` command.
4. Fill in the resource form and click **Start**.
5. Once the job runs, click **Connect**. A new VS Code window opens on the compute node.

## FAQ

1. **How does CS Bridge differ from Remote-SSH?**

   Microsoft's [Remote-SSH](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-ssh) opens a
   window on a machine you can already SSH to. CS Bridge first gets you a compute node, which you usually cannot
   SSH to directly, then hands the window to Remote-SSH.

2. **Which operating systems are supported?**

   Windows, macOS and Linux, wherever VS Code and OpenSSH run. The cluster needs a Unix-like environment with SSH
   and Slurm.

3. **Do VS Code forks work?**

   VS Code Insiders, Cursor and other forks with Remote-SSH and Marketplace access usually work but are not tested.

4. **Why am I asked for MFA again?**

   A cluster login is reused until it has been idle for ten minutes. After that, the cluster prompts again.

5. **Why do my remote extensions reinstall every session?**

   Each job runs on a fresh node. List the extensions you always want in Remote-SSH's `remote.SSH.defaultExtensions`
   setting and they install automatically.

6. **Why is the minimum 2 CPUs and 4 GB?**

   Less than that starves VS Code on the node, and it gets killed for exceeding its memory.

7. **Why is file transfer slower than plain SSH?**

   Dev Tunnels cap throughput at tens of Mbit/s. Move large data through the cluster's login node with `scp` or
   `rsync`.

8. **What does CS Bridge store, and how do I remove it?**

   See [Files on disk](docs/ARCHITECTURE.md#files-on-disk).

## Troubleshooting

1. **Microsoft sign-in fails.** Your network must allow `login.microsoftonline.com` and `*.devtunnels.ms`.
2. **A session stays on `Submitting…`.** The first launch downloads a small agent from GitHub onto the cluster,
   which needs outbound internet access. Its logs are in `~/.cybershuttle/logs/` on the cluster.
3. **The remote window disconnects.** CS Bridge reconnects on its own; if that fails, click **Connect** again and
   check `View > Output > CS Bridge`.
4. **The remote window crashes or reports `No ptyHost heartbeat`.** The job ran out of memory. Start the session
   again with more.
5. **Dev Containers errors in the remote window.** Clusters do not provide a container runtime; disable the
   extension for that window.

## Privacy

CS Bridge collects no analytics. Your SSH credentials and session traffic pass only between you, the cluster and
Microsoft Dev Tunnels; AWS credentials **(experimental)** go only to AWS.

## Learn More

- [Architecture](docs/ARCHITECTURE.md) — how a session is launched, tunnelled, connected and stored.
- [Contributing](CONTRIBUTING.md) — building from source, development setup and the pull-request workflow.
- Paper — in preparation; the link will appear here once it is published.
- [Changelog](CHANGELOG.md) — what changed in each release.

## Getting Help

Search the [issue tracker](https://github.com/cyber-shuttle/CS-Bridge/issues) before opening an issue. The bug form
asks for the `View > Output > CS Bridge` log and the cluster's `~/.cybershuttle/logs/` output.

## Roadmap

CS Bridge is pre-1.0, and interfaces may change between releases. The following work is planned, in no particular
order.

- [ ] **Issue reporting from the extension** — file an issue with a typed description and an automatically captured stack trace.
- [ ] **Queue visibility** — queued jobs, queue positions and estimated start times shown in the Sessions view.
- [ ] **Opt-in analytics** — anonymous analytics to a central endpoint, sent only after explicit consent.
- [ ] **Cloud VM support** — EC2 is in **(experimental)**; other providers, and running a session's job on the instance, are to follow.
- [ ] **File mounts** — mount local files and external datasets into the remote session.
- [ ] **Checkpoint and restore** — checkpoint a session and resume it in another job with its running processes intact.

## Contributing

Issues and pull requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) covers development setup and the
pull-request workflow, and participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md). Security problems
go through [SECURITY.md](SECURITY.md), not the issue tracker.

## Citing

CS Bridge is part of CyberShuttle, the ARTISAN group's toolset for interactive HPC work. If it supports your
research, please cite:

```bibtex
@software{cybershuttle,
  title  = {CyberShuttle: Remote HPC Development from VS Code},
  author = {{ARTISAN Research Group, Georgia Institute of Technology}},
  year   = {2026},
  url    = {https://github.com/cyber-shuttle/CS-Bridge}
}
```

## Acknowledgments

Developed by the [ARTISAN research group](https://gt-artisan.github.io/) at Georgia Tech. Built on
[Linkspan](https://github.com/cyber-shuttle/linkspan), [Dev Tunnels](https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/)
and [OpenSSH](https://www.openssh.com/).

## License

[Apache-2.0](LICENSE)
