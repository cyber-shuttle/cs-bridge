import * as vscode from 'vscode';
import { enabled } from './features';
import { uuidv7 } from 'uuidv7';
import { errMsg } from './logger';
import { HostRuntime, SlurmSession, SessionsState, WebviewMessage, InstanceActions, CloudFormOptions, CloudFormState } from './models';
import { WebviewProvider, confirmModal } from './webviewProvider';
import { deleteSshConfigEntry, addSshConfigEntry, hasSessionKey, SshManager } from './modules/sshSupport';
import { getSlurmDiscovery } from './modules/slurmSupport';
import { csHostAlias } from './modules/sshHostsStore';
import { addSession, deleteSession, getSession, getAllSessions, updateSession, setStatus, onSessionsChange, windowState } from './extensionStore';
import { readRecentSamples, onRunsChange } from './modules/runStore';
import { getMicrosoftAccountLabel } from './modules/tunnelSupport';
import { stopSession, SessionMonitor, launchSession, prepareLaunch } from './modules/sessionSupport';
import { Transports, connectSessionToTunnel, disposeAllTunnelClients, disposeTunnelClient, ensureRemoteSession, hasTunnelClient } from './modules/transport';
import { validateSlurmConfig } from './modules/slurmLaunch';
import { slurmAccount } from './modules/slurmParse';
import { isTerminal, isCloseable, isStoppable, isReattachable, isRelayLive, isWallTimeExpired } from './modules/sessionMachine';
import AWSClient from "./modules/aws"

// forceNew=false relies on VS Code deduping by workspace identity: it focuses the window already holding this URI.
function openSessionWindow(session: SlurmSession, forceNew: boolean): void {
    // The per-session SSH host's alias VS Code runs `ssh` against and shows as the "[SSH: …]" label.
    const uri = vscode.Uri.parse(`vscode-remote://ssh-remote+${csHostAlias(session)}${session.rootFolder}/`);
    vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: forceNew });
}

export class SessionProvider extends WebviewProvider implements vscode.Disposable {
    public static readonly viewType = 'csbridge.sessionsView';
    protected readonly viewKind = 'sessions' as const;

    private readonly hostRuntime = new Map<string, HostRuntime>();
    private draftAlias: string | null = null;
    private previewSession: SlurmSession | null = null;
    private previewSbatchEnv: Record<string, string> = {}; // a previewed run's secrets
    private readonly shared: vscode.Disposable[] = [];
    private readonly connecting = new Set<string>();
    private readonly opening = new Set<string>();
    private readonly monitor;
    private sharedReady = false;
    private awsClient = new AWSClient()
    private cloudPollInterval: NodeJS.Timeout | null = null;
    private pollIntervalTime = 10000
    private cloudForm: CloudFormState= null
    private cloudFormOptions: Record<string, CloudFormOptions> = {
        "aws": {
            image: [],
            type: [],
            region: []
        }
    }

    // Set in a remote window (session-scoped, observe-only); undefined in the sidebar.
    constructor(extensionUri: vscode.Uri, private readonly transports: Transports, private readonly remoteSessionId?: string) {
        super(extensionUri);
        this.monitor = new SessionMonitor(transports.transportFor);
    }

    private release(session: SlurmSession | null) { return session && this.transports.transportFor(session).release(session); }

    protected onResolved(): void {
        this.initSharedSubscriptions();
    }

    private initSharedSubscriptions(): void {
        if (this.sharedReady) { return; }
        this.sharedReady = true;
        this.shared.push(vscode.authentication.onDidChangeSessions((e) => {
            if (e.provider.id === 'microsoft') { void this.pushState(); }
        }));
        // A remote window re-renders only when its own session changes.
        let lastMine: string | undefined;
        this.shared.push(onSessionsChange(() => {
            const mine = this.remoteSessionId ? JSON.stringify(getSession(this.remoteSessionId)) : undefined;
            if (mine !== undefined && mine === lastMine) { return; }
            lastMine = mine;
            void this.pushState();
        }));
        // Live samples land in the per-session files (bypassing updateSession); pushState reads them at render time.
        this.shared.push(onRunsChange(() => void this.pushState()));
    }

