import { SshHost } from '../models';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as vscode from 'vscode';
import { execFileSync, spawn, spawnSync, ChildProcessWithoutNullStreams } from 'child_process';
import * as crypto from 'crypto';
import { Logger, errMsg } from '../logger';
import { errnoCode, lockedUpdateTextFile } from './fsSupport';
import { parseJson } from './json';
import { getAllSessions } from '../extensionStore';
import { buildShellCommand, extractCommandResult, READY_MARKER, renderAuthHtml } from './sshShell';
import { USER_SSH_CONFIG_PATH, SYSTEM_SSH_CONFIG_PATH, SSH_RESILIENCE_OPTIONS, mergeHostsByPriority, parseHostsFromConfigText, renderSshConfig, renderServerInstallPaths, sessionKeyName, includeIsEffective } from './sshHostsStore';

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

// The single command in flight on a shell; its streams accumulate until both sentinels arrive (see sshShell).
type Pending = { rid: string; outBuf: string; errBuf: string; resolve: (r: CommandResult) => void }; // resolve latches

// One persistent `ssh … bash -l` per SSH host. `ready` resolves once the connect noise is drained; on Win32 (no
// ControlMaster) this in-process channel is the only multiplexing, so authentication happens once here.
type HostShell = {
    proc: ChildProcessWithoutNullStreams;
    ready: Promise<void>;
    alive: boolean;
    connecting: boolean;
    cancelAuth?: () => void; // closes an auth prompt the shell's exit has made moot
    current?: Pending;
};

export class SshManager {
    private static instance: SshManager | undefined;

    // One persistent shell per SSH host, plus a per-SSH-host serial queue so a single in-flight command owns the streams.
    private readonly shells = new Map<string, HostShell>();
    private readonly queues = new Map<string, Promise<unknown>>();

    private constructor(private readonly extensionUri: vscode.Uri) {
        if (process.platform !== 'win32') { CS_SSH_CONTROL_DIR = privateControlDir(); }
        fs.mkdirSync(CS_SSH_KEYS_DIR, { recursive: true, mode: 0o700 });
    }

