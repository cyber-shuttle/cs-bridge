# Link transport (experimental)

The work path of a CyberShuttle host's session, served by the CyberShuttle API in place of a Microsoft Dev Tunnel.
Sign-in is a CyberShuttle account. It implements the `Transport` contract in
[Backends and transports](05-backends-and-transports.md#transport).

The client code keeps the name plane: `plane.ts`, the `planeId` field and the `csbridge.plane.credential` key.

## Selection

When `csbridge.experimentalFeatures` is on, each cluster config of the signed-in user (`GET /slurm-cluster-configs/me`
and `/shared-with-me`) is a CyberShuttle host, `cs-<name>-<id>`. Its sessions record `clusterConfigId`, and each Start
records `transport: 'link'`.

| Host | Form | Start | Status, stop | Job id |
|---|---|---|---|---|
| SSH host | `sinfo`, `sacctmgr` over SSH | walltime; CS Bridge submits over SSH; reached by a Dev Tunnel | `sacct`, `scancel` over SSH | Slurm's |
| CyberShuttle host | `POST /slurm-cluster-configs/{id}/discover-allocations`; home is the config's `workRoot` | walltime, deployment; the CyberShuttle API submits; no preview | `GET /processes/{id}` (`READY` reads as running), `POST /processes/{id}/stop` | the process id |

- `linkTunnel.ts` implements the same management and relay clients as the Dev Tunnels SDK, on top of the CyberShuttle API. The
  [session lifecycle](01-session-lifecycle.md) therefore runs unchanged.
- `plane.ts` is the CyberShuttle API client, at `https://jupyterapi.cybershuttle.org/api/v1`. Requests time out after 30 s.
  A call that logs in to the cluster (discovery, launch, stop) times out after 330 s, and meanwhile each prompt polled
  from `ssh-interactive-auths` is asked in the SSH authentication panel.

## Steps

1. **Sign in.** A CILogon device grant brokered by the CyberShuttle API (`auth/device`, then `auth/token` until it stops answering `202`).
   - The credential is kept in SecretStorage under `csbridge.plane.credential`.
   - It is refreshed through `auth/token`. The first API call made less than 60 s before its expiry, or after it,
     does the refresh.
   - It is cleared on a `401`, or when the CyberShuttle API refuses the refresh with a 4xx.
   - A 5xx or network error during refresh keeps the credential.
2. **Prepare.** After the walltime, Start asks which deployment on the host's cluster to run, unless it has one
   (`SessionProvider.pickDeployment`). `SlurmBackend.launch` then creates a `BATCH_JOB` process (`POST /processes`)
   with the deployment, the cluster config and the run's resources. It saves the id as `planeId` and the answer's
   `controlPort` as the run's control port. An empty account charges the deployment's default allocation.
3. **Submit.** `POST /processes/{id}/launch`.
4. **Readiness.** The CyberShuttle API answers `/access` only once Linkspan holds its link, and `409` before.
   Fetching the tunnel therefore doubles as the readiness check.
   While it does, the monitor sets no error. Each such answer still counts toward the six failed probes before a
   `GET /processes/{id}` cross-check.
5. **Forward.**
   - `/access` returns a connect token, kept only in memory.
   - Each forwarded port is a listener on `127.0.0.1`, on the same port number as the remote one when it is free.
   - Each connection to a listener opens a WebSocket to Linkspan's forward through the CyberShuttle API's proxy,
     `/processes/{id}/proxy/{controlPort}/api/v1/forward/{port}?token=<token>`.
6. **Poll and connect.** As with a Dev Tunnel. Linkspan's API is reached through the same proxy, with the token
   in an `Authorization: token` header.
7. **Stop and delete.**
   - Ending a run, and deleting a session with a `planeId`, send `POST /processes/{id}/stop`, which a run that
     has ended answers unchanged. A failure is logged. The process stays in the account.

The link relay client has no keep-alive. The half-open rebuild in [Connect](01-session-lifecycle.md#connect)
therefore does not apply.
