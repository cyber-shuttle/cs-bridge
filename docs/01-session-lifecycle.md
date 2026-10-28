# Session lifecycle

A session is created, started, monitored, connected and ended. Each section below lists one stage's steps in order.
The steps are for a Slurm session over the default Dev Tunnel transport. EC2 sessions are in
[EC2 instances](07-ec2.md).

Statuses along the way:

```text
not_started → submitting → queued → preparing → ready_to_connect → connecting → connected → stopping → stopped
                                                                                                 (or failed)
```

`queued` reads as `unreachable` in the owner window while a `sacct` poll cannot reach the SSH host and the node's SSH
port is not yet known. `submitting` and `stopping` keep their status.

Each status is derived from recorded facts; see [Session status](02-session-status.md).

## Create

1. **Pick a host.** The menu's **Create New SSH Session** lists SSH hosts. Picking one calls `startSessionDraft`
   (`sessionProvider.ts`). This focuses the Sessions view and shows a draft form.
2. **Discover the cluster.** The form's options come from the login node (`getSlurmDiscovery`, `slurmSupport.ts`).
   Once discovery succeeds, they are cached per SSH host in this window, until the form's **Refresh** or **Retry**.
   Discovery reads:
   - accounts from `sacctmgr show associations`. When the login node has a readable `/usr/local/etc/project.map`, each
     account is replaced by its spelling there, and accounts the file does not list are dropped. TACC's submit filter
     expects that spelling;
   - partitions with their CPUs, memory and GPU GRES, from `sinfo -h -o "%P|%c|%m|%G"`;
   - the user's `$HOME`. It becomes the session's folder.

   Discovery fails, and the form offers **Retry**, when:
   - `sinfo` or `echo $HOME` fails;
   - a `sinfo` line cannot be parsed;
   - `sinfo` lists no partitions;
   - `$HOME` is empty.

   The account command never fails on its own. A failing `sacctmgr`, or a `project.map` that lists none of the user's
   accounts, gives an empty list.
3. **Validate and save.** `validateSlurmConfig` runs `sbatch --test-only` with a placeholder script
   (`slurmLaunch.ts`). This applies the site's submit checks without queueing a job. The session is saved
   (`addSession`), as `not_started`, only if Slurm accepts it. A refusal shows **Session validation failed** with
   Slurm's error. The form stays open.

The form (`HostForm.tsx`, `ui/logic/cluster.ts`) splits partitions into CPU and GPU tabs when both kinds exist. It
offers:

| Field | Choices |
|---|---|
| Slurm account | (no Slurm account) or a discovered account. The first discovered account is preselected, or (no Slurm account) when there is none. |
| Partition | those of the chosen tab |
| CPUs | 2 up to the partition's count |
| Memory | 4, 8, 16, … 1024 GB, up to the partition's. The range is 4 to 128 GB when the partition reports none. 2 GB is excluded. It OOM-kills the VS Code server. |
| GPU type and count | from the partition's GRES |

The form has no walltime, so validation sends no `--time`.

## Start

For a Slurm session, **Start** first asks for a walltime, from 30 min to 24 h. The last one is preselected. Escape
cancels. The card shows busy until the preview opens.

1. **Claim and clean up.** **Start** (`sessionProvider.ts`):
   - ends any monitoring loop with its teardown, or waits for a teardown already in flight;
   - drops an unsubmitted preview;
   - claims the session. It stops if another window owns it.

   If the previous run left connection info, that run's teardown runs now. The configured transport and the walltime
   are then written to the record. This way a run keeps the transport it started with.

   Start does nothing while:
   - another Start in this window is preparing;
   - this window runs a task for the session;
   - this window is connecting the session.

