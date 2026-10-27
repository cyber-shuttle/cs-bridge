# Source layout

Where the code lives, where to make common changes, the invariants a change must keep, and how it is tested.

## Folders

Code is grouped in four folders. The grouping is by role. It is not enforced. Modules do import from `src/*.ts`, for
example `extensionStore`, `logger`, `plane` and `models`.

### `src/*.ts` — VS Code surface and shared state

| File | Role |
|---|---|
| `extension.ts` | activation: storage, providers, commands |
| `sessionProvider.ts`, `sshHostProvider.ts`, `statsProvider.ts` | one provider per view, each extending `webviewProvider.ts`. `sessionProvider.ts` also drives Start, Stop, Connect, Delete and reattachment. |
| `webviewProvider.ts` | the provider base. `renderHtml` serves a bundle in a page. The page has a nonce-gated Content-Security-Policy and the base controls' CSS (`CONTROLS_CSS`). `confirmModal` is the one confirm dialog. |
| `summaryPanel.ts` | the summary tab, a `WebviewPanel` that uses `renderHtml`. Also the pending-summary queue in `globalState`. |
| `remoteSessionController.ts` | remote windows only: walltime status bar, Stop hand-off. Queues its summary. |
| `menu.ts` | the CS Bridge menu |
| `extensionStore.ts` | session store access, live facts, heartbeats, ownership (`claim`, `owns`, `disown`), `requestStop`, `statusOf` |
| `storage.ts` | opens extension storage, runs migrations, and watches it for other windows' writes |
| `sessionRunSupport.ts` | records a finished run. Reads `sacct` for the in-run stats. |
| `plane.ts` | Apache Airavata client **(experimental)** |
| `features.ts`, `models.ts`, `logger.ts` | feature flags, shared types and constants, the output channel |

### `src/modules/*.ts` — capabilities

| Concern | Modules |
|---|---|
| SSH | `sshSupport`, `sshShell`, `sshHostsStore`, `sshCommandParser` |
| Slurm | `slurmLaunch`, `slurmParse`, `slurmSupport` |
| Linkspan HTTP client | `linkspanSupport` |
| Dev Tunnels | `tunnelSupport` |
| Forwarding relay client (both transports); Airavata tunnel clients **(experimental)** | `linkTunnel` |
| Transport choice and connect steps | `transport` |
| EC2 **(experimental)** | `ec2`, `aws`, `ec2Session` |
| Status | `sessionMachine` |
| Lifecycle composition | `sessionSupport` |
| Stores and migrations | `store`, `runStore`, `schema` |
| File and JSON helpers | `fsSupport`, `json`, `util` |
| Test helpers | `testSupport`, `fakeEc2Client`, `memoryFiles` |

### `src/ui/` — webviews

Preact, one esbuild bundle per view.

- `webviews/` holds one root per view: sessions, hosts, stats, summary.
- `components/` renders. `components/base/` is the design system. It has one primitive per file, re-exported from
  `index.ts`. A `package.json` marks it side-effect free.
- `logic/` holds pure, tested derivations.
- `platform/vscode.tsx` is the only bundled webview code that talks to the extension:
  - `mount()` renders a root;
  - `post()` sends messages out;
  - `useWebviewState()` receives state in.

### `src/host/` — smoke suite

`index.ts` and `smoke.ts`. `bun run test:host` builds, then runs the suite inside a downloaded VS Code with a throwaway
profile. Its four cases cover:

- activation;
- a run torn down from its record alone;
- a Stop handed between windows;
- the summary webview.

### Other folders

- `src/types/` declares types for `posix-getopt` and `websocket`.
- `resources/` holds the extension icon (`csbridge.png`) and the activity-bar and view icon (`csbridge.svg`).
- `scripts/` holds the `SSH_ASKPASS` helpers (`askpass.js`, `askpass.sh`), the test `vscode` mock
  (`vscodeMock.js`, `vscodeMock.d.ts`) and the smoke-suite runner (`hostTest.js`).

## Extension points