    // At activation (sidebar only): resume monitoring and rebuild the tunnel connection (gone after restart) for every live-backend session.
    public async reattachLiveSessions(): Promise<void> {
        if (this.remoteSessionId) { return; }
        for (const s of getAllSessions()) {
            // A persisted 'stopping' is an unfinished Stop: a reload interrupted it, or a remote window handed it off.
            if (s.status === 'stopping') { this.runStop(s); continue; }
            if (!s.jobId || isTerminal(s.status)) { continue; }
            this.monitor.startMonitoring(s);
            // Reconnecting an expired session would only flash "connecting…" then fail back, and startup never forces a sign-in.
            if (s.connectionInfo?.sshPort && !hasTunnelClient(s.id) && !isWallTimeExpired(s, Date.now())
                && await this.transports.transportFor(s).signedIn()) { void this.connectTransport(s); }
        }
    }

    dispose(): void {
        this.monitor.dispose(); // window close: clear every per-session poll interval so none leak past teardown
        this.shared.forEach(d => d.dispose());
        void disposeAllTunnelClients(); // window close: free local ports (remote stays, reaped by linkspan)
        if (this.cloudPollInterval) {
            clearInterval(this.cloudPollInterval)
            this.cloudPollInterval = null
        }
    }

    private readonly dismissals: Record<string, () => void> = {
        dismissDraftSession: () => { this.draftAlias = null; },
        dismissPreview: () => { void this.release(this.previewSession); this.previewSession = null; this.previewSbatchEnv = {}; },
        dismissAlert: () => { this.alert = null; },
        dismissCloudForm: () => { this.cloudForm = null; },
    };

    private readonly handlers: Record<string, (data: WebviewMessage, id: string) => void> = {
        ready: () => void this.pushState(),
        addSession: data => this.createSession(data),
        refreshSlurmDiscovery: data => this.fetchSlurmDiscovery(data.alias ?? '', true),
        prepareLaunchSession: (_data, id) => void this.prepareLaunchSession(id),
        launchSession: (_data, id) => this.submitSession(id),
        stopSessionExecution: (_data, id) => this.stopSessionExecution(id),
        stopRemoteSession: () => {
            if (this.remoteSessionId) { void vscode.commands.executeCommand('csbridge.stopRemoteSession'); }
        },
        connectTunnel: (_data, id) => void this.connectSession(id),
        deleteSession: (_data, id) => this.confirmAndDeleteSession(id),
        pollCloudStatus: (_data) => {
            this.cloudPollInterval = setInterval(() => {
                this.awsClient.pollInstances()
                this.pushState()
            }, this.pollIntervalTime);
        },
        launchCloudInstance: (_data) => this.awsClient.launchEC2Instance(),
        stopCloudInstance: (_data) => {
            if (_data.instanceId) {
                this.awsClient.doInstanceActions(InstanceActions.Stop, _data.instanceId, "")
            }
        },
        restartCloudInstance: (_data) => {
            if (_data.instanceId) {
                this.awsClient.doInstanceActions(InstanceActions.Start, _data.instanceId, "")
            }
        },
        removeCloudInstance: (_data,) => {
            if (_data.instanceId && _data.instanceName) {
                this.awsClient.removeInstance(_data.instanceId, _data.instanceName)
            }
        },
        sshIntoCloudInstance: (_data) => this.awsClient.openTerminal(_data.instanceIp ?? ""),
        startRemoteForloudInstance: async (_data) => {
            if (_data.instanceId && _data.instanceName && _data.instanceIp) {

                console.log("Launching Remote Session")
                await this.awsClient.openRemoteSession(_data.instanceId, _data.instanceName, _data.instanceIp)
            }
        },

    };

    protected handleMessage(data: WebviewMessage) {
        this.logger.info('Received message from webview:', data);
        const dismiss = this.dismissals[data.command];
        if (dismiss) {
            dismiss();
            void this.pushState();
            return;
        }
        const handler = this.handlers[data.command];
        if (!handler) {
            this.logger.warn('Unknown command from webview:', data.command);
            return;
        }
        handler(data, data.sessionId ?? '');
    }

