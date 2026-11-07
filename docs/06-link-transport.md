# Link transport (experimental)

The work path of a CyberShuttle host's session, served by the CyberShuttle API in place of a Microsoft Dev Tunnel.
Sign-in is a CyberShuttle account. It implements the `Transport` contract in
[Backends and transports](05-backends-and-transports.md#transport).

The client code keeps the name plane: `plane.ts`, `planeSessions.ts` and the `csbridge.plane.credential` key.

## Selection

When `csbridge.experimentalFeatures` is on, each cluster config of the signed-in user (`GET /slurm-cluster-configs/me`
and `/shared-with-me`) is a CyberShuttle host, `cs-<name>-<id>`. Its sessions come from `GET /sessions/me` and always
use the link transport.

| Host | Form | Start | Status, stop | Job id |
|---|---|---|---|---|
| SSH host | `sinfo`, `sacctmgr` over SSH | walltime; CS Bridge submits over SSH; reached by a Dev Tunnel | `sacct`, `scancel` over SSH | Slurm's |
| CyberShuttle host | `POST /slurm-cluster-configs/{id}/discover-allocations`; each run opens its own folder, `<workRoot>/<processId>` | Add: walltime, deployment. Start: walltime. The CyberShuttle API submits; no preview | `GET /sessions/me` every 5 s, `POST /processes/{id}/stop` | the process id |

- `linkTunnel.ts` implements the same management and relay clients as the Dev Tunnels SDK, on top of the CyberShuttle API. The
  [session lifecycle](01-session-lifecycle.md) therefore runs unchanged.
- `plane.ts` is the CyberShuttle API client, at `https://jupyterapi.cybershuttle.org/api/v1`. Requests time out after 30 s.
  A call that logs in to the cluster (discovery, stop) times out after 330 s.
- Every call carries the window's `X-Connection-Id`. The CyberShuttle API shows a login's prompts only to the connection
  that started it, including a submission's, which logs in after the launch returns.
- While signed in, the window polls `ssh-interactive-auths` every 2 s and asks each prompt in the SSH authentication panel.

## Steps

1. **Sign in.** A CILogon device grant brokered by the CyberShuttle API (`auth/device`, then `auth/token` until it stops answering `202`).
   - The credential is kept in SecretStorage under `csbridge.plane.credential`.
   - It is refreshed through `auth/token`. The first API call made less than 60 s before its expiry, or after it,
     does the refresh.
   - It is cleared on a `401`, or when the CyberShuttle API refuses the refresh with a 4xx.
   - A 5xx or network error during refresh keeps the credential.
2. **Create.** After the walltime, Add asks which environment (deployment) on the host's cluster to run, unless it has one,
   listing Base first (`SessionProvider.pickDeployment`). `POST /sessions` sends the cluster config, the deployment, and
   the form's account, partition and resources as is. A refusal, such as `400` for an empty account, shows in the
   form's alert.
3. **Start.** `POST /sessions/{id}/start` with the walltime runs an ended session again. Both answers carry the session and
   launch at once. A launch that failed answers with `runs[0]` `FAILED`, and the card shows its `error`.
4. **Readiness.** The CyberShuttle API answers `/access` only once Linkspan holds its link, and `409` before.
   Fetching the tunnel therefore doubles as the readiness check.
   While it does, the monitor sets no error.
5. **Forward.**
   - `/access` returns a connect token, kept only in memory.
   - Each forwarded port is a listener on `127.0.0.1`, on the same port number as the remote one when it is free.
   - Each connection to a listener opens a WebSocket to Linkspan's forward through the CyberShuttle API's proxy,
     `/processes/{id}/proxy/{controlPort}/api/v1/forward/{port}?token=<token>`.
6. **Poll and connect.** As with a Dev Tunnel. Linkspan's API is reached through the same proxy, with the token
   in an `Authorization: token` header.
7. **Stop and delete.**
   - Stop is `POST /processes/{runs[0].processId}/stop`, sent from the clicking window, a remote one included.
     A refusal shows its reason and the session stays running.
   - Delete is `DELETE /sessions/{id}`. A `409` (live, or a start elsewhere won) shows its reason and keeps
     everything local. The key and SSH config entry go only after a `204`.

The link relay client has no keep-alive. The half-open rebuild in [Connect](01-session-lifecycle.md#connect)
therefore does not apply.
