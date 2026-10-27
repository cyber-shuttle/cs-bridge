# Build and dependencies

How the sources become a `.vsix`, and what CS Bridge depends on at runtime.

## Build pipeline

`esbuild.js` runs three builds and copies `codicon.css` and `codicon.ttf` to `out/codicons`. All three builds:

- bundle their imports;
- resolve `@` to `src`;
- emit sourcemaps in development, and minify without sourcemaps under `--production`;
- report through a problem-matcher plugin (`[esbuild] build started/finished`), with esbuild's own log silenced.

`--watch` rebuilds all three.

| Build | Input | Output | Format |
|---|---|---|---|
| Extension | `src/extension.ts` | `out/extension.js` | CJS, Node 22; `vscode` and `node-rsa` external |
| Webviews | `src/ui/webviews/{sessions,hosts,stats,summary}.tsx` | `out/<view>.js` | IIFE, browser, ES2022, Preact JSX |
| Host smoke suite | `src/host/index.ts` | `out/hostTests.js` | CJS, Node 22; `vscode` and `mocha` external |

**Type checking.** esbuild does not type-check. `tsc` does, once per tsconfig.

| Config | Covers |
|---|---|
| `tsconfig.json` | every `.ts` outside `src/ui`, including tests, `src/types` and `scripts/vscodeMock.d.ts`. Also `ui/logic/session.ts`, which the extension imports. |
| `src/ui/tsconfig.json` | `src/ui` and the `src` modules it imports through `@`. Uses DOM libraries, Preact JSX, and Node types for its tests. |

**Packaging.** `bun run package` runs `vsce package --no-dependencies`. So every runtime dependency must be in the
bundles. `vsce` first runs `vscode:prepublish`: `check-types`, then `esbuild.js --production`. `.vscodeignore` decides
what the `.vsix` contains.

- Shipped: `out/` except the host suite, `resources/`, the askpass `scripts/`, `package.json` and the root
  documents.
- Excluded: sources and tests (`src/`), `docs/`, `.github/`, `.vscode/`, `.vscode-test/`, `node_modules/`, sourcemaps,
  build and lint configs, the test mock and runner, `bun.lock`, `lefthook.yml`, `CLAUDE.md`, `.gitignore` and
  `.superpowers/`.

Where lefthook is installed, `lefthook.yml` runs `check-types` and `lint` in parallel before each commit. It does so
only for commits that stage `.ts` or `.tsx` files. `build` runs `esbuild.js` once. `watch`, `lint`, `lint:fix` and
`dev` are in [CONTRIBUTING.md](../CONTRIBUTING.md).

## External dependencies

**Services and tools.**

- **[Linkspan](https://github.com/cyber-shuttle/linkspan)** — the agent on the compute node. It hosts the tunnel
  and starts SSH servers. A release that raises the required Linkspan version says so in
  [CHANGELOG.md](../CHANGELOG.md). `slurmLaunch.ts` enforces the floor.
- **OpenSSH** — `ssh` for every connection and `ssh-keygen` for session keys. Nothing is bundled.
- **The cluster** —
  - The login node needs `bash`, `base64`, `curl`, `tar`, `uname`, `sed`, `head` and `install`. It also needs `grep`
    and `cut` where `/usr/local/etc/project.map` exists.
  - The login node needs the Slurm clients `sinfo`, `sacctmgr`, `sbatch`, `sacct`, `scancel` and `srun`.
  - The login node needs outbound HTTPS to `github.com` for Linkspan releases.
  - Compute nodes need `bash`, `install`, and `curl` for `srun` usage samples. They also need outbound HTTPS to the
    Dev Tunnels relay or Apache Airavata.
  - Login and compute nodes share `$HOME` and architecture.
- **Airavata** **(experimental)** — `https://jupyterapi.cybershuttle.org/api/v1`, for CyberShuttle sign-in and the
  link transport.
- **AWS EC2 API** **(experimental)** — for EC2 sessions.
- **A Remote-SSH extension** — CS Bridge opens a `vscode-remote://ssh-remote+…` address. Whichever provider is
  installed attaches the window. This is usually
  [ms-vscode-remote.remote-ssh](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-ssh).
  It is not declared in `extensionDependencies`.

**Runtime packages** (bundled):

| Package | Used for |
|---|---|
| `@microsoft/dev-tunnels-{management,connections,contracts}` | creating tunnels and connecting to them, in-process. There is no `devtunnel` CLI. Their peers `@microsoft/dev-tunnels-ssh` and `-ssh-tcp` are bundled but not declared in `package.json`. |
| `@aws-sdk/client-ec2` | EC2 **(experimental)** |
| `ssh-config` | reading and writing SSH config files |
| `shell-quote`, `posix-getopt` | parsing a pasted `ssh` command |
| `uuidv7` | session ids |
| `preact` | the webviews |

`@vscode/codicons` is a dev dependency. Its `codicon.css` and `codicon.ttf` are copied to `out/codicons` and shipped.

Dev Tunnels sign-in is VS Code's Microsoft account, through `vscode.authentication.getSession('microsoft', …)`. There
is no custom OAuth server. The forwarding client (`linkTunnel.ts`) carries each forwarded socket over the runtime's
`WebSocket`. The Dev Tunnels relay connection is the SDK's. The SDK brings in `websocket` as a runtime dependency.
`websocket` is also a dev dependency, for tests.