    private createSession(data: WebviewMessage): void {
        const now = Date.now();
        const alias = data.alias ?? '';
        const runtime = this.hostRuntime.get(alias);
        const session: SlurmSession = {
            id: uuidv7(), // time-ordered, so sorting by id is creation order
            name: `${now}`,
            status: 'not_started',
            alias,
            account: slurmAccount(data.account),
            partition: data.partition ?? '',
            rootFolder: runtime?.phase === 'ready' ? runtime.info.homeDir ?? '' : '',
            resources: data.resources!,
            jobId: '',
            submittedAt: now,
            errorMessage: '',
            transport: 'devtunnel',
        };
        void this.validateThenPersist(session, () => {
            addSession(session);
            this.draftAlias = null;
        });
    }

    private requireSession(id: string, action: string, push: boolean): SlurmSession | undefined {
        const s = getSession(id);
        if (!s) {
            this.logger.error(`Session with ID ${id} not found to ${action}.`);
            vscode.window.showErrorMessage('Session not found.');
            if (push) { void this.pushState(); }
        }
        return s;
    }

    private async confirmAndDeleteSession(sessionId: string) {
        // The webview disables this session's buttons on click, so every exit path must
        // refresh to re-enable them (or to drop the session after a successful delete).
        const session = this.requireSession(sessionId, 'delete', true);
        if (!session) { return; }

        if (!isDeletable(session.status)) {
            this.logger.warn(`Session ${sessionId} is in status ${session.status} and cannot be deleted.`);
            vscode.window.showWarningMessage(`Session cannot be deleted from status: ${session.status}`);
            void this.pushState();
            return;
        }

        const confirmed = await confirmModal('Delete session?', 'Delete',
            'This deletes the session record and cleans up its SSH config entry and key file.');
        if (!confirmed) {
            void this.pushState();
            return;
        }

        await disposeTunnelClient(sessionId);
        await this.transports.remove(session);
        await deleteSshConfigEntry(sessionId, csHostAlias(session)); // logs its own failure
        deleteSession(sessionId);
        void this.pushState();
    }

    public startSessionDraft(alias: string): void {
        this.draftAlias = alias;
        void vscode.commands.executeCommand('csbridge.sessionsView.focus');
        void this.pushState();
        this.fetchSlurmDiscovery(alias);
    }

    private validating = false;
    private alert: SessionsState['alert'] = null;

    private async validateThenPersist(session: SlurmSession, persist: () => void): Promise<void> {
        if (this.validating) { return; }
        this.validating = true;
        void this.pushState();
        try {
            await validateSlurmConfig(session, SshManager.getInstance(), this.logger);
            persist();
        }
        catch (err) {
            this.logger.error('Session validation failed:', err);
            this.alert = { title: 'Session validation failed', message: errMsg(err) };
        }
        finally {
            this.validating = false;
            void this.pushState();
        }
    }

    private setHostRuntime(alias: string, runtime: HostRuntime): void {
        this.hostRuntime.set(alias, runtime);
        void this.pushState();
    }

    private fetchSlurmDiscovery(alias: string, force = false): void {
        if (!force && this.hostRuntime.get(alias)?.phase === 'ready') { void this.pushState(); return; }
        this.logger.info(`Discovering Slurm on SSH host ${alias}`);
        this.setHostRuntime(alias, { phase: 'loading' });
        getSlurmDiscovery(alias)
            .then(info => this.setHostRuntime(alias, { phase: 'ready', info }))
            .catch((error) => {
                this.logger.error('Error discovering Slurm:', error);
                this.setHostRuntime(alias, { phase: 'error', message: errMsg(error) });
            });
    }

    private scopedSessions(): SlurmSession[] {
        return this.remoteSessionId ? getAllSessions().filter(s => s.id === this.remoteSessionId) : getAllSessions();
    }

