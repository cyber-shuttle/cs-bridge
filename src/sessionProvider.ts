import * as vscode from 'vscode';
import { enabled } from './features';
import { errMsg } from './logger';
import { Ec2Spec, HostRuntime, SlurmSession, SessionsState, SessionsMessage, newSession } from './models';
import { Handlers, WebviewProvider, confirmModal } from './webviewProvider';
import { deleteSessionPrivateKey, SshManager, openSshWindow } from './modules/sshSupport';
import { getSlurmDiscovery } from './modules/slurmSupport';
import { csHostAlias } from './modules/sshHostsStore';
import { addSession, deleteSession, getSession, getAllSessions, patch, setError, onSessionsChange, onWindowsChange, windowState, statusOf, fail, live, claim, owns } from './extensionStore';
import { readRecentSamples, onRunsChange } from './modules/runStore';
import { getMicrosoftAccountLabel } from './modules/tunnelSupport';
import { Backend, SessionMonitor, SlurmBackend, prepareLaunch } from './modules/sessionSupport';
import { Transports, disposeAllTunnelClients, disposeTunnelClient } from './modules/transport';
import { validateSlurmConfig, LaunchDraft } from './modules/slurmLaunch';
import { slurmAccount } from './modules/slurmParse';
import { isTerminal, isDeletable, isStoppable } from './modules/sessionMachine';
import { AwsClient } from './modules/aws';
import { Ec2Backend, ec2Session } from './modules/ec2Session';

function openSessionWindow(session: SlurmSession, forceNew: boolean): void {
    const { windowFolder } = windowState(session);
    if (!forceNew && windowFolder) { void vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.parse(windowFolder), { forceNewWindow: false }); return; }
    // The per-session SSH host's alias VS Code runs `ssh` against and shows as the "[SSH: …]" label.
    void openSshWindow(csHostAlias(session), session.rootFolder, forceNew);
}

export class SessionProvider extends WebviewProvider<SessionsMessage> implements vscode.Disposable {
    public static readonly viewType = 'csbridge.sessionsView';
    protected readonly viewKind = 'sessions' as const;

    private readonly hostRuntime = new Map<string, HostRuntime>();
    private draftAlias: string | null = null;
    private draft: (LaunchDraft & { sessionId: string }) | null = null;
    private readonly shared: vscode.Disposable[] = [];
    private readonly opening = new Set<string>();
    private readonly monitor: SessionMonitor;
    private readonly slurm: SlurmBackend;
    private readonly ec2: Ec2Backend;
    private sharedReady = false;

    // Set in a remote window (session-scoped, observe-only); undefined in the sidebar.
    constructor(extensionUri: vscode.Uri, private readonly transports: Transports, aws: AwsClient, private readonly remoteSessionId?: string) {
        super(extensionUri);
        this.slurm = new SlurmBackend(transports, () => this.monitor);
        this.ec2 = new Ec2Backend(aws, () => this.monitor);
        this.monitor = new SessionMonitor(s => this.backendFor(s));
        this.shared.push(aws.onDidSignIn(() => this.ec2.adopt().catch(err => this.logger.error('Adopting EC2 instances failed:', err))));
    }

    private backendFor(session: SlurmSession): Backend { return session.ec2 ? this.ec2 : this.slurm; }

    private release(session: SlurmSession | undefined) { return session && this.transports.transportFor(session).release(session); }

    private dropDraft() {
        if (this.draft) { void this.release(getSession(this.draft.sessionId)); }
        this.draft = null;
    }

    protected override onResolved(): void {
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
        this.shared.push(onWindowsChange(() => void this.reattachLiveSessions()));
    }

    // Sidebar only: drive every live session no beating window owns, rebuilding its tunnel connection (gone after a restart).
    public async reattachLiveSessions(): Promise<void> {
        if (this.remoteSessionId) { return; }
        for (const s of getAllSessions()) {
            const status = statusOf(s);
            // A stop still wanted is an unfinished Stop: a reload interrupted it, or a remote window handed it off.
            if (status === 'stopping') { if (claim(s)) { this.runStop(s); } continue; }
            if (!s.jobId || isTerminal(status) || owns(s)) { continue; }
            this.monitor.startMonitoring(s);
            // A session just taken over gets its connection back; startup never forces a sign-in.
            if (owns(s) && s.connectionInfo?.sshPort && (s.ec2 || await this.transports.transportFor(s).signedIn())) { void this.backendFor(s).connect(s); }
        }
    }

