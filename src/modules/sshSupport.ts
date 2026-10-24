import { SshHost } from '../models';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as vscode from 'vscode';
import { execFileSync, spawn, spawnSync, ChildProcessWithoutNullStreams } from 'child_process';
import * as crypto from 'crypto';
import { Logger, errMsg } from '../logger';
import { lockedUpdateTextFile } from './fsSupport';
import { getAllSessions } from '../extensionStore';
import { buildShellCommand, extractCommandResult, READY_MARKER, renderAuthHtml } from './sshShell';
import { USER_SSH_CONFIG_PATH, SYSTEM_SSH_CONFIG_PATH, mergeHostsByPriority, parseHostsFromConfigText, renderSshConfig, renderServerInstallPaths, sessionKeyName, includeIsEffective } from './sshHostsStore';

const logger = Logger.getInstance();
// The config and keys live in extension storage, which VS Code removes on uninstall. Sockets there would pass the
// 104-byte socket path limit, so they live in a runtime or temp folder that only this user can reach.
let CS_SSH_CONFIG_PATH = '';
let CS_SSH_KEYS_DIR = '';
let CS_SSH_CONTROL_DIR = '';

// Linux shares /tmp, where another user could create the folder first; one not private to this user is passed over.
function privateControlDir(): string {
    const dir = path.join(process.env.XDG_RUNTIME_DIR ?? os.tmpdir(), 'csbridge-ssh');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const { uid, mode } = fs.statSync(dir);
    return uid === process.getuid?.() && !(mode & 0o077) ? dir : fs.mkdtempSync(path.join(os.tmpdir(), 'csbridge-'));
}

export const sshKeyPath = (name: string): string => path.join(CS_SSH_KEYS_DIR, name);
const sessionKeyPath = (sessionId: string): string => sshKeyPath(sessionKeyName(sessionId));

type CommandResult = { stdout: string; stderr: string; code: number };

export class RemoteCommandError extends Error {
    constructor(readonly code: number, readonly stderr: string, command: string) { super(`exit ${code}: ${stderr.trim() || command}`); }
}

// The single command in flight on a shell; its streams accumulate until both sentinels arrive (see sshShell).
type Pending = { rid: string; outBuf: string; errBuf: string; settled: boolean; resolve: (r: CommandResult) => void };

// One persistent `ssh … bash -l` per SSH host. `ready` resolves once the connect noise is drained; on Win32 (no
// ControlMaster) this in-process channel is the only multiplexing, so authentication happens once here.
type HostShell = {
    proc: ChildProcessWithoutNullStreams;
    askpassDir: string;
    ready: Promise<void>;
    alive: boolean;
    connecting: boolean;
    current?: Pending;
};

export class SshManager {
    private static instance: SshManager | undefined;

    // One persistent shell per SSH host, plus a per-SSH-host serial queue so a single in-flight command owns the streams.
    private readonly shells = new Map<string, HostShell>();
    private readonly queues = new Map<string, Promise<unknown>>();

    private constructor(private readonly extensionUri: vscode.Uri) {
        if (process.platform !== 'win32') { CS_SSH_CONTROL_DIR = privateControlDir(); }

        if (!fs.existsSync(CS_SSH_KEYS_DIR)) {
            fs.mkdirSync(CS_SSH_KEYS_DIR, { recursive: true, mode: 0o700 });
        }
    }

    public static initInstance(extensionUri: vscode.Uri, storageDir: string): SshManager {
        CS_SSH_CONFIG_PATH = path.join(storageDir, 'ssh_config');
        CS_SSH_KEYS_DIR = path.join(storageDir, 'ssh_keys');
        if (!SshManager.instance) {
            SshManager.instance = new SshManager(extensionUri);
        }

        // Include'd above the user's global entries so a per-session SSH host wins via SSH first-match.
        if (!fs.existsSync(CS_SSH_CONFIG_PATH)) {
            fs.mkdirSync(path.dirname(CS_SSH_CONFIG_PATH), { recursive: true, mode: 0o700 });
            fs.writeFileSync(CS_SSH_CONFIG_PATH, '', { mode: 0o600 });
        }
        SshManager.instance.ensureSshInclude(CS_SSH_CONFIG_PATH);
        return SshManager.instance;
    }

    public static getInstance(): SshManager {
        if (!SshManager.instance) {
            throw new Error('SshManager not initialized. Call initInstance() first.');
        }
        return SshManager.instance;
    }