    protected async pushState(): Promise<void> {
        const view = this.view;
        if (!view) { return; }
        try {
            view.description = await getMicrosoftAccountLabel() ?? 'Not Signed In';
            const state: SessionsState = {
                isRemote: this.remoteSessionId !== undefined,
                sessions: this.scopedSessions()
                    .map((s) => {
                        const live = windowState(s);
                        if (live.windowAlive) { this.opening.delete(s.id); }
                        return { ...s, ...live, opening: this.opening.has(s.id), samples: readRecentSamples(s.id) };
                    })
                    // newest first (uuidv7 ids are time-ordered)
                    .sort((a, b) => b.id.localeCompare(a.id)),
                draftAlias: this.draftAlias,
                hostRuntime: Object.fromEntries(this.hostRuntime),
                previewSession: this.previewSession,
                validating: this.validating,
                alert: this.alert,
                isCloud: this.awsClient.isReady(),
                cloudSessions: this.awsClient.getInstances(),
                cloudForm: this.cloudForm,
                cloudFormOptions: this.cloudFormOptions.aws
            };

            view.webview.postMessage({ command: 'state', state });
        }
        catch (error) {
            this.logger.error('Failed to push webview state:', error);
        }
    }

    // Step 2 core: (re)build the in-process connection from the persisted refs. No window — reattach and connect share this.
    private async connectTransport(session: SlurmSession): Promise<boolean> {
        if (this.connecting.has(session.id)) {
            this.logger.info(`Connect already in progress for session ${session.id}; ignoring re-entrant request`);
            return false;
        }
        this.connecting.add(session.id);
        const transport = this.transports.transportFor(session);
        try {
            setStatus(session, 'connecting');
            await ensureRemoteSession(transport, session); // idempotent; refreshes tunnel creds for reattach
            const localPort = await connectSessionToTunnel(transport, session, () => void this.reconnectDevTunnel(session.id));
            // These awaits can run tens of seconds against a dead node; if the monitor terminalized meanwhile (session
            // auto-refreshes in place), drop the Dev Tunnel connection rather than overwrite its verdict.
            if (isTerminal(session.status) || isWallTimeExpired(session, Date.now())) {
                await disposeTunnelClient(session.id);
                return false;
            }
            if (!hasSessionKey(session.id)) { throw new Error('SSH private key not found for session'); }
            const alias = await addSshConfigEntry(session, localPort);
            this.logger.info(`SSH config entry ready for session ${session.id} (ssh ${alias})`);
            setStatus(session, 'connected');
            return true;
        }
        catch (error) {
            this.logger.error(`Error connecting the ${transport.label} for session ${session.id}:`, error);
            await disposeTunnelClient(session.id);
            // Same terminal guard as the success path: don't resurrect a session the monitor stopped mid-connect.
            if (!isTerminal(session.status)) {
                // Step 1 still up (sshPort persisted) -> connection-only failure, retry from ready_to_connect; else unreachable.
                setStatus(session, session.connectionInfo?.sshPort ? 'ready_to_connect' : 'unreachable', `Failed to connect ${transport.label}: ${errMsg(error)}`);
            }
            return false;
        }
        finally {
            this.connecting.delete(session.id);
        }
    }

    // Auto-recover a half-open Dev Tunnel: rebuild Step 2 (connectTransport disposes the dead client, reconnects, rewrites the
    // ssh_config port) while the session is still reachable and within its walltime. Its own guard blocks re-entry.
    private async reconnectDevTunnel(sessionId: string): Promise<void> {
        const session = getSession(sessionId);
        if (!session || !isReachable(session.status) || isWallTimeExpired(session, Date.now())) { return; }
        this.logger.warn(`Session ${session.id}: Dev Tunnel half-open — rebuilding it.`);
        await this.connectTransport(session);
    }

    // 'opening' holds the session's spinner until the new window's heartbeat appears (60s fallback).
    private openOrFocusWindow(session: SlurmSession): void {
        if (windowState(session).windowAlive) { return openSessionWindow(session, false); }
        this.opening.add(session.id);
        setTimeout(() => { if (this.opening.delete(session.id)) { void this.pushState(); } }, 60_000);
        openSessionWindow(session, true);
    }

