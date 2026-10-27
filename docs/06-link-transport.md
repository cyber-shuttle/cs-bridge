# Link transport (experimental)

An open-source alternative to Microsoft Dev Tunnels, served by Apache Airavata. The work path goes through Airavata.
Sign-in is a CyberShuttle account. It implements the `Transport` contract in
[Backends and transports](05-backends-and-transports.md#transport).

The client code still calls the service cs-plane: `plane.ts`, the `planeId` field and the `csbridge.plane.credential`
key.

## Selection

When `csbridge.experimentalFeatures` is on and `csbridge.transport` is `link`, each Slurm Start records
`transport: 'link'` on the session. That run's work path goes through Airavata. A run keeps the transport it started
with. Changing the setting affects the next Start.

- `planeId` on the record names the Airavata session.
- The menu's **Default Transport** page sets `csbridge.transport` in user settings.
- `linkTunnel.ts` implements the same management and relay clients as the Dev Tunnels SDK, on top of Airavata. The
  [session lifecycle](01-session-lifecycle.md) therefore runs unchanged.
- `plane.ts` is the Airavata client, at `https://jupyterapi.cybershuttle.org/api/v1`. Requests time out after 30 s.

## Steps

1. **Sign in.** A CILogon device grant brokered by Airavata (`oauth/device`, then `oauth/device/poll`).
   - The credential is kept in SecretStorage under `csbridge.plane.credential`.
   - It is refreshed through `oauth/refresh`. The first API call made less than 60 s before its expiry, or after it,
     does the refresh.
   - It is cleared on a `401`, or when Airavata refuses the refresh with a 4xx.
   - A 5xx or network error during refresh keeps the credential.
2. **Prepare.** `Link.prepare` (`transport.ts`), through `LinkManagementClient.attachTunnel` (`linkTunnel.ts`):
   - defines the Airavata session if the record has no `planeId`, with the local session id as its idempotency key;
   - stops any run still live on it. If the stop returns `404`, the session is defined again;
   - attaches with `tunnelModes: ["link"]`;
   - saves the id as `planeId` and replaces the control port with the one Airavata assigns.

   The job script gets `--tunnel-mode link --tunnel-link-args '--url …'`.
3. **Submit.** The link token is passed as `LINKSPAN_LINK_TOKEN` in `sbatch`'s environment. It is sent over the
   persistent shell's stdin.
4. **Readiness.** Airavata answers `/access` only once the session is ready, that is, once Linkspan holds its link.
   Fetching the tunnel therefore doubles as the readiness check. Airavata may answer `session_access_unavailable`.
   While it does, the monitor sets no error. Each such answer still counts toward the six failed probes before a
   `sacct` cross-check.
5. **Forward.**
   - `/access` returns a connect token, kept only in memory.
   - Each forwarded port is a listener on `127.0.0.1`, on the same port number as the remote one when it is free.
   - Each connection to a listener opens a WebSocket to `/sessions/{id}/forward/{port}`, with the subprotocols
     `cybershuttle.v1` and `capability.<token>`.
6. **Poll and connect.** As with a Dev Tunnel. Linkspan's API is reached through a forward of its control port.
7. **Stop and delete.**
   - Ending a run releases the Airavata session with `POST /stop`.
   - Deleting a session with a `planeId` stops the Airavata session again and sends `DELETE`. This applies whatever
     the session's current transport. Airavata deletes only a stopped session.
   - A failed stop or `DELETE` is logged. The record is still deleted.

The link relay client has no keep-alive. The half-open rebuild in [Connect](01-session-lifecycle.md#connect)
therefore does not apply.