    private readHostsFile(filePath: string, source: SshHost['source']): SshHost[] {
        try { return parseHostsFromConfigText(fs.readFileSync(filePath, 'utf-8'), source); }
        catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') { logger.error(`Error reading SSH config ${filePath}:`, err); }
            return [];
        }
    }

    public getMergedHosts(): SshHost[] {
        return mergeHostsByPriority(
            this.readHostsFile(USER_SSH_CONFIG_PATH, 'user'),
            this.readHostsFile(SYSTEM_SSH_CONFIG_PATH, 'system'),
        );
    }

    // Rides the SSH host's ControlMaster socket (Unix), so a shell on an already-authenticated host costs no second 2FA push.
    public openTerminal(alias: string): void {
        vscode.window.createTerminal({ name: alias, shellPath: 'ssh', shellArgs: [...this.buildControlMasterArgs(alias), alias] }).show();
    }

    public buildControlMasterArgs(alias: string): string[] {
        // Windows OpenSSH has no Unix-socket ControlMaster ("getsockname failed: Not a socket").
        if (process.platform === 'win32') {
            return [];
        }
        // Hashed socket name keeps ControlPath under the 104-byte UNIX socket limit.
        const hash = crypto.createHash('sha256').update(alias).digest('hex').substring(0, 16);
        const socketPath = path.join(CS_SSH_CONTROL_DIR, hash);
        return [
            '-o', 'ControlMaster=auto',
            '-o', `ControlPath=${socketPath}`,
            '-o', 'ControlPersist=600',
        ];
    }

    // Every remote command rides the SSH host's one persistent shell, established on demand and reused until it drops.
    // batch: a background poll won't open a new connection that would raise a Duo box it can't answer — it rides an
    // existing shell or fails fast (caller retries). A user-driven call authenticates interactively.
    public async runRemoteCommand(alias: string, command: string, opts?: { batch?: boolean }): Promise<string> {
        const { stdout, stderr, code } = await this.enqueue(alias, async () => this.runOnShell(await this.ensureShell(alias, !!opts?.batch), command));
        if (code !== 0) { throw new RemoteCommandError(code, stderr, command); }
        return stdout;
    }

    public disposeAll(): void {
        for (const shell of this.shells.values()) {
            shell.alive = false; try { shell.proc.kill(); }
            catch { /* already gone */ }
        }
        this.shells.clear();
    }

    public static disposeInstance(): void {
        SshManager.instance?.disposeAll();
    }

    // Per-SSH-host serial queue: chain each command after the previous so one Pending owns the shell's streams at a time.
    private enqueue<T>(alias: string, fn: () => Promise<T>): Promise<T> {
        const prev = this.queues.get(alias) ?? Promise.resolve();
        const next = prev.then(fn, fn);
        this.queues.set(alias, next.then(() => { }, () => { }));
        return next;
    }

    private async ensureShell(alias: string, batch: boolean): Promise<HostShell> {
        let shell = this.shells.get(alias);
        if (!shell || !shell.alive) {
            shell = this.spawnShell(alias, batch);
            this.shells.set(alias, shell);
        }
        await shell.ready; // throws if this shell died during connect (auth failure / dismiss); caller maps it
        return shell;
    }

    private runOnShell(shell: HostShell, command: string): Promise<CommandResult> {
        return new Promise<CommandResult>((resolve) => {
            const rid = crypto.randomBytes(8).toString('hex');
            shell.current = { rid, outBuf: '', errBuf: '', settled: false, resolve };
            shell.proc.stdin.write(buildShellCommand(rid, command));
        });
    }

    // Win32-OpenSSH builds a command line, so SSH_ASKPASS can name the interpreter itself;
    // every execlp-based ssh takes one file and runs its shebang. Never a .cmd: cmd.exe
    // truncates the prompt at its first newline.
    private askpassEnvironment(askpassDir: string): NodeJS.ProcessEnv {
        const askpassJs = path.join(this.extensionUri.fsPath, 'scripts', 'askpass.js');
        const askpassSh = path.join(this.extensionUri.fsPath, 'scripts', 'askpass.sh');
        try { fs.chmodSync(askpassSh, 0o755); }
        catch { /* vsix ships +x */ }
        const direct = /OpenSSH_for_Windows/.test(spawnSync('ssh', ['-V'], { encoding: 'utf-8' }).stderr ?? '');
        return {
            SSH_ASKPASS: direct ? `"${process.execPath}" "${askpassJs}"` : askpassSh,
            SSH_ASKPASS_REQUIRE: 'force',
            ELECTRON_RUN_AS_NODE: '1',
            CS_ASKPASS_DIR: askpassDir,
            CS_ASKPASS_JS: askpassJs,
            CS_NODE_BIN: process.execPath,
            DISPLAY: ':0',
        };
    }

    private spawnShell(alias: string, batch: boolean): HostShell {
        const askpassDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-askpass-'));
        const env: NodeJS.ProcessEnv = { ...process.env, ...(batch ? {} : this.askpassEnvironment(askpassDir)) };

        const connectArgs = batch
            ? ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10']
            : ['-o', 'NumberOfPasswordPrompts=3'];

        // `bash -l` gives the same PATH (Slurm binaries) a login shell has; the channel is held open and fed commands.
        const proc = spawn('ssh', [
            ...this.buildControlMasterArgs(alias),
            ...connectArgs,
            '-o', 'ServerAliveInterval=15',
            '-o', 'ServerAliveCountMax=3',
            alias,
            'bash -l',
        ], { env, stdio: ['pipe', 'pipe', 'pipe'] });

        let readyResolve!: () => void;
        let readyReject!: (e: Error) => void;
        const shell: HostShell = {
            proc, askpassDir, alive: true, connecting: true,
            ready: new Promise<void>((res, rej) => { readyResolve = res; readyReject = rej; }),
        };

        const settle = (p: Pending): void => {
            const result = extractCommandResult(p.rid, p.outBuf, p.errBuf);
            if (result && !p.settled) { p.settled = true; p.resolve(result); }
        };

        let readyBuf = '';
        proc.stdout.on('data', (d: Buffer) => {
            const s = d.toString();
            if (shell.connecting) {
                readyBuf += s; // drain profile/MOTD noise until the shell echoes its readiness marker
                if (readyBuf.includes(READY_MARKER)) { shell.connecting = false; readyResolve(); }
                return;
            }
            if (shell.current) { shell.current.outBuf += s; settle(shell.current); }
        });
        proc.stderr.on('data', (d: Buffer) => {
            if (!shell.connecting && shell.current) { shell.current.errBuf += d.toString(); settle(shell.current); }
        });
        proc.stdin.on('error', () => { /* write races a dropped connection; the close handler settles the command */ });

        proc.stdin.write(`printf '\\n${READY_MARKER}\\n'\n`);

        const poll = batch ? undefined : this.pollAskpass(shell, alias);
        const stopPoll = (): void => { if (poll) { clearInterval(poll); } };
        shell.ready.then(stopPoll, stopPoll); // authentication is one-shot at connect

        const drop = (onConnect: () => Error): void => {
            shell.alive = false;
            stopPoll();
            try { fs.rmSync(askpassDir, { recursive: true, force: true }); }
            catch { /* best-effort */ }
            if (this.shells.get(alias) === shell) { this.shells.delete(alias); }
            if (shell.connecting) { shell.connecting = false; readyReject(onConnect()); }
            if (shell.current && !shell.current.settled) {
                shell.current.settled = true;
                shell.current.resolve({ stdout: shell.current.outBuf, stderr: `${shell.current.errBuf}\nssh connection closed`, code: 255 });
            }
        };
        proc.on('close', (code: number | null) => drop(() => new Error(`SSH connection to ${alias} closed (exit ${code ?? 'null'})`)));
        proc.on('error', (err: Error) => drop(() => err));

        return shell;
    }

    // SSH auth prompt in a monospace webview (renderAuthHtml); resolves to the response, or undefined on dismiss.
    private promptAuth(alias: string, prompt: string): Promise<string | undefined> {
        const nonce = crypto.randomBytes(16).toString('hex');
        const panel = vscode.window.createWebviewPanel(
            'csbridge.sshAuth', `SSH Authentication — ${alias}`,
            vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true },
        );
        panel.webview.html = renderAuthHtml(prompt, nonce);
        return new Promise<string | undefined>((resolve) => {
            const finish = (v?: string) => { resolve(v); panel.dispose(); }; // resolve latches, dispose is idempotent
            panel.webview.onDidReceiveMessage((m: { type?: string; value?: string }) =>
                finish(m?.type === 'submit' ? (m.value ?? '') : undefined));
            panel.onDidDispose(() => finish(undefined));
        });
    }

    private pollAskpass(shell: HostShell, alias: string): NodeJS.Timeout {
        const handled = new Set<string>();
        const cancelFile = path.join(shell.askpassDir, 'cancel');
        return setInterval(async () => {
            if (!shell.alive) { return; }
            let files: string[];
            try { files = fs.readdirSync(shell.askpassDir); }
            catch { return; }
            for (const file of files) {
                if (!file.startsWith('prompt-') || handled.has(file)) { continue; }
                handled.add(file);
                try {
                    const { id, prompt } = JSON.parse(fs.readFileSync(path.join(shell.askpassDir, file), 'utf-8'));
                    const password = await this.promptAuth(alias, String(prompt));
                    if (password !== undefined) {
                        fs.writeFileSync(path.join(shell.askpassDir, `response-${id}`), password, 'utf-8');
                    }
                    else {
                        fs.writeFileSync(cancelFile, '', 'utf-8');
                        shell.proc.kill();
                    }
                }
                catch { /* prompt-file read race — ignore, retry next tick */ }
            }
        }, 200);
    }

    private ensureSshInclude(targetPath: string): void {
        const sshDir = path.join(os.homedir(), '.ssh');
        const sshConfigPath = path.join(sshDir, 'config');
        const includeLine = `Include "${targetPath}"`;

        try {
            if (!fs.existsSync(sshDir)) {
                fs.mkdirSync(sshDir, { mode: 0o700 });
            }
            lockedUpdateTextFile(sshConfigPath, cur =>
                cur === undefined ? `${includeLine}\n`
                    : includeIsEffective(cur, includeLine) ? null
                        : `${includeLine}\n${cur}`, 0o600);
        }
        catch (err) {
            logger.error(`[ssh] Failed to add Include to ~/.ssh/config: ${errMsg(err)}`);
        }
    }
}

