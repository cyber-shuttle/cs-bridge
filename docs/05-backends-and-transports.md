# Backends and transports

Two interfaces keep the lifecycle independent of what runs a session and how it is reached:

- a `Backend`: a Slurm job or an EC2 instance;
- a `Transport`: a Dev Tunnel or link, an open-source alternative to Microsoft Dev Tunnels served by Apache Airavata.

[Session lifecycle](01-session-lifecycle.md) describes the Slurm backend over a Dev Tunnel. This document is the
contract the others implement.

## Backend

Every remote operation on a session goes through the `Backend` interface (`sessionSupport.ts`). `SlurmBackend`
implements it for a Slurm job. `Ec2Backend` (`ec2Session.ts`) implements it for an EC2 instance. `Backends` routes
each call to the record's backend. Starting is not part of the interface. Each backend has its own `start`, called by
the provider.

| Member | Called by | Slurm | EC2 |
|---|---|---|---|
| `label` | monitor | names the backend in "unreachable" messages | same |
| `connect` | provider | brings up the tunnel and writes the SSH config (see [Connect](01-session-lifecycle.md#connect)) | marks the session connected. Its SSH host was already written when the poll found port 22. |
| `stop` | provider | `scancel`. If that fails, it succeeds only when `sacct` shows the job ended or its walltime has passed. | waits out a pending boot, then `StopInstances`, then waits for `stopped` or `terminated` |
| `remove` | provider | deletes the run's Dev Tunnel and Airavata session, then the session's SSH key | `TerminateInstances`, if the instance still exists |
| `tick` | monitor | one poll (see [Monitor](01-session-lifecycle.md#monitor)) | `DescribeInstances` and any new public IP. This is skipped while signed out or before a stored key is restored. Then, while running with a public IP and no connection info, a port-22 probe with a 3 s timeout. |
| `end` | monitor | the run's teardown (see [End](01-session-lifecycle.md#end)) | clears the connected flag and the connection info |
| `forget` | monitor | drops in-memory probe state | nothing |

## Transport

A `Transport` (`transport.ts`) chooses separately how the work path is carried. `transportFor` picks the transport
for a session from the record's `transport` field. A Slurm Start sets that field.

| Member | Purpose |
|---|---|
| `label`, `description` | names shown to the user |
| `signedIn()` | whether the user is signed in, without prompting |
| `prepare()` | before `sbatch`: reserve the run's tunnel on its control port and return the job's tunnel arguments and token |
| `release()` | end the run's remote hold and its tokens |
| `management()`, `relayClient()` | the tunnel management and relay clients |
| `tunnelRef()` | the run's tunnel, once prepared |
| `ensureTunnel()` | Dev Tunnel: fetch or create the run's tunnel, refresh this window's connect token, and register the control port if the tunnel lacks it. Link: nothing. Airavata forwards any port. |
| `withLinkspan()` | call Linkspan's HTTP API. Dev Tunnel: through the tunnel's public HTTPS endpoint, with the connect token. Link: through a short-lived relay client. |
| `deleteTunnel()` | delete the run's tunnel |

## Dev Tunnel transport

The default transport (`tunnelSupport.ts`, `transport.ts`). Sign-in is VS Code's Microsoft account.

| Step | What happens |
|---|---|
| Prepare | Deletes the previous run's tunnel. A failed delete is logged and skipped. The delete keeps the old ports from counting toward Dev Tunnels' limit of 10 ports per tunnel. Creates a tunnel, registers only the control port on it, and mints a **host** token. |
| Submit | The job script gets `--tunnel-mode devtunnel --tunnel-devtunnel-args '--id … --cluster …'`. The host token goes to the job as `LINKSPAN_TUNNEL_HOST_TOKEN` in `sbatch`'s environment, over the persistent shell's stdin. It lets the node host this one tunnel. The Microsoft account token stays on the local machine. |
| Call Linkspan | `https://<tunnel>-<controlPort>.<cluster>.devtunnels.ms/api/v1`, with a **connect** token held only in this window's memory. |
| Connect | The relay client forwards the control port. A `127.0.0.1` listener carries each accepted socket over a WebSocket to Linkspan's `/api/v1/forward/<sshPort>`. The listener uses the SSH server's port number when that is free. Keeping the port number keeps the SSH config valid when the relay is rebuilt. |
| Keep alive | A keep-alive every 15 s. A half-open tunnel still reports connected, so the SDK does not reconnect it. After 4 misses CS Bridge rebuilds the connection. It does so only if the session is still reachable and no connect is in flight. |
| Release | Nothing. The tunnel stays until the next Dev Tunnel Start or a delete. |

The [link transport](06-link-transport.md) and the [EC2 backend](07-ec2.md) are experimental.

## Experimental features

`features.ts` lists each feature and its stage. There are two, both experimental:

| Feature | Covers |
|---|---|
| `cybershuttle` | CyberShuttle sign-in and the link transport |
| `aws` | AWS sign-in and EC2 instances |

- `enabled('<feature>')` is true when the feature is stable, or when the `csbridge.experimentalFeatures` setting is
  on.
- The gates are on menu entries (`menu.ts`) and on the configured transport (`configuredTransport`).
- Turning the setting off hides the entry points only:
  - existing EC2 sessions can still be started, stopped and deleted;
  - a running session keeps its transport;
  - the next Start of a Slurm session uses the Dev Tunnel.
- A stored AWS key is restored on activation regardless of the setting.
- Each sign-in adopts tagged instances. This includes the sign-in that restoring performs. It happens in every window
  that is not a session's remote window.

| Step | Change |
|---|---|
| Start experimental | add the feature as `'experimental'`, gate its entry points, and tag it **(experimental)** after its name in running text |
| Graduate | mark it `'stable'`, which turns every gate on for everyone, and drop its tags |
| Retire the flag | delete the entry and inline each `enabled()` call naming it |