2. **Prepare.** `prepareLaunch` (`sessionSupport.ts`):
   - picks a control port, `20000 + random(12000)`;
   - clears the previous run's live samples and stats;
   - asks the transport to prepare. For a Dev Tunnel this deletes the previous run's tunnel, creates a new one,
     registers the control port on it and mints the job's host token (see [Dev Tunnel
     transport](05-backends-and-transports.md#dev-tunnel-transport));
   - clears the session's error message;
   - builds the job script with `buildSlurmScript` (`slurmParse.ts`).

3. **Preview.** The script is shown for review. Dismissing the preview drops the draft, runs the teardown and gives up
   the claim. The teardown releases the transport's hold. For link, it stops the attached Apache Airavata session.

   **Submit**:
   - discards the draft;
   - resets the record's run fields. It sets `desired: 'running'` and `submittedAt`. It clears `observed`, `failure`,
     `errorMessage`, `startedAt` and `jobId`;
   - marks the session as launching (`submitting`);
   - continues with `SlurmBackend.start` (`sessionSupport.ts`).

4. **Check for Slurm.** `checkSlurmAvailability` runs `sinfo` on the login node. A non-zero exit stops the launch.

5. **Install Linkspan if needed.** `installLinkspan` runs when `~/.cybershuttle/bin/linkspan` is:
   - missing, or its version check fails (an SSH error or unparsable output);
   - older than the latest Linkspan release. A commit build `X.Y.Z.<sha>` counts as older once release `X.Y.Z`
     exists;
   - older than 0.22.0, the first release with `/usage` and `--tunnel-mode link`.

   It reads the login node's `uname -m`, downloads the matching release asset, stages it, and moves it into place
   with mode `0700`. The binary sits in the shared `$HOME`. This assumes compute nodes share the login node's
   architecture.

   The check runs on the login node. It runs `linkspan --version`. It reads with `curl` the tag that GitHub's
   `releases/latest` redirect resolves to. If the latest tag cannot be read, a working binary is kept. The install also
   runs on the login node, with `curl` and `tar`. This needs outbound HTTPS to GitHub from the login node.

   | `uname -m` | Asset |
   |---|---|
   | `x86_64` | `linkspan_Linux_x86_64.tar.gz` |
   | `aarch64`, `arm64` | `linkspan_Linux_arm64.tar.gz` |
   | anything else | refused, with the architecture named in the error |

6. **Submit.**
   - The job script is piped, base64-encoded, into `sbatch`.
   - The transport's token is passed as an environment assignment on the `sbatch` command, with `--export=ALL`. It is
     `LINKSPAN_TUNNEL_HOST_TOKEN` for a Dev Tunnel and `LINKSPAN_LINK_TOKEN` for the link transport. The command is
     sent over the persistent shell's stdin. This keeps the token out of the job script and any process's argv. A
     failed `sbatch` with empty stderr reports the whole command, token included. The report is shown, logged, and
     recorded as the session's `failure` and `errorMessage`.
   - The job id, the run's connection info and a fresh `submittedAt` are saved on the session record. Monitoring then
     starts.

**Failures.**

- If Prepare fails, the error is shown and set as `errorMessage`. The session is released. The status does not
  change.
- If any step from the Slurm check to `sbatch` fails, the session is marked failed. `fail` (`extensionStore.ts`) sets
  `failure` and `errorMessage`. The run is torn down. The error asks the user to clean up on the cluster.

### The job script

`buildSlurmScript` writes:

- `#SBATCH` lines for job name, nodes, tasks, CPUs, memory and partition, plus time, account and `--gres` when set;
- output and error logs at `~/.cybershuttle/logs/linkspan-session-$SLURM_JOB_ID.{out,err}`;
- `unset XDG_RUNTIME_DIR TMPDIR`. Compute nodes have no logind. Without it, the inherited `/run/user/$UID` does not
  exist there. Unsetting both makes the VS Code server use node-local `/tmp`;
- `linkspan --port <controlPort> --tunnel-enable <transport args>`.

### Linkspan API

CS Bridge uses these endpoints on the control port. They are in `linkspanSupport.ts`. The forward is in
`tunnelSupport.ts` and `linkTunnel.ts`.

| Endpoint | Used for |
|---|---|
| `POST /api/v1/vscode/sessions` with `{ref, authorized_key}` | start, or return, the SSH server for the session's key. `ref` is `ssh-` plus 16 hex characters of the key's SHA-256. |
| `GET /api/v1/usage` | the live usage sample, and the health check |
| `WS /api/v1/forward/<port>` | relays one TCP connection to a port on the node. Dev Tunnel transport only. Link uses Airavata's forward. |

## Monitor

`SessionMonitor` (`sessionSupport.ts`) runs one timer per active session in the owner window. The timer ticks every
5 s. Each tick does one of three things, depending on the session's status:

| Status | Tick |
|---|---|
| `submitting`, `queued`, `unreachable`, `stopping`, or no tunnel yet | reads the job state from `sacct`. When the job first reads `RUNNING`, `startedAt` is set from `sacct`'s `ElapsedRaw`. The walltime countdown then follows Slurm's clock. |
| `preparing` | calls `ensureRemoteSession`. It asks Linkspan for an SSH server that accepts the session's public key. Success records the node's `sshPort`, and the session becomes `ready_to_connect`. Failure means Linkspan is not up yet. The session stays `preparing`, and `errorMessage` records why. The card shows only "Starting Linkspan…". The exception is Airavata's not-ready answer, which is only logged. The first call creates the session's key pair (`sessionPublicKey`, `sshSupport.ts`). |
| `ready_to_connect`, `connecting`, `connected` | pulls a usage sample from `/api/v1/usage`. This is the health check. |

Details:

- **Repeated requests.** The `ensureRemoteSession` request carries a `ref` derived from the session's key. Linkspan
  answers a repeat with the server already running.
- **Two routes to `/usage`.** Through the tunnel while this window's relay client is connected. Otherwise from the
  login node with `srun --jobid=<id> --overlap --quiet --input none curl -sf --max-time 4
  http://127.0.0.1:<controlPort>/api/v1/usage` (`slurmSupport.ts`).
- **Liveness is the body.** Once Linkspan is gone, the Dev Tunnel edge answers `/usage` with an HTML page and status
  200. A sample counts only if the response is 2xx and its body parses as a JSON object.
- **Giving up on probes.** Failed `/usage` probes and failed `ensureRemoteSession` calls both count. After 6 in a
  row, each tick reads `sacct` instead. A terminal job state ends the run. Any other reading resets the count. A
  `sacct` with no row reads as `UNKNOWN`. This shows the session as `queued`, without Connect or probing, until
  `sacct` reports `RUNNING` again. An SSH error during this check keeps the count. The next tick then reads `sacct`
  again. Apart from a Stop, only `sacct` or the walltime ends a run. A failed probe never does.
- **Before and after each tick.** A tick first checks two things. If this window no longer owns the session, the tick
  stops the loop and disposes the relay client. If the status is terminal, the tick ends the run.

  A tick that reads `sacct` (a status in the first row) and cannot reach the SSH host marks the session `unreachable`
  and sets `errorMessage`. The next good tick clears both. In `preparing` and the connectable statuses, an unreachable
  SSH host only counts as a failed probe.

  SSH polls never prompt. They use the SSH host's shell, or open one with `BatchMode=yes`. That mode fails rather than
  prompting. A `preparing` tick refreshes the Dev Tunnel through the Microsoft account and can ask for a sign-in.
- **Samples and stats.** Each good sample that carries `memBytes` is appended to the session's run file. Slurm
  accounting stats are refreshed from `sacct` at most every 30 s. Retention is in
  [Storage](10-storage.md#files-on-disk).

## Connect

**Connect** calls `connectSession` (`sessionProvider.ts`):

1. If the session is already `connected`, it focuses the session's remote window, or opens one if none is open or
   opening. It then stops.
2. Otherwise this window claims the session (see [Owner window](03-cross-window-state.md#owner-window)) and starts
   monitoring it. If another window with a live heartbeat owns it, Connect says so and stops.
3. `SlurmBackend.connect` (`sessionSupport.ts`) runs, in order:
   - returns at once if a connect for the session is already in progress;
   - fails at once if the session's SSH key is missing;
   - `ensureRemoteSession` again. It refreshes the tunnel credentials. It returns the running SSH server, or the known
     `sshPort` if Linkspan does not answer. The result is saved on the session;
   - `connectSessionToTunnel`. It connects the relay client to the control port and binds `127.0.0.1:N`. The bound
     port is saved on the session;
   - `syncSshConfig`. It writes the per-session SSH host (see [SSH](04-ssh.md#server-install-path-and-sync)).
4. When `connect` succeeds, `openOrFocusWindow` opens `vscode-remote://ssh-remote+<session host>/…` in a new
   window. The card shows "Opening…" until that window's heartbeat appears, or for at most 60 s.
5. Remote-SSH runs `ssh <session host>`, which reaches `127.0.0.1:N`. It installs the VS Code server on the node
   and attaches the window.

**Half-open tunnel.** The relay client sends a keep-alive every 15 s. 4 consecutive misses (`transport.ts`) take about
a minute. After them, `reconnect` (`sessionSupport.ts`) reruns `connect` if the session is still reachable. While the
relay client is reconnecting, this window's `connected` live fact is cleared.

**Failed connect.** A failed connect disposes the relay client, clears `localPort` and sets `errorMessage`. It shows no
notification. The card does not show the error. The next good `/usage` sample clears it. The session stays
`ready_to_connect`, and Connect can be retried. A job that ends during the connect gets no new connection info. The
connect fails with "the job ended", and the monitor tears the run down.

## End

**Stop.**

1. **Stop** asks for confirmation. It then writes `desired: 'stopped'` and clears `errorMessage` on the record
   (`requestStop`, `extensionStore.ts`). Any window can do this.
2. The owner window runs the stop. When no window with a live heartbeat owns the session, the first local window to
   look runs it. That window sees the change in `reattachLiveSessions`. It runs `scancel` on the login node. It then
   records the job as `CANCELLED`, ends the monitoring loop and runs the teardown (`endSession`).
3. If `scancel` fails, `sacct` is read once more. If the job has ended anyway, the teardown runs as usual. If it has
   not, the stop is abandoned: `desired` goes back to `running`, `errorMessage` records the failure, and a
   notification says the session is still running.

In a session's remote window, Stop (card or status bar) also queues the run summary and returns that window to local
(`remoteSessionController.ts`). The window does the same when the session turns `stopped` or `failed`.

A Stop asked while `submitting` is carried out on the first record or heartbeat change after the submit task
finishes. Only the launching window shows `submitting`. Until `sbatch` returns a job id, other windows show the
session as `not_started`, with Start and ×. Start or Delete there reports that another window is driving it.

**Teardown.** When a run ends, `endSession` stops the monitoring loop. This releases the owner claim. `endSession` then
calls `SlurmBackend.end` (`sessionSupport.ts`), which:

- records the run in Run History;
- disposes the relay client and clears the session's connection info;
- releases the run through the transport. For the link transport, this stops the Airavata session.

The Dev Tunnel itself is kept until the next Start on the Dev Tunnel transport, or a delete. A Start on the link
transport leaves it until the delete.

**Walltime.** A session whose deadline (`startedAt` plus walltime) has passed reads as `stopped` even when `sacct`
cannot be reached. A run whose deadline passed while VS Code was closed is torn down on the next activation.

**Run History.** `recordSessionRun` (`sessionRunSupport.ts`) snapshots the run and fetches Slurm stats again until
`MaxRSS` is reported. It makes up to 2 retries, 3 s apart. Runs are de-duplicated by SSH host alias and job id
(`runStore.ts`). Recording starts without being awaited, before the transport is released. Edge cases:

- A launch that got no job id records nothing.
- A session deleted during the stats wait keeps no run.
- Without a fresh `sacct` reading, the in-run stats are kept.
- An EC2 run records nothing.

## Delete

**Delete** is the card's ×. It is shown for `not_started`, `stopped` and `failed`. After confirmation,
`confirmAndDeleteSession` (`sessionProvider.ts`):

1. does nothing while a task for the session runs. Otherwise it ends any loop with its teardown, or waits for a
   teardown in flight, then claims the session. It stops if another window owns it;
2. disposes this window's relay client;
3. calls the backend's `remove`. For Slurm, this deletes the session's Dev Tunnel, its Airavata session and its SSH
   key. For EC2, it terminates the instance;
4. deletes the record and its runs file. Its Run History rows go too. The next `syncSshConfig` drops its SSH host.