// Keeps the extension's ssh_config and the remote.SSH.serverInstallPath map equal to what the records say; idempotent, so
// every window runs it on every change. Remote-SSH reads the setting at connect, so a caller about to open a window awaits it.
export async function syncSshConfig(): Promise<void> {
    const sessions = getAllSessions();
    const text = renderSshConfig(sessions, sshKeyPath);
    if (fs.readFileSync(CS_SSH_CONFIG_PATH, 'utf-8') !== text) {
        fs.writeFileSync(`${CS_SSH_CONFIG_PATH}.tmp`, text, { mode: 0o600 });
        fs.renameSync(`${CS_SSH_CONFIG_PATH}.tmp`, CS_SSH_CONFIG_PATH);
    }
    try {
        const cfg = vscode.workspace.getConfiguration('remote.SSH');
        const current = cfg.get<Record<string, string>>('serverInstallPath') ?? {};
        const next = renderServerInstallPaths(sessions, current);
        if (JSON.stringify(next) !== JSON.stringify(current)) { await cfg.update('serverInstallPath', next, vscode.ConfigurationTarget.Global); }
    }
    catch (err) {
        logger.warn(`Could not update remote.SSH.serverInstallPath: ${errMsg(err)}`); // no Remote-SSH: the session lands on $HOME
    }
}