    dispose(): void {
        this.monitor.dispose(); // window close: clear every per-session poll interval so none leak past teardown
        this.shared.forEach(d => d.dispose());
        void disposeAllTunnelClients(); // window close: free local ports (remote stays, reaped by linkspan)
    }

    private dismiss(reset: () => void) {
        return () => { reset(); void this.pushState(); };
    }

    protected readonly handlers: Handlers<SessionsMessage> = {
        dismissDraftSession: this.dismiss(() => { this.draftAlias = null; }),
        dismissPreview: this.dismiss(() => this.dropDraft()),
        dismissAlert: this.dismiss(() => { this.alert = null; }),
        addSession: m => this.createSession(m),
        refreshSlurmDiscovery: ({ alias }) => this.fetchSlurmDiscovery(alias, true),
        // An EC2 session has no job script to preview, so Start submits at once.
        prepareLaunchSession: ({ sessionId }) => getSession(sessionId)?.ec2 ? this.submitSession(sessionId) : void this.prepareLaunchSession(sessionId),
        launchSession: ({ sessionId }) => this.submitSession(sessionId),
        stopSessionExecution: ({ sessionId }) => void this.stopSessionExecution(sessionId),
        stopRemoteSession: () => { if (this.remoteSessionId) { void vscode.commands.executeCommand('csbridge.stopRemoteSession'); } },
        connectTunnel: ({ sessionId }) => void this.connectSession(sessionId),
        deleteSession: ({ sessionId }) => void this.confirmAndDeleteSession(sessionId),
    };

    private createSession(data: Extract<SessionsMessage, { command: 'addSession' }>): void {
        const { alias } = data;
        const runtime = this.hostRuntime.get(alias);
        const session = newSession({
            alias,
            account: slurmAccount(data.account),
            partition: data.partition,
            rootFolder: runtime?.phase === 'ready' ? runtime.info.homeDir ?? '' : '',
            resources: data.resources,
        });
        void this.validateThenPersist(session, () => {
            addSession(session);
            this.draftAlias = null;
        });
    }

    private requireSession(id: string, action: string): SlurmSession | undefined {
        const s = getSession(id);
        if (!s) {
            this.logger.error(`Session with ID ${id} not found to ${action}.`);
            vscode.window.showErrorMessage('Session not found.');
        }
        return s;
    }

    private async confirmAndDeleteSession(sessionId: string) {
        const session = this.requireSession(sessionId, 'delete');
        if (!session) { return; }

        const status = statusOf(session);
        if (!isDeletable(status)) {
            this.logger.warn(`Session ${sessionId} is in status ${status} and cannot be deleted.`);
            vscode.window.showWarningMessage(`Session cannot be deleted from status: ${status}`);
            return;
        }

        const confirmed = await confirmModal('Delete session?', 'Delete', session.ec2
            ? 'This terminates the instance, deleting its disk, and removes the session record.'
            : 'This deletes the session record and cleans up its SSH config entry and key file.');
        if (!confirmed) { return; }

        await disposeTunnelClient(sessionId);
        try { await this.backendFor(session).remove(session); }
        catch (err) {
            vscode.window.showErrorMessage(`Failed to delete session: ${errMsg(err)}`);
            return;
        }
        if (!session.ec2) { deleteSessionPrivateKey(sessionId); } // an EC2 key is the region's
        deleteSession(sessionId);
    }