| To add | Change |
|---|---|
| A backend | Implement `Backend` (`sessionSupport.ts`) with its own `start`. Meet the [backend contract](#backend-contract) below. |
| A transport | Implement `Transport` (`transport.ts`). Give it a `SlurmSession` field for its tunnel ref, as `devtunnel` and `planeId` are. This is a persisted field. `prepare` writes it and `tunnelRef` reads it. Add the transport to these places: its name to `SlurmSession['transport']` (`models.ts`); its instance to the `Transports` constructor, `transportFor` and `Transports.remove` (`transport.ts`); a `LinkspanLaunch` builder to `slurmParse.ts`; the Default Transport page (`menu.ts`); the `csbridge.transport` enum in `package.json`. The whole transport choice sits behind `cybershuttle`. While that feature is off, `configuredTransport` (`features.ts`) returns `devtunnel` and the menu hides Default Transport. An experimental transport stays behind that gate. A stable one must also be offered outside it. If the transport needs an account, add Sign In and Sign Out items to the menu's Accounts section. Add its label lookup to `refreshAccounts` (`menu.ts`). `signedIn()` gates reconnection at reattach. |
| A sidebar view | Add these parts. A provider extending `webviewProvider.ts`. Register it in `extension.ts` under a static `viewType` equal to its `views` id. Its `pushState` posts `{ command: 'state', state }`, the only message `useWebviewState` accepts. Its name in `ViewKind` (`webviewProvider.ts`). Its state type and its message type in `WebviewMessage` (`models.ts`). A root `src/ui/webviews/<name>.tsx`, named as in `ViewKind`, because `renderHtml` loads `out/<name>.js`. An entry point in `esbuild.js`. A `"type": "webview"` entry under `views.csbridge` in `package.json`, with its `id` equal to the `viewType` and a `name`. Add `"when": "!csbridge.remote"` if the view is local-only, as Run History and SSH Hosts are. |
| A setting | Add it to `contributes.configuration` in `package.json`. Read it with `vscode.workspace.getConfiguration('csbridge')`. List it in [Extension surface](08-extension-surface.md). |
| A persisted field | See [Schema migrations](10-storage.md#schema-migrations). |

## Backend contract

What the code requires of a backend, as `SlurmBackend` and `Ec2Backend` do it:

| Part | Requirement |
|---|---|
| Record | A discriminator in `models.ts` (as the `ec2` field) and a factory (as `ec2Session`). Set `resources.wallMinutes` to zero unless the backend has a walltime and sets `startedAt`. `deriveStatus` and the remote status bar treat a passed walltime as the run's end. |
| `start` | Record a non-empty `jobId` (the instance id for EC2). The monitor and `deriveStatus` treat a record without one as not started. |
| `tick` | Record the backend's state through `observe`, mapped onto `SlurmJobStatus` (as `observedEc2`). Set `connectionInfo.sshPort` once the host accepts SSH. Until then the session stays `preparing`, reattach does not reconnect it, and no per-session SSH host is written. |
| `connect` | Bring up the work path. Return `true` only once the per-session SSH host is rendered. The provider then opens the remote window. Slurm writes `connectionInfo.localPort` and awaits `syncSshConfig`. EC2 relies on the `sshPort` and IP its `tick` wrote. Add the session to `live.connected` (EC2) or hold a relay client (Slurm). |
| `stop` | Record a terminal state before returning. `endSession` then stops the loop. A non-terminal `observed` leaves the session `stopping`. Reattach in a local window that can claim the session keeps re-running such a stop. |
| `end` | Clear `connectionInfo` and remove the session from `live.connected`. The reattach sweep ends again any terminal record that still holds `connectionInfo`. |
| `remove` | Release the session's own remote resources. Slurm deletes its tunnels and SSH key. EC2 terminates its instance. Per-region resources stay. |
| Routing | `Backends.use` is a two-way `isEc2` check. So a third backend changes the router. `isEc2` also branches in these places: `sessionProvider.ts` (constructor wiring, Start, submit, reattach, delete confirmation); `sshHostsStore.ts` (`renderSshConfig`, `renderServerInstallPaths`); `ui/logic/session.ts` (`cardModel`); `remoteSessionController.ts` (summary). |
| Creation and accounts | A menu page in `menu.ts` that calls a `SessionProvider` method. The method saves a factory-built record, as Create Cloud VM does with `createCloudVm`. Wire any account client in `extension.ts`, as `AwsClient` is. Add Sign In and Sign Out items in the menu's Accounts section and a label lookup in `refreshAccounts`. |
| Tests and bundling | Update the `Backends` and `SessionProvider` constructor calls in `src/lifecycle.test.ts`. `check-types` covers that file. Keep `models.ts`, `sessionMachine.ts` and `slurmParse.ts` free of `vscode` and Node imports (type-only imports aside). The webviews bundle them for the browser. |

## Invariants

- Do not store a status. Record a fact and extend `deriveStatus` ([Session status](02-session-status.md)).
- Only the owner window writes poll results. A tick checks `alive()` after each `await` before it writes
  (`sessionSupport.ts`, `ec2Session.ts`). Exception: `ensureDevTunnel` (`tunnelSupport.ts`) writes a changed
  `devtunnel` from a preparing tick without the check.
- A write that a poll repeats each tick is made only on change, as `observe` and `setError` do
  (`extensionStore.ts`). Every write reaches every window.
- `csHostAlias` is the only builder of the per-session SSH host name.
- Only `transport.ts` maps a record's `transport` to its implementation (`transportFor`). `configuredTransport`
  (`features.ts`) picks the name a new run records. There are two exceptions:
  - `sessionSupport.ts` recognises Airavata's not-ready error while preparing;
  - `validateSlurmConfig` (`slurmLaunch.ts`) dry-runs with a placeholder `devTunnelLaunch` whatever the transport.
- Tokens reach the job only as environment assignments on the `sbatch` command (`slurmLaunch.ts`). That command is
  sent over the shell's stdin. Tokens never go in the job script, a process's argv or a file. Exception, to fix in
  code: a submit can fail with empty stderr. Then the command, assignments included, goes into the error. That error
  is logged, shown and saved to the session record (`runRemoteCommand`, `sshSupport.ts`).

## Testing

| Script | Runs |
|---|---|
| `bun run test` | `bun test --preload ./scripts/vscodeMock.js src`: unit tests, with `vscode` mocked. A bare `bun test` has no mock. |
| `bun run test:host` | the smoke suite in a real VS Code |
| `bun run check-types` | `tsc` on both tsconfigs |

- `src/lifecycle.test.ts` drives the real provider and monitor through the mock.
- To make `vscode`-bound logic testable, move its pure part into a module that does not import `vscode`. Do not
  inject `vscode`.
- `slurmLaunch` shows the pattern. It takes an injected `RemoteRunner` and `LogSink`. It returns results, such as
  the job id, for its caller to save.