    public static initInstance(extensionUri: vscode.Uri, storageDir: string): void {
        CS_SSH_CONFIG_PATH = path.join(storageDir, 'ssh_config');
        CS_SSH_KEYS_DIR = path.join(storageDir, 'ssh_keys');
        SshManager.instance ??= new SshManager(extensionUri);
        // Include'd above the user's global entries so a per-session SSH host wins via SSH first-match.
        SshManager.instance.ensureSshInclude(CS_SSH_CONFIG_PATH);
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
            if (errnoCode(err) !== 'ENOENT') { logger.error(`Error reading SSH config ${filePath}:`, err); }
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

    private buildControlMasterArgs(alias: string): string[] {
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
        if (code !== 0) { throw new Error(`exit ${code}: ${stderr.trim() || command}`); }
        return stdout;
    }

    private disposeAll(): void {
        for (const shell of this.shells.values()) { shell.alive = false; shell.proc.kill(); }
        this.shells.clear();
    }

    public static disposeInstance(): void {
        SshManager.instance?.disposeAll();
    }

    private enqueue<T>(alias: string, fn: () => Promise<T>): Promise<T> {
        const prev = this.queues.get(alias) ?? Promise.resolve();
        const next = prev.then(fn, fn);
        this.queues.set(alias, next.then(() => { }, () => { }));
        return next;
    }

    private async ensureShell(alias: string, batch: boolean): Promise<HostShell> {
        let shell = this.shells.get(alias);
        if (!shell) {
            shell = this.spawnShell(alias, batch);
            this.shells.set(alias, shell);
        }
        await shell.ready; // throws if this shell died during connect (auth failure / dismiss); caller maps it
        return shell;
    }

    private runOnShell(shell: HostShell, command: string): Promise<CommandResult> {
        return new Promise<CommandResult>((resolve) => {
            const rid = crypto.randomBytes(8).toString('hex');
            shell.current = { rid, outBuf: '', errBuf: '', resolve };
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
        const direct = /OpenSSH_for_Windows/.test(spawnSync('ssh', ['-V'], { encoding: 'utf-8' }).stderr);
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
        const askpassDir = batch ? undefined : fs.mkdtempSync(path.join(os.tmpdir(), 'cs-askpass-'));
        const env: NodeJS.ProcessEnv = { ...process.env, ...(askpassDir && this.askpassEnvironment(askpassDir)) };

        const connectArgs = batch
            ? ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10']
            : ['-o', 'NumberOfPasswordPrompts=3'];

        // `bash -l` gives the same PATH (Slurm binaries) a login shell has; the channel is held open and fed commands.
        const proc = spawn('ssh', [
            ...this.buildControlMasterArgs(alias),
            ...connectArgs,
            ...SSH_RESILIENCE_OPTIONS.filter(([key]) => key.startsWith('ServerAlive')).flatMap(([key, value]) => ['-o', `${key}=${value}`]),
            alias,
            'bash -l',
        ], { env, stdio: ['pipe', 'pipe', 'pipe'] });

        const ready = Promise.withResolvers<void>();
        const shell: HostShell = { proc, alive: true, connecting: true, ready: ready.promise };

        const settle = (p: Pending): void => {
            const result = extractCommandResult(p.rid, p.outBuf, p.errBuf);
            if (result) { p.resolve(result); }
        };

        let readyBuf = '';
        proc.stdout.on('data', (d: Buffer) => {
            const s = d.toString();
            if (shell.connecting) {
                readyBuf += s; // drain profile/MOTD noise until the shell echoes its readiness marker
                if (readyBuf.includes(READY_MARKER)) { shell.connecting = false; ready.resolve(); }
                return;
            }
            if (shell.current) { shell.current.outBuf += s; settle(shell.current); }
        });
        proc.stderr.on('data', (d: Buffer) => {
            if (!shell.connecting && shell.current) { shell.current.errBuf += d.toString(); settle(shell.current); }
        });
        proc.stdin.on('error', () => { /* write races a dropped connection; the close handler settles the command */ });

        proc.stdin.write(`printf '\\n${READY_MARKER}\\n'\n`);

        const poll = askpassDir && this.pollAskpass(shell, askpassDir, alias);
        const stopPoll = (): void => { if (poll) { clearInterval(poll); } };
        shell.ready.then(stopPoll, stopPoll); // authentication is one-shot at connect

        const drop = (onConnect: () => Error): void => {
            shell.alive = false;
            stopPoll();
            shell.cancelAuth?.();
            if (askpassDir) {
                try { fs.rmSync(askpassDir, { recursive: true, force: true }); }
                catch { /* best-effort */ }
            }
            if (this.shells.get(alias) === shell) { this.shells.delete(alias); }
            if (shell.connecting) { shell.connecting = false; ready.reject(onConnect()); }
            shell.current?.resolve({ stdout: shell.current.outBuf, stderr: `${shell.current.errBuf}\nssh connection closed`, code: 255 });
        };
        proc.on('close', (code: number | null) => drop(() => new Error(`SSH connection to ${alias} closed (exit ${code ?? 'null'})`)));
        proc.on('error', (err: Error) => drop(() => err));

        return shell;
    }

    // SSH auth prompt in a monospace webview (renderAuthHtml); resolves to the response, or undefined on dismiss.
    private promptAuth(shell: HostShell, alias: string, prompt: string): Promise<string | undefined> {
        const nonce = crypto.randomBytes(16).toString('hex');
        const panel = vscode.window.createWebviewPanel(
            'csbridge.sshAuth', `SSH Authentication — ${alias}`,
            vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true },
        );
        panel.webview.html = renderAuthHtml(prompt, nonce);
        return new Promise<string | undefined>((resolve) => {
            const finish = (v?: string) => { resolve(v); panel.dispose(); if (shell.cancelAuth === finish) { shell.cancelAuth = undefined; } }; // resolve latches, dispose is idempotent
            shell.cancelAuth = finish;
            panel.webview.onDidReceiveMessage((m: { type: 'submit'; value: string } | { type: 'cancel' }) =>
                finish(m.type === 'submit' ? m.value : undefined));
            panel.onDidDispose(() => finish(undefined));
        });
    }

    private pollAskpass(shell: HostShell, askpassDir: string, alias: string): NodeJS.Timeout {
        const handled = new Set<string>();
        const cancelFile = path.join(askpassDir, 'cancel');
        return setInterval(async () => {
            if (!shell.alive) { return; }
            let files: string[];
            try { files = fs.readdirSync(askpassDir); }
            catch { return; }
            for (const file of files) {
                if (!file.startsWith('prompt-') || handled.has(file)) { continue; }
                try {
                    const { id, prompt } = parseJson<{ id: string; prompt: string }>(fs.readFileSync(path.join(askpassDir, file), 'utf-8'));
                    handled.add(file); // a file still being written parses on a later tick
                    const password = await this.promptAuth(shell, alias, prompt);
                    if (password !== undefined) {
                        fs.writeFileSync(path.join(askpassDir, `response-${id}`), password, 'utf-8');
                    }
                    else {
                        fs.writeFileSync(cancelFile, '', 'utf-8');
                        shell.proc.kill();
                    }
                }
                catch { /* mid-write, or the folder went with the shell */ }
            }
        }, 200);
    }

    private ensureSshInclude(targetPath: string): void {
        const sshConfigPath = USER_SSH_CONFIG_PATH, sshDir = path.dirname(sshConfigPath);
        const includeLine = `Include "${targetPath}"`;

        try {
            fs.mkdirSync(sshDir, { recursive: true, mode: 0o700 });
            lockedUpdateTextFile(sshConfigPath, cur => (includeIsEffective(cur, includeLine) ? null : `${includeLine}\n${cur}`), 0o600);
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
    const text = renderSshConfig(sessions, sshKeyPath, vscode.env.machineId);
    lockedUpdateTextFile(CS_SSH_CONFIG_PATH, cur => (cur === text ? null : text), 0o600);
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

// A new window on the session's SSH host; focusing an existing one is openOrFocusWindow's, by the folder its beat names.
export function openSshWindow(alias: string, folder: string): Thenable<unknown> {
    return vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.parse(`vscode-remote://ssh-remote+${alias}${folder}/`), { forceNewWindow: true });
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
