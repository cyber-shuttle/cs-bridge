# SSH

CS Bridge uses SSH twice:

- The system `ssh` runs Slurm commands on the login node. This is the control path.
- Remote-SSH reaches the compute node through a per-session SSH host. This is the work path.

This document covers both. The tunnel under the work path is in
[Backends and transports](05-backends-and-transports.md).

## Per-session SSH host

Remote-SSH opens a window only on a host name it can `ssh` to. Each session needs its own host name:

- Each session has its own target. For Slurm it is `127.0.0.1:N`, where `N` is set again on each connection. For EC2 it
  is the instance's public IP. A Slurm session also has its own key.
- A Slurm session has its own server install path.
- A remote window finds its session by matching the name against every session's.

The entries live in the extension's `ssh_config`. Remote-SSH reads them because `~/.ssh/config` has an `Include` of
that file before its first `Host` or `Match` block. Activation prepends the `Include`. It skips this when the same
`Include "<path>"` line already precedes the first `Host` or `Match` block. This way the per-session entries match
first (`sshSupport.ts`).

- **Name.** `csHostAlias(session)` in `sshHostsStore.ts` returns the SSH host alias plus the last six characters
  of the session name, for example `delta-493119`. The session name is its creation time in milliseconds. For an
  adopted EC2 instance, it is the instance id.
- **One builder.** The same function builds the `Host` line, the `ssh-remote+` address, and the reverse lookup a
  remote window uses to find its session.
- **Visible label.** VS Code shows the name as the window's `[SSH: …]` label.
- **Collision.** The name differs from the session's own SSH host alias. It therefore does not match the login
  node's entry. A user host literally named `<alias>-<six characters>` would collide.
- **Target.** For a Slurm session the entry points at `127.0.0.1:N`. For an EC2 session it points at the
  instance's public IP and port 22.
- **When it exists.** An entry is written once its target is known. For Slurm, that is once a window has recorded
  its `127.0.0.1:N` forward (`localPort`). For EC2, that is once port 22 answers. Ended sessions drop out on the next
  rewrite. A failed connect clears `localPort`. Closing the owner window does not. Its Slurm entry then stays,
  pointing at a port nothing listens on. It stays until another window reconnects the session or the run ends.
- **Key.** Each Slurm session has its own ed25519 key, `ssh_keys/id_cshost-<sessionId>`. It is created without a
  passphrase on first use. Deleting the session deletes it.

**Entry contents.** Each entry carries a key and a user:

- Slurm: the session's key and `cs-ssh-user`. Linkspan's SSH server ignores the user.
- EC2: this machine's key pair for the region and the image's login user.

Host-key checking is off for both backends. For Slurm, every run starts a new server with a new key. Keep-alives give
up on a dead connection after about 45 s (15 s × 3). The connection thus ends before Remote-SSH opens a replacement
over the same tunnel (`sshHostsStore.ts`).

```text
# CS-Bridge auto-generated for session <sessionId>
Host delta-493119
    HostName 127.0.0.1
    Port 41237
    User cs-ssh-user
    StrictHostKeyChecking no
    UserKnownHostsFile /dev/null
    IdentityFile "…/ssh_keys/id_cshost-<sessionId>"
    ServerAliveInterval 15
    ServerAliveCountMax 3
    TCPKeepAlive yes
    Compression no
    ConnectTimeout 10
    IPQoS cs0
```

### Server install path and sync

`syncSshConfig` (`sshSupport.ts`) rewrites, from all session records:

- the extension's `ssh_config`;
- the `remote.SSH.serverInstallPath` user setting. It maps the host of each Slurm session whose record holds a
  `localPort` to `/tmp/cs-vscode/<sessionId>`. Entries not under `/tmp/cs-vscode/` are left alone. Entries under it
  that no session maps are removed.

It runs:

- on activation;
- in every window, on every change to the session records, heartbeats or live facts;
- as the last step of a Slurm connect.

The VS Code server goes to node-local `/tmp` rather than `$HOME/.vscode-server`, for two reasons:

- On HPC clusters `$HOME` is a shared network file system. Its stalls make the server miss its heartbeat. This
  disconnects the window.
- All of an account's sessions would share one install tree.

## SSH hosts

The SSH Hosts view and the menu list hosts from two files:

- `~/.ssh/config`, editable;
- the system `ssh_config`, read-only: `/etc/ssh/ssh_config`, or `%ProgramData%\ssh\ssh_config` on Windows.

On a shared alias the user entry wins (`sshHostsStore.ts`). A `Host` with a wildcard or several patterns is not listed.

