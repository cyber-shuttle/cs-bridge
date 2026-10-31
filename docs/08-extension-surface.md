# Extension surface

What CS Bridge registers with VS Code: activation, views, commands, settings and the menu.

**Activation.** `onStartupFinished`, with `extensionKind: ["ui"]`.

**Views** (activity bar container "CS Bridge"):

| View | Id | In remote windows |
|---|---|---|
| Sessions | `csbridge.sessionsView` | shown, scoped to the window's session |
| Run History | `csbridge.statsView` | hidden |
| SSH Hosts | `csbridge.hostsView` | hidden |

Remote windows set the `csbridge.remote` context. The `when` clauses of the views and of `csbridge.menu` test it.
Only `csbridge.menu` appears in the Command Palette. The other contributed commands are title-bar only.

**Commands.**

| Command | Where |
|---|---|
| `csbridge.menu` (CS Bridge: Open Menu) | Sessions title bar and Command Palette, local windows only |
| `csbridge.addHost`, `csbridge.refreshHosts` | SSH Hosts title bar |
| `csbridge.refreshStats`, `csbridge.clearRunHistory` | Run History title bar |
| `csbridge.editHost` | registered, invoked from the SSH Hosts view |
| `csbridge.stopRemoteSession` | registered in remote windows. Invoked from the status bar and the session card. |

**Settings.**

| Setting | Values |
|---|---|
| `csbridge.experimentalFeatures` | `false` (default) or `true` |
| `csbridge.transport` | `devtunnel` (default) or `link`. `link` applies only with `csbridge.experimentalFeatures`. |

**Menu** (`menu.ts`). The menu is one QuickPick that walks a stack of pages. Escape goes back a page. It does so
through the `csbridge.menuNested` context and a keybinding. The root page:

- Create New SSH Session, then a host list;
- Add SSH Host, then the pasted `ssh` command, then an alias;
- Create Cloud VM **(experimental)**, shown once signed in to AWS, then region, instance type and image;
- Default Transport **(experimental)**;
- Accounts: sign in or out of CyberShuttle **(experimental)**, Microsoft DevTunnel and AWS **(experimental)**.

The CyberShuttle and Microsoft labels are cached. They are filled when the menu is built. They are refreshed when it
opens and after each item action. The AWS label is read live.

- Default Transport writes `csbridge.transport` to user settings.
- Sign In to Microsoft DevTunnel asks VS Code for a Microsoft session with `clearSessionPreference`. This lets you pick
  another account. Sign Out runs VS Code's `_signOutOfAccount`. It signs that account out of VS Code as a whole.
- Sign In to CyberShuttle opens the device-code page in the browser. It then waits in a cancellable notification that
  shows the code.
- `csbridge.editHost` opens the menu on Edit SSH Host: alias, then `[user@]hostname`.

**Webview messages.** Each view posts a `WebviewMessage` (`models.ts`). `Handlers` makes an unhandled one a compile
error. The extension answers with one message, `{command: 'state', state}`.

| View | Message | Handler |
|---|---|---|
| all | `ready` | pushes the view's state |
| Sessions | `addSession` | validates with `sbatch --test-only`, then saves (`createSession`) |
| Sessions | `refreshSlurmDiscovery` | reruns discovery for the SSH host, bypassing the cache |
| Sessions | `dismissDraftSession`, `dismissPreview`, `dismissAlert` | closes the draft form; drops the preview and its run; closes the validation alert |
| Sessions | `prepareLaunchSession` | **Start**: asks for a walltime, prepares and shows the script preview. For an EC2 session, submits at once. |
| Sessions | `launchSession` | **Submit Job** in the preview |
| Sessions | `connectTunnel` | **Connect** and **Switch** (`connectSession`) |
| Sessions | `stopSessionExecution` | **Stop**: confirms, then `requestStop` |
| Sessions | `stopRemoteSession` | a remote window's **Stop**. Runs `csbridge.stopRemoteSession`. |
| Sessions | `deleteSession` | the card's **×** (`confirmAndDeleteSession`) |
| SSH Hosts | `openTerminal`, `editSshHost`, `deleteSshHost` | see [SSH hosts](04-ssh.md#ssh-hosts) |
| Run History | `openRunSummary` | opens the run's summary tab |

The SSH auth panel is `csbridge.sshAuth`. Its HTML is inline, from `renderAuthHtml` in `sshShell.ts`. It posts
`{type: 'submit' | 'cancel'}`, outside `WebviewMessage`.

**Session card** actions (`sessionActions`, `ui/logic/session.ts`):

| Status | Actions |
|---|---|
| `not_started`, `stopped`, `failed` | Start; × deletes. A disabled Starting… replaces both until the preview opens. |
| `submitting`, `queued`, `preparing`, `unreachable` | Stop |
| `ready_to_connect` | Stop, Connect |
| `connecting` | Stop, Connecting… (disabled) |
| `connected` | Stop, plus one of: Current (this window), Switch (another window is open), Opening… (one is on its way) or Connect (none is open) |
| `stopping` | none |

A remote window's card shows Stop only. The Sessions view's description shows the signed-in Microsoft account, or
"Not Signed In".

**Run History** (`statsProvider.ts`) lists recorded runs grouped by session, newest first. Each run shows CPU and
memory efficiency. Clicking a run opens its summary from the recorded snapshot. **Clear Run History** confirms, then
empties every session's run list. Live samples and stats stay. Only Slurm runs are recorded. An EC2 session has no Run
History or summary.

**Summary tab** (`summaryPanel.ts`, `csbridge.summary`) shows a spinner in two cases: while the session is stopping, or
while its run is not yet recorded. Then it shows the session's resources, walltime used and limit, samples and Slurm
accounting. It re-renders on every record or runs change. It closes if the session is deleted.

**Status bar** (remote windows):

- `csbridge.walltime` shows the time left, or "no limit". It uses the warning colour under 10 minutes. It focuses the
  Sessions view.
- `csbridge.stopSession` runs `csbridge.stopRemoteSession`.

**Logging.** `Logger` is a single output channel named "CS Bridge". It logs errors with their stacks.
