# Storage

Everything CS Bridge persists, locally and on the cluster, how to reset it, and how the storage format is migrated.
How windows share these files is in [Cross-window state](03-cross-window-state.md).

## Files on disk

**Local.**

| Where | What |
|---|---|
| Extension storage `sessions/` | one session record per id |
| Extension storage `runs/` | one file per session: its last 10 runs, last 20 live samples and latest Slurm stats (`runStore.ts`) |
| Extension storage `windows/` | one heartbeat per window |
| Extension storage `ssh_keys/` | per-session keys `id_cshost-<sessionId>` (ed25519, no `.pub` kept); EC2 key pairs `cs-aws-generated-key-<region>-<machine>` **(experimental)** |
| Extension storage `ssh_config` | the per-session SSH hosts |
| Extension storage `schema.json`, `migrate.lock`, `opened.marker` | storage version, its migration lock, and the marker that shows the install message once |
| `~/.ssh/config` | one `Include` line for the extension's `ssh_config`. It is prepended so per-session hosts match first. Also the `Host` blocks added, edited or deleted in SSH Hosts. |
| Extension storage `<file>.<uuid>.tmp` beside each record and `schema.json` | staging file for each write (`storage.ts`) |
| VS Code logs folder | the "CS Bridge" log output channel (`logger.ts`) |
| VS Code user setting `remote.SSH.serverInstallPath` | an entry for the per-session SSH host of each Slurm session whose record holds a `localPort`, mapped to `/tmp/cs-vscode/<sessionId>`. The entry is written when the owner binds `127.0.0.1:N`. It is left behind when that window closes. Entries not under `/tmp/cs-vscode/` are left alone. |
| VS Code `globalState` | `csbridge.pendingSummaries`: the queue of pending session summaries |
| VS Code user setting `csbridge.transport` | written by Default Transport **(experimental)** |
| `csbridge-ssh` in `$XDG_RUNTIME_DIR` or the temp folder | SSH ControlMaster sockets, not on Windows. If that folder is not private to the user, each window uses a fresh `csbridge-*` temp folder. |
| OS keychain | the Microsoft account token, held by VS Code |
| VS Code SecretStorage | `csbridge.plane.credential` and `aws.credentials` **(experimental)**. Each is kept until sign-out, or until Apache Airavata or AWS refuses it. |
| `cs-askpass-*` in the temp folder | prompt, response and cancel files for one interactive SSH connect. They are removed when its shell exits. |
| `<file>.lock`, `<file>.tmp` beside `~/.ssh/config` and `ssh_config` | the writer's pid lock and its atomic-rename staging file. A lock whose pid is dead is reclaimed (`fsSupport.ts`). |

Files from older versions in `~/.cybershuttle` are moved into extension storage on activation. VS Code removes
extension storage on uninstall.

**Cluster.**

| Where | What |
|---|---|
| `~/.cybershuttle/bin/linkspan` | the agent. It is checked on every launch and reinstalled when needed. |
| `~/.cybershuttle/logs/linkspan-session-<jobId>.{out,err}` | Linkspan output per job |
| `/tmp/cs-vscode/<sessionId>` on the compute node | the session's VS Code server, node-local |

**Reset.** In this order:

1. Sign out of CyberShuttle and AWS in the menu, with `csbridge.experimentalFeatures` on. This clears their
   SecretStorage credentials.
2. Quit VS Code. An open window rewrites the storage folder. The next activation recreates empty storage and its
   `Include`.
3. Remove the `cybershuttle.csbridge` folder in VS Code's `User/globalStorage`.
4. Remove its `Include` line in `~/.ssh/config`.
5. Remove the CS Bridge entries in the `remote.SSH.serverInstallPath` setting.
6. Remove `~/.cybershuttle/` on the cluster.

Removing the storage folder does not clear SecretStorage or the `globalState` summary queue.

Dev Tunnels, Airavata sessions and EC2 resources (instances, key pairs, security groups) live in those accounts.
Deleting a session removes its own Dev Tunnel, Airavata session or instance. These stay:

- the per-region EC2 key pair;
- the `CS-Bridge SSH Access` security group;
- a default VPC created for a region that had none;
- the key pair's private key in `ssh_keys/`.

## Record shape

Field names match Airavata's wire types. The status-related fields are listed in
[Session status](02-session-status.md#recorded-facts). The others:

| Field | Meaning |
|---|---|
| `id` | a uuidv7. Sorting by id gives creation order. |
| `name` | creation time in ms, or the instance id for an adopted EC2 instance. Its last six characters name the per-session SSH host. |
| `alias`, `account`, `partition`, `rootFolder`, `resources` | the request. An empty `account` submits without `--account`. `rootFolder` is the folder the window opens. `resources` holds `cores`, `memoryMb`, `wallMinutes`, `gpuType`, `gpuCount`. |
| `submittedAt` | the last submit, or the creation time before the first |
| `transport`, `devtunnel`, `planeId` | `transport` is the latest run's transport. `devtunnel` (`{id, cluster}`) is the Dev Tunnel of the last run that used one. It is kept until the next Dev Tunnel Start or until Delete. `planeId` is the Airavata session of the latest link run. Each link Start replaces it. It is kept until Delete. |
| `connectionInfo` | `controlPort`. `sshPort`: 0 until Linkspan's SSH server is up, or 22 once an EC2 instance's port 22 answers. `localPort`: the `127.0.0.1` listener bound by the window that last connected. It is kept after that window closes. |
| `owner` | see [Owner window](03-cross-window-state.md#owner-window) |
| `ec2` | see [EC2 instances](07-ec2.md#model) |

A run is a `Run` with `RunStats` and `samples`.

## Schema migrations

`schema.json` in extension storage holds the storage version. The current one is `SCHEMA_VERSION = 4` (`store.ts`).
At activation, `openStorage` (`storage.ts`) calls `migrate()` before any store is read. It:

1. reads the version on disk;
2. runs each step in `legacySteps` (`schema.ts`) from that version up to `SCHEMA_VERSION`, under a lock;
3. saves the new version after each step.

The stores read only the current shape. Two exceptions: `runStore` fills `samples` for runs recorded before 0.2.4, and
`wallMinutes` with 0 for a run step 3 → 4 found without a session.

A fresh install starts at version 0, so every step runs. Without `~/.cybershuttle` the steps change nothing. But step 0
locks `~/.ssh/config`. So on a machine without `~/.ssh/`, activation fails until that folder exists.

| Step | Change |
|---|---|
| 0 → 1 | inside `~/.cybershuttle`: splits `sessions.json` into `sessions/`, renames fields to Airavata's names, reissues non-uuid ids, turns `metrics/` into `runs/`, removes `ssh_hosts` and its `Include` |
| 1 → 2 | moves records and SSH keys from `~/.cybershuttle` into extension storage, removes the old `Include` and CS Bridge's entries in `~/.cybershuttle` |
| 2 → 3 | replaces the stored status with `desired`, `observed` and `failure` |
| 3 → 4 | gives each run without a walltime its session's current one |

| Change | Rule |
|---|---|
| A persisted field or file changes shape | Bump `SCHEMA_VERSION`, add the step to `legacySteps`, and update `models.ts` and the stores to the new shape only |
| A step | Deterministic and idempotent. Then it can be rerun after a crash before the version is written. A second window that read the old version can also rerun it. |
| Storage newer than the build | Refused at activation with an error, never read |
| A version without a step | Refused at activation with an error |