// forceNew=false relies on VS Code deduping by workspace identity: it focuses the window already holding this URI.
export function openSshWindow(alias: string, folder: string, forceNew: boolean): Thenable<unknown> {
    return vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.parse(`vscode-remote://ssh-remote+${alias}${folder}/`), { forceNewWindow: forceNew });
}

// The session key's public half, minting the pair on first use; the private key never leaves this machine.
export function sessionPublicKey(sessionId: string): string {
    const keyPath = sessionKeyPath(sessionId);
    const keygen = (...args: string[]) => execFileSync('ssh-keygen', args, { encoding: 'utf-8', stdio: 'pipe' }).trim();
    if (!hasSessionKey(sessionId)) {
        keygen('-q', '-t', 'ed25519', '-N', '', '-C', '', '-f', keyPath);
        fs.unlinkSync(`${keyPath}.pub`);
    }
    return keygen('-y', '-f', keyPath);
}

export const hasSessionKey = (sessionId: string): boolean => fs.existsSync(sessionKeyPath(sessionId));

export function deleteSessionPrivateKey(sessionId: string): void {
    try { fs.rmSync(sessionKeyPath(sessionId), { force: true }); }
    catch (err) {
        logger.error(`Failed to delete SSH private key for session ${sessionId}:`, err);
    }
}
