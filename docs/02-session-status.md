# Session status

A session's status is not stored. Windows record facts. `statusOf` (`extensionStore.ts`) derives the status from
them on every read, with `deriveStatus` (`sessionMachine.ts`).

No window writes a status, so no writer can overwrite another's:

- A Stop is the `desired` field. A reload does not reset it.
- A passed deadline reads as `stopped`. The exceptions: a failure is recorded, or the job state is `FAILED` or
  `OUT_OF_MEMORY`.
- After a record is created, only the owner window writes `observed`.
- A tick whose loop has ended writes nothing. It checks `alive()`. A reading in flight when a run ends is therefore
  dropped.

## Recorded facts

On the session record, shared by every window:

| Field | Meaning |
|---|---|
| `desired` | What the user asked for: `running` or `stopped`. |
| `observed` | The job state last read from the backend. |
| `failure` | Why a launch failed. `fail` sets it when a submit fails. The next Submit clears it. |
| `jobId` | For Slurm: the job id. It is empty until `sbatch` returns, and each Submit clears it. For EC2: the instance id. It is kept across Starts while the instance exists. A Start that launches a new instance replaces it. |
| `startedAt`, `resources.wallMinutes` | When the job started, and its walltime. Together they give its deadline. |
| `connectionInfo.sshPort` | The node's SSH server port. It is set once Linkspan has started the server. For EC2 it is 22, set once the instance's port 22 answers. |
| `errorMessage` | The latest error. The card shows it only for `unreachable`, `stopped` (as a tooltip) and `failed`. `fail` sets it together with `failure`. The next success, Stop or Submit clears it. Unlike `failure`, it does not change the status. |

## Job states

`classifySchedulerState` (`slurmParse.ts`) maps `sacct`'s `State` to the `observed` job state. It uses the first
token, without a trailing `+`.

| Slurm state | Job state |
|---|---|
| `PENDING`, `REQUEUED`, `REQUEUE_FED`, `REQUEUE_HOLD`, `SUSPENDED`, `STOPPED` | `QUEUED` |
| `RUNNING`, `CONFIGURING`, `COMPLETING`, `RESIZING`, `SIGNALING`, `STAGE_OUT` | `RUNNING` |
| `COMPLETED`, `CANCELLED`, `TIMEOUT`, `OUT_OF_MEMORY` | the same |
| `BOOT_FAIL`, `DEADLINE`, `FAILED`, `NODE_FAIL`, `PREEMPTED`, `REVOKED`, `SPECIAL_EXIT` | `FAILED` |
| anything else, or no row yet | `UNKNOWN`. The session reads `queued`, even after it has run. This lasts until a known state arrives or, once `startedAt` is set, until its deadline. |

`SUSPENDED` and `STOPPED` still hold their nodes. They therefore read as queued.

## Live facts

Each window computes these from `extensionStore.live` and the window heartbeats:

| Fact | Meaning |
|---|---|
| `launching` | This window is submitting the job. |
| `connecting` | This window is opening a connection. |
| `connected` | This window holds a connection, or any window's heartbeat names the session as its remote window. For EC2, "holds a connection" means this window has connected the session. It also does that when it takes over a running instance. |
| `unreachable` | This window's last poll could not reach the SSH host or the AWS API. A failing `sacct` on a reachable host reads as `UNKNOWN` instead. A failed `/usage` or Linkspan call counts as a failed probe. |

## Derivation

`deriveStatus` checks the rows below in order. The first match wins.

| Order | Status | When |
|---|---|---|
| 1 | `failed` | a failure is recorded |
| 2 | `submitting` | this window is launching it |
| 3 | `not_started` | no job has been submitted |
| 4 | `failed` | the job state is `FAILED` or `OUT_OF_MEMORY` |
| 5 | `stopped` | the job state is `COMPLETED`, `CANCELLED` or `TIMEOUT`, or the deadline has passed |
| 6 | `stopping` | the user asked to stop and the job has not ended yet |
| 7 | `unreachable` | the last poll failed and the node's SSH port is unknown |
| 8 | `queued` | the job is not running yet |
| 9 | `preparing` | the job runs but the node's SSH server is not up yet |
| 10 | `connected` | the `connected` live fact holds |
| 11 | `connecting` | this window is opening a connection |
| 12 | `ready_to_connect` | otherwise |

## Predicates

Predicates beside `deriveStatus` gate behaviour:

| Predicate | True for |
|---|---|
| `isTerminal` | `stopped`, `failed` |
| `isDeletable` | terminal, or `not_started` |
| `isStoppable` | `submitting`, `queued`, `preparing`, `ready_to_connect`, `connecting`, `connected`, `unreachable`. Not `stopping`: a stop in progress is not requested again. |
| `isReachable` | `ready_to_connect`, `connecting`, `connected` |

`SessionMonitor` drives each live session through its backend. `SessionProvider` handles the Sessions view's
actions and their dialogs.
