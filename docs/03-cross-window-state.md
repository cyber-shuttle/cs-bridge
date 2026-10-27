# Cross-window state

VS Code windows share session state through files in extension storage. This document covers:

- how the windows stay consistent;
- which window drives a session;
- how windows on compute nodes behave.

What the files contain is in [Storage](10-storage.md).

## Shared records

- Records live in extension storage, one JSON file per id (see [Files on disk](10-storage.md#files-on-disk)).
- A `JsonDir` (`store.ts`) keeps each folder in memory. Reads are therefore synchronous.
- A file watcher (`storage.ts`) reloads a record when another window writes it.
- Writes and reloads run one at a time per folder.
- A field write (`patch`) carries only the fields this window changed. It lands them on the record as another window
  last wrote it (`store.ts`). When two windows patch the same record in turn, each field keeps the value written last.
- A whole-record write (`set`) is used for new records, heartbeats and runs files. It holds every field it carries or
  clears. A field that another window wrote since this window last read the file survives.
- A failed write keeps its fields queued. They go out with the next write. They also go out with the next reload that
  finds another window's change to that record.
- On reload, a session record's fields are replaced in place (`replaceFields`). Code holding the record sees the new
  values. Heartbeats and runs files are replaced as whole objects.
- A record deleted in one window stays deleted in all of them.
- The read, merge and rename are not locked across windows:
  - Two overlapping writes to the same record keep only the later one's record.
  - A write that overlaps a delete can bring the record back.

## Heartbeats

- Every window rewrites its heartbeat file every 20 s until it closes.
- A heartbeat older than 90 s counts as dead. Dead heartbeats are deleted.
- A remote window's heartbeat also names its session and open folder. **Switch** uses that to focus the window.
- A window deletes its heartbeat when it closes. Its sessions can then be claimed at once. A reloaded window gets a
  new id and owns none of its earlier claims.

## Owner window

A live session is driven by one local window, the owner window. The record's `owner` field names it. A claim is not
locked across windows. Windows that claim at the same moment can each take the session until the next tick. An
example is several windows restored after a restart. At the next tick, all but the window named in `owner` stop.

**Why one window.** The record holds one `localPort`, the owner's `127.0.0.1` listener. The per-session SSH host
points at it. Only one window can therefore hold a session's connection. Polling and Stop sit with the same window.
This way one loop writes the job's state.

**Rules.**

- Only local windows claim sessions. A window claims a session when no window with a live heartbeat holds it. A
  closed or crashed window's sessions therefore pass to the next window that looks (`claim`, `extensionStore.ts`).
- Start, Connect or Delete in a window that cannot claim shows "Another window is driving this session; act from
  there." Stop does not claim. It writes the record.
- The owner releases the session in three cases:
  - its monitoring loop ends;
  - a task finishes with no loop running;
  - the user dismisses the script preview.
- Only the owner polls the job, holds the relay client, connects, and carries out **Stop**. A Stop clicked in
  another window is written to the record. The owner carries it out.
- A window that loses the claim stops polling the session on its next tick. It also disposes its relay client then.
- Four statuses come from this window's live facts, so they show only in the owner window. Another local window shows
  them differently:

  | Status in the owner window | Shown in another local window as |
  |---|---|
  | `submitting` | `not_started` while the session has no job or instance id yet: a Slurm Submit clears the id, and a new EC2 instance has none. `queued` for an EC2 instance started again. |
  | `connecting` | `ready_to_connect` |
  | `unreachable` | its last observed state: `queued` for Slurm, `preparing` for a booting EC2 instance |
  | `connected` from this window's relay client (or, for EC2, from this window's Connect) | `ready_to_connect` |

  Connect, Start or Delete in that other window then reports that another window is driving the session. A `connected` from a remote
  window's heartbeat shows in every window.
- State only this window needs stays out of the record. Its connection state is in `extensionStore.live`. Its Dev
  Tunnel connect token is in `tunnelSupport.ts`.

## Reattach after reload

Each local window runs `reattachLiveSessions` (`sessionProvider.ts`). It runs on activation. It also runs on every
change to the session records, heartbeats or live facts. For each session it:

- runs a pending Stop if the session is `stopping` and this window can claim it;
- tears down a terminal session that still has connection info, if no live window owns it and this window can claim
  it. This covers a walltime that passed while VS Code was closed;
- starts monitoring a live session that no window owns;
- reconnects a session it has just taken over, if its SSH port is known. A Slurm session is reconnected only if its
  transport is already signed in; it does not prompt. An EC2 session is always reconnected.

## Remote windows

A remote window recognises itself from the `ssh-remote+<session host>` address of its first workspace folder.
`extension.ts` compares that address with `csHostAlias` of every session. The window then:

- shows only its own session, with **Stop** as its only action;
- sets the `csbridge.remote` context. This hides the SSH Hosts and Run History views and the menu.

`RemoteSessionController` (`remoteSessionController.ts`) runs only there:

- A status bar item counts down the walltime. It turns to a warning colour with 10 minutes left. For a session
  without a walltime (EC2), it reads "no limit".
- Stop asks for confirmation and writes the stop request for the owner window. It then returns the window to local at
  once. It does not wait for the job to end.
- When the session ends or is stopped, the controller:
  1. queues the session for a summary (Slurm only, at most 8 queued, in `globalState`);
  2. runs `workbench.action.remote.close`, which reloads the window as a local one. If that command fails, the window
     closes.
- The next local activation shows the oldest queued summary (`consumePendingSummary`, `summaryPanel.ts`). This is
  normally the same window. It shows the live session as pending until the owner's teardown records the run.