    private async connectSession(sessionId: string) {
        const session = this.requireSession(sessionId, 'connect Dev Tunnel', true);
        if (!session) { return; }
        try {
            // Stale Connect/Switch on an expired session: stop it (the monitor terminal-guard untracks) instead of a doomed Dev Tunnel connection.
            if (isWallTimeExpired(session, Date.now())) {
                setStatus(session, 'stopped', '');
                await disposeTunnelClient(session.id);
                vscode.window.showInformationMessage('This session was stopped at its walltime limit. Start it again for a new run.');
                return;
            }
            // Already connected with a live remote window — this window's own, or another sidebar's (windowAlive reads the
            // shared window heartbeats). Just focus it; a second connection to the same Dev Tunnel is redundant and fights the first.
            if (session.status === 'connected' && (windowState(session).windowAlive || session.connectionInfo?.localPort)) {
                this.openOrFocusWindow(session);
                return;
            }
            if (await this.connectTransport(session)) { this.openOrFocusWindow(session); }
        }
        finally { void this.pushState(); }
    }

    private async stopSessionExecution(sessionId: string) {
        const session = this.requireSession(sessionId, 'stop', false);
        if (!session) { return; }

        if (!isStoppable(session.status)) {
            this.logger.warn(`Session with ID ${sessionId} is in status ${session.status} and cannot be stopped.`);
            vscode.window.showWarningMessage(`Session cannot be stopped from status: ${session.status}`);
            void this.pushState();
            return;
        }

        if (!await confirmModal('Stop session?', 'Stop', 'This stops the running job.')) { void this.pushState(); return; }

        setStatus(session, 'stopping', '');
        void this.pushState();
        this.runStop(session);
    }

    // The real stop (via stopSession), shared by the sidebar Stop and activation resuming an unfinished one.
    private runStop(session: SlurmSession): void {
        this.runSessionTask(session, 'stop', () => stopSession(session, this.monitor),
            'Please check the cluster to ensure the job has stopped and clean up any resources if necessary.');
    }

    private submitSession(sessionId: string) {
        const session = this.requireSession(sessionId, 'launch', false);
        if (!session) { return; }
        const sbatchEnv = this.previewSession?.id === sessionId ? this.previewSbatchEnv : {};
        this.previewSession = null;
        this.previewSbatchEnv = {};
        session.startedAt = undefined; // fresh launch: re-anchor the walltime countdown when the new job starts running
        setStatus(session, 'submitting', '');
        void this.pushState();
        this.runSessionTask(session, 'launch', () => launchSession(session, this.monitor, sbatchEnv),
            'Please clean up any resources on the cluster if necessary.');
    }

    // A failure marks the session failed and shows a dialog.
    private runSessionTask(session: SlurmSession, verb: string, run: () => Promise<void>, cleanupHint: string): void {
        run().then(() => {
            void this.pushState();
        }).catch((error) => {
            const detail = `Failed to ${verb} session: ${errMsg(error)}`;
            this.logger.error(`${detail} (id ${session.id})`, error);
            vscode.window.showErrorMessage(`${detail}. ${cleanupHint}`);
            setStatus(session, 'failed', detail);
            void this.release(session);
            void this.pushState();
        });
    }

    private async prepareLaunchSession(sessionId: string) {
        const session = this.requireSession(sessionId, 'prepare launch', false);
        if (!session) { return; }
        try {
            await this.release(session); // the previous run's, before a transport switch hides it
            session.transport = enabled('cybershuttle') ? vscode.workspace.getConfiguration('csbridge').get('transport', 'devtunnel') : 'devtunnel';
            this.previewSbatchEnv = await prepareLaunch(session, this.transports.transportFor(session));
        }
        catch (err) {
            vscode.window.showErrorMessage(errMsg(err));
            session.errorMessage = errMsg(err);
            updateSession(session);
            this.logger.error('Failed to prepare session launch:', err);
            return void this.pushState();
        }
        if (this.previewSession?.id !== sessionId) { void this.release(this.previewSession); }
        this.previewSession = session;
        void this.pushState();
    }
}