| Action | Effect |
|---|---|
| Add SSH Host | Parses a pasted `ssh` command with Remote-SSH's flag table (`sshCommandParser.ts`). Asks for the alias. Writes the entry above the first `Host` or `Match` block of `~/.ssh/config`, after its global lines such as `Include`. If the file has no such block, writes it at the end. Replaces an entry with the same alias. |
| Edit (user hosts) | `csbridge.editHost`: asks for the alias, then `[user@]hostname`. Rewrites only `Host`, `HostName` and `User`. Removes `User` when the destination has none. Refuses an alias that already exists in `~/.ssh/config`. |
| Delete (user hosts) | Confirms, then removes the entry from `~/.ssh/config`. |
| Terminal (any host) | An integrated terminal running `ssh <alias>`. On Unix it uses the host's ControlMaster socket. It thus reuses an authenticated login. |
| Refresh | Re-reads both files. |

Writes to `~/.ssh/config` take a lock file and an atomic rename with mode `0600` (`fsSupport.ts`). Add and Edit
refuse to save an alias, host name or user that:

- starts with `-`, or
- contains a quote, backtick, backslash, `!`, `%`, a space, a carriage return or a newline.

The check is `assertValidHost` (`sshCommandParser.ts`).

## SSH transport

All control-path commands go through `SshManager` (`sshSupport.ts`, `sshShell.ts`).

**One shell per SSH host.**

- `SshManager` keeps one long-lived `ssh … bash -l` per host and sends every command through it.
- Each command is wrapped in a random marker. Its stdout, stderr and exit code can then be split back out of the
  shared stream. A fixed ready marker drains the login banner when the shell connects.
- A command containing a newline is refused. Scripts are sent base64-encoded instead.
- Commands to a host queue and run in order. A dropped shell fails the command in flight with exit code 255. It
  reconnects on the next command.
- The shell runs with `ServerAliveInterval=15` and `ServerAliveCountMax=3`. This is the same keep-alive as the
  per-session entries.

**Errors.**

- A command resolves to its stdout.
- A non-zero exit rejects with an `Error` reading `exit <code>: <stderr or command>`. Callers handle failures as
  exceptions rather than checking exit codes.
- A shell that fails to connect rejects with `SSH connection to <alias> closed (exit <code>)`.
- A shell whose `ssh` cannot start rejects with the spawn error.

**Sharing one login.**

| Platform | Mechanism |
|---|---|
| Windows | OpenSSH there has no ControlMaster. Commands share the in-process shell only. |
| Unix | Also a ControlMaster socket (`ControlMaster=auto`, `ControlPersist=600`). Several VS Code windows thus share one login. The socket is named by the first 16 hex characters of a SHA-256 of the host alias. This keeps the path under the 104-byte limit. |

The socket folder is `$XDG_RUNTIME_DIR/csbridge-ssh`, or `csbridge-ssh` in the temp folder. If that folder is not
private to the user, each window uses a fresh `csbridge-*` temp folder instead. Those windows then do not share a
login.

**Batch mode.** Background calls (job polls, `srun` usage samples, run stats) are marked batch:

- If a shell is already open, they use it.
- If a new shell is needed, it starts with `BatchMode=yes`, `ConnectTimeout=10` and no prompt helper. It then fails
  at once instead of prompting for MFA during a background poll.

Interactive shells allow up to three password prompts (`NumberOfPasswordPrompts=3`).

**Prompts.** Password, passphrase and keyboard-interactive prompts reach the user through files:

1. `ssh` runs the `SSH_ASKPASS` helper: `askpass.sh`, which runs `askpass.js` with Node. When `ssh -V` reports
   `OpenSSH_for_Windows`, `SSH_ASKPASS` runs `askpass.js` with Node directly.
2. The helper writes the prompt to `prompt-<id>` in a private `cs-askpass-*` temp folder.
3. The extension checks that folder every 200 ms. It shows the prompt in a `csbridge.sshAuth` panel.
   - The panel keeps line breaks in monospace, so a device-flow QR code renders. An input box would collapse its line
     breaks.
   - Polling stops once the shell is ready or drops. Only connect-time prompts are therefore shown.
   - Escape or closing the panel is Cancel.
4. The answer is written to `response-<id>`. Cancel writes `cancel` and kills `ssh`. The helper gives up after
   120 s.

The helper's environment:

- `SSH_ASKPASS_REQUIRE=force`;
- `CS_ASKPASS_DIR`, the prompt folder;
- `CS_NODE_BIN` and `CS_ASKPASS_JS`, for `askpass.sh`;
- `ELECTRON_RUN_AS_NODE=1`, so VS Code's binary runs as Node;
- `DISPLAY=:0`.

Batch shells get none of it.
