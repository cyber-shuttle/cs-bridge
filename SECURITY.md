# Security Policy

## Supported Versions

Fixes go into the next Marketplace release. There are no maintenance branches. Only the latest published version is
supported.

## Reporting a Vulnerability

Report privately through GitHub: open this repository's **Security** tab and choose **Report a vulnerability**.
Please do not use a public issue, pull request or discussion for a security problem.

Include:

- what an attacker can reach;
- the steps to reproduce it;
- the extension version (VS Code's **Extensions** view, or `code --list-extensions --show-versions`);
- your OS;
- the cluster and scheduler, if the report involves the remote path.

Redact tokens, hostnames and usernames you do not want published. We will acknowledge the report and say whether we can
reproduce it before any fix ships.

## Scope

CS Bridge runs in your local VS Code. It drives a cluster you already have SSH access to, or an EC2 instance it
launches with your AWS key **(experimental)**. These are the boundaries it is built around. A report is most useful
when it shows one of them failing.

- A Slurm session's SSH key is generated locally. Its private half never leaves the machine. Only the public half is
  handed to the agent. An EC2 session **(experimental)** uses the key pair AWS generates for each region and machine
  (below). An instance adopted from another machine keeps that machine's key. This machine cannot reach it.
- CS Bridge changes `~/.ssh/config` only to:
  - add one `Include` of its own `ssh_config` in VS Code's extension storage;
  - remove the `Include` lines that versions up to 0.2.x added for `~/.cybershuttle`. On Windows those lines stay and
    must be removed by hand;
  - add, edit or delete the hosts you manage in the SSH Hosts view.

  Each such write replaces the file through a temp file and rename. As a result, a symlinked `~/.ssh/config` becomes a
  regular file. Adding the `Include` and managing hosts set mode `0600` on a newly created temp file. Removing the
  legacy `Include` lines keeps the default file mode. Per-session SSH hosts go to that extension-storage `ssh_config`.
- Per-session SSH hosts do not verify the remote host key (`StrictHostKeyChecking no`). The relay (Dev Tunnels or
  Apache Airavata) is trusted. For EC2, the network path to the instance is trusted.
- The job receives a token scoped to hosting one Dev Tunnel, never an account credential. The token is passed as an
  environment variable on `sbatch`. It is not in the job script, a process's argv, or a file CS Bridge writes. Slurm
  may keep the job's environment in its own state and accounting. A failed `sbatch` with empty stderr currently puts
  the token into the error message, the log and the session record.
- Dev Tunnel sign-in is VS Code's Microsoft account provider. CS Bridge runs no OAuth server and stores no Microsoft
  token.
- The `link` transport **(experimental)** is an open-source alternative to Microsoft Dev Tunnels, served by Airavata.
  Its sign-in is CILogon's device grant brokered by Airavata.
  - The credential is stored only in VS Code's SecretStorage. Each window caches it in memory. It is sent only to
    Airavata.
  - The job's link token reaches Linkspan as an environment assignment on `sbatch --export=ALL`. It is not in the job
    script or a process's argv. A failed `sbatch` with empty stderr currently puts it into the error message, the log
    and the session record, as for the Dev Tunnel token.
  - CS Bridge asks Airavata to release the session (`POST /stop`) when the run ends. A failed request, for example
    while signed out, is logged. A request that Airavata refuses as unauthorized also signs you out of CyberShuttle.
  - The next Start on the link transport stops the session before attaching. Delete stops and deletes it when you are
    signed in. If that fails, it is only logged, and the Airavata session is left in your account.
  - The forward token stays in the extension host's memory. Every forward listens on 127.0.0.1 only.
- AWS credentials **(experimental)** are typed into VS Code and sent only to the EC2 API. They are kept in VS Code's
  SecretStorage until you sign out or AWS refuses a key. The refused key can be the stored one at startup, or one typed
  into Sign In, which replaces it. In a region without a default VPC, the first launch creates one. The private key AWS
  generates for this machine in each region is stored locally with mode `0600`. The security group CS Bridge creates
  opens port 22 to the internet. An instance launched from this machine accepts only that key.
- The agent binary is fetched over HTTPS from GitHub's latest release. It has no pinned version and no signature
  check. Everything CS Bridge runs remotely runs as the submitting user. It has no privilege that user does not
  already have.

How each of these is implemented is in the [documentation](docs/README.md).

A finding that assumes an attacker already holds the local account, or an account on the cluster as that user,
describes one of these boundaries. It does not describe a way through it. The compute-node agent's own boundaries are
in [Linkspan's security policy](https://github.com/cyber-shuttle/linkspan/blob/main/SECURITY.md).