    public createCloudVm(ec2: Ec2Spec): void {
        addSession(ec2Session(ec2));
        void vscode.commands.executeCommand('csbridge.sessionsView.focus');
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

    protected override async pushState(): Promise<void> {
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
                        return { ...s, status: statusOf(s), ...live, opening: this.opening.has(s.id), samples: readRecentSamples(s.id) };
                    })
                    .sort((a, b) => b.id.localeCompare(a.id)), // newest first
                draftAlias: this.draftAlias,
                hostRuntime: Object.fromEntries(this.hostRuntime),
                preview: this.preview(),
                validating: this.validating,
                alert: this.alert,
            };
            view.webview.postMessage({ command: 'state', state });
        }
        catch (error) {
            this.logger.error('Failed to push webview state:', error);
        }
    }

    // 'opening' holds the session's spinner until the new window's heartbeat appears (60s fallback).
    private openOrFocusWindow(session: SlurmSession): void {
        if (windowState(session).windowAlive) { return openSessionWindow(session, false); }
        this.opening.add(session.id);
        setTimeout(() => { if (this.opening.delete(session.id)) { void this.pushState(); } }, 60_000);
        openSessionWindow(session, true);
    }

    private async connectSession(sessionId: string) {
        const session = this.requireSession(sessionId, 'connect Dev Tunnel');
        if (!session) { return; }
        // Already connected with a live remote window — this window's own, or another sidebar's (windowAlive reads the
        // shared window heartbeats). Just focus it; a second connection to the same Dev Tunnel is redundant and fights the first.
        if (statusOf(session) === 'connected') {
            this.openOrFocusWindow(session);
            return;
        }
        claim(session);
        if (await this.backendFor(session).connect(session)) { this.openOrFocusWindow(session); }
    }

    private async stopSessionExecution(sessionId: string) {
        const session = this.requireSession(sessionId, 'stop');
        if (!session) { return; }

        const status = statusOf(session);
        if (!isStoppable(status)) {
            this.logger.warn(`Session with ID ${sessionId} is in status ${status} and cannot be stopped.`);
            vscode.window.showWarningMessage(`Session cannot be stopped from status: ${status}`);
            return;
        }

        if (!await confirmModal('Stop session?', 'Stop', 'This stops the running job.')) { return; }

        patch(session, { desired: 'stopped', errorMessage: '' });
        this.runStop(session);
    }

    // The real stop, shared by the sidebar Stop and activation resuming an unfinished one.
    private runStop(session: SlurmSession): void {
        this.runSessionTask(session, 'stop', () => this.backendFor(session).stop(session),
            session.ec2 ? 'Please check the AWS console to ensure the instance has stopped.' : 'Please check the cluster to ensure the job has stopped and clean up any resources if necessary.');
    }

    private submitSession(sessionId: string) {
        const session = this.requireSession(sessionId, 'launch');
        if (!session) { return; }
        const draft = this.draft?.sessionId === sessionId ? this.draft : undefined;
        this.draft = null;
        // A fresh run: the walltime re-anchors when the new job starts, and a Slurm job id is the run's while an EC2 instance outlives it.
        patch(session, { desired: 'running', observed: undefined, failure: undefined, errorMessage: '', startedAt: undefined, submittedAt: Date.now(), ...!session.ec2 && { jobId: '' } });
        claim(session);
        live.launching.add(session.id);
        this.runSessionTask(session, 'launch', () => this.backendFor(session).start(session, draft).finally(() => live.launching.delete(session.id)),
            session.ec2 ? 'Please check the AWS console for a stray instance.' : 'Please clean up any resources on the cluster if necessary.');
    }

    // One task per session at a time; a failure marks the session failed and shows a dialog.
    private runSessionTask(session: SlurmSession, verb: string, run: () => Promise<void>, cleanupHint: string): void {
        if (live.busy.has(session.id)) { return; }
        live.busy.add(session.id);
        run().catch((error) => {
            const detail = `Failed to ${verb} session: ${errMsg(error)}`;
            this.logger.error(`${detail} (id ${session.id})`, error);
            vscode.window.showErrorMessage(`${detail}. ${cleanupHint}`);
            fail(session, detail);
            void this.release(session);
        }).finally(() => live.busy.delete(session.id));
    }

    private async prepareLaunchSession(sessionId: string) {
        const session = this.requireSession(sessionId, 'prepare launch');
        if (!session) { return; }
        try {
            await this.release(session); // the previous run's, before a transport switch hides it
            session.transport = enabled('cybershuttle') ? vscode.workspace.getConfiguration('csbridge').get('transport', 'devtunnel') : 'devtunnel';
            const draft = await prepareLaunch(session, this.transports.transportFor(session));
            if (this.draft?.sessionId !== sessionId) { this.dropDraft(); }
            this.draft = { sessionId, ...draft };
        }
        catch (err) {
            vscode.window.showErrorMessage(errMsg(err));
            setError(session, errMsg(err));
            this.logger.error('Failed to prepare session launch:', err);
        }
        void this.pushState();
    }

    private preview(): SessionsState['preview'] {
        const session = this.draft && getSession(this.draft.sessionId);
        return session && this.draft ? { sessionId: session.id, alias: session.alias, script: this.draft.script } : null;
    }
}
