import * as vscode from 'vscode';
import { configuredTransport } from './features';
import { errMsg } from './logger';
import { Ec2Spec, HostRuntime, SlurmSession, SessionsState, SessionsMessage, isEc2, newSession } from './models';
import { Handlers, WebviewProvider, confirmModal } from './webviewProvider';
import { SshManager, openSshWindow } from './modules/sshSupport';
import { getSlurmDiscovery } from './modules/slurmSupport';
import { csHostAlias } from './modules/sshHostsStore';
import { addSession, deleteSession, getSession, getAllSessions, patch, setError, onSessionsChange, windowState, statusOf, fail, live, claim, owns, disown, requestStop } from './extensionStore';
import { readRecentSamples, onRunsChange } from './modules/runStore';
import { getMicrosoftAccountLabel } from './modules/tunnelSupport';
import { Backends, SessionMonitor, SlurmBackend, prepareLaunch } from './modules/sessionSupport';
import { Transports, disposeAllTunnelClients, disposeTunnelClient } from './modules/transport';
import { validateSlurmConfig, LaunchDraft } from './modules/slurmLaunch';
import { slurmAccount } from './modules/slurmParse';
import { isTerminal, isDeletable, isStoppable } from './modules/sessionMachine';
import { AwsClient } from './modules/aws';
import { Ec2Backend, ec2Session } from './modules/ec2Session';

export class SessionProvider extends WebviewProvider<SessionsMessage> implements vscode.Disposable {
    public static readonly viewType = 'csbridge.sessionsView';
    protected readonly viewKind = 'sessions' as const;

    private readonly hostRuntime = new Map<string, HostRuntime>();
    private draftAlias: string | null = null;
    private draft: (LaunchDraft & { sessionId: string }) | null = null;
    private preparing = false; // one prepare at a time, so one draft follows another
    private readonly shared: vscode.Disposable[] = [];
    private readonly opening = new Map<string, ReturnType<typeof setTimeout>>(); // each open's own fallback timer
    private readonly monitor: SessionMonitor;
    private readonly slurm: SlurmBackend;
    private readonly ec2: Ec2Backend;
    private readonly backends: Backends;
    // Set in a remote window (session-scoped, observe-only); undefined in the sidebar, which alone drives sessions.
    constructor(extensionUri: vscode.Uri, private readonly transports: Pick<Transports, 'transportFor' | 'remove'>, aws: Pick<AwsClient, 'ec2' | 'ready' | 'onDidSignIn'>, private readonly remoteSessionId?: string) {
        super(extensionUri);
        this.slurm = new SlurmBackend(transports, () => this.monitor);
        this.ec2 = new Ec2Backend(aws, () => this.monitor);
        this.backends = new Backends(this.slurm, this.ec2);
        this.monitor = new SessionMonitor(this.backends);
        if (!remoteSessionId) { this.shared.push(aws.onDidSignIn(() => this.ec2.adopt().catch(err => this.logger.error('Adopting EC2 instances failed:', err)))); }
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
            void this.reattachLiveSessions(); // a Stop from any window reaches the owner through the record; a beat, too
        }));
        // Live samples land in the per-session files, not the record; pushState reads them at render time.
        this.shared.push(onRunsChange(() => void this.pushState()));
    }

    // A preview that goes unsubmitted gives back its run and its claim; the teardown is the monitor's, so quiesce waits for it.
    private async dropDraft(): Promise<void> {
        const session = this.draft && getSession(this.draft.sessionId);
        this.draft = null;
        if (session) { await this.monitor.endSession(session); this.settle(session); }
    }

    // Sidebar only: drive every live session no beating window owns, rebuilding its tunnel connection (gone after a restart).
    public async reattachLiveSessions(): Promise<void> {
        if (this.remoteSessionId) { return; }
        for (const s of getAllSessions()) {
            const status = statusOf(s);
            // The owner carries out a Stop asked anywhere; without a beating owner, this window takes it.
            if (status === 'stopping') { if (claim(s)) { this.runStop(s); } continue; }
            // A run ended by the clock while no window had its loop (the walltime passed with VS Code closed) is still torn
            // down; a record this window owns without a loop is in a task's or a preview's hands.
            if (isTerminal(status)) { if (s.connectionInfo && !owns(s) && claim(s)) { void this.monitor.endSession(s).finally(() => this.settle(s)); } continue; }
            if (owns(s)) { continue; }
            this.monitor.startMonitoring(s);
            // A session just taken over gets its connection back; startup never forces a sign-in.
            if (owns(s) && s.connectionInfo?.sshPort && (isEc2(s) || await this.transports.transportFor(s).signedIn())) { void this.backends.use(s, (b, s) => b.connect(s)); }
        }
    }

    dispose(): void {
        this.monitor.dispose();
        this.shared.forEach(d => d.dispose());
        void disposeAllTunnelClients(); // window close: free local ports
    }

    private dismiss(reset: () => void) {
        return () => { reset(); void this.pushState(); };
    }

    protected readonly handlers: Handlers<SessionsMessage> = {
        dismissDraftSession: this.dismiss(() => { this.draftAlias = null; }),
        dismissPreview: this.dismiss(() => void this.dropDraft()),
        dismissAlert: this.dismiss(() => { this.alert = null; }),
        addSession: m => this.createSession(m),
        refreshSlurmDiscovery: ({ alias }) => this.fetchSlurmDiscovery(alias, true),
        prepareLaunchSession: ({ sessionId }) => void this.prepareLaunchSession(sessionId),
        launchSession: () => this.launchDraft(),
        stopSessionExecution: ({ sessionId }) => void this.stopSessionExecution(sessionId),
        stopRemoteSession: () => void vscode.commands.executeCommand('csbridge.stopRemoteSession'), // posted only by a remote window's card
        connectTunnel: ({ sessionId }) => void this.connectSession(sessionId),
        deleteSession: ({ sessionId }) => void this.confirmAndDeleteSession(sessionId),
    };

    private createSession({ alias, account, partition, rootFolder, resources }: Extract<SessionsMessage, { command: 'addSession' }>): void {
        const session = newSession({ alias, account: slurmAccount(account), partition, rootFolder, resources });
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

        const confirmed = await confirmModal('Delete session?', 'Delete', isEc2(session)
            ? 'This terminates the instance, deleting its disk, and removes the session record.'
            : 'This deletes the session record and cleans up its SSH config entry and key file.');
        if (!confirmed || live.busy.has(sessionId)) { return; } // a task in flight holds the run this delete would tear down

        live.busy.add(sessionId);
        try {
            await this.monitor.quiesce(session);
            if (!this.drive(session)) { return; } // claimed after the loop ends, which releases the owner
            await disposeTunnelClient(sessionId);
            await this.backends.use(session, (b, s) => b.remove(s));
            deleteSession(sessionId);
        }
        catch (err) { vscode.window.showErrorMessage(`Failed to delete session: ${errMsg(err)}`); }
        finally { live.busy.delete(sessionId); this.settle(session); }
    }

    public createCloudVm(ec2: Ec2Spec): void {
        addSession(ec2Session(ec2));
        void vscode.commands.executeCommand('csbridge.sessionsView.focus');
    }

    public startSessionDraft(alias: string): void {
        this.draftAlias = alias;
        void vscode.commands.executeCommand('csbridge.sessionsView.focus');
        this.fetchSlurmDiscovery(alias); // pushes the state either way
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
                        if (live.windowAlive) { clearTimeout(this.opening.get(s.id)); this.opening.delete(s.id); }
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
        const { windowFolder } = windowState(session);
        if (windowFolder) { void vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.parse(windowFolder), { forceNewWindow: false }); return; }
        if (this.opening.has(session.id)) { return; } // the window is on its way
        const timer = setTimeout(() => { if (this.opening.get(session.id) === timer) { this.opening.delete(session.id); void this.pushState(); } }, 60_000);
        this.opening.set(session.id, timer);
        void this.pushState();
        // The per-session SSH host's alias VS Code runs `ssh` against and shows as the "[SSH: …]" label.
        void openSshWindow(csHostAlias(session), session.rootFolder);
    }

    private async connectSession(sessionId: string) {
        const session = this.requireSession(sessionId, 'connect');
        if (!session) { return; }
        // Already connected: this window's tunnel is up, or a remote window beats for the session. Focus that window, or open
        // one on the tunnel; a second connection to the same tunnel is redundant and fights the first.
        if (statusOf(session) === 'connected') {
            this.openOrFocusWindow(session);
            return;
        }
        // The record holds one local port, the owner's, so only the owner connects.
        if (!this.drive(session)) { return; }
        this.monitor.startMonitoring(session);
        if (await this.backends.use(session, (b, s) => b.connect(s))) { this.openOrFocusWindow(session); }
        this.settle(session);
    }

    // One window drives a session at a time; another window's launch or connection is still in flight while it beats.
    private drive(session: SlurmSession): boolean {
        if (claim(session)) { return true; }
        vscode.window.showInformationMessage('Another window is driving this session; act from there.');
        return false;
    }

    // A claim outlives its task as a monitor loop or as a preview; anything else gives it back.
    private settle(session: SlurmSession): void {
        if (!this.monitor.monitoring(session.id)) { disown(session); }
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

        requestStop(session); // the record change runs the stop in the owner window
    }

    // A stop the backend could not send leaves the session as it was; one it sent is followed by the run's teardown.
    private runStop(session: SlurmSession): void {
        this.runSessionTask(session, 'stop', async () => { await this.backends.use(session, (b, s) => b.stop(s)); await this.monitor.endSession(session); },
            'The session is still running.', (s, detail) => { patch(s, { desired: 'running' }); setError(s, detail); });
    }

    private launchDraft() {
        const draft = this.draft;
        this.draft = null;
        if (!draft) { return; }
        const session = getSession(draft.sessionId);
        if (session) { this.submit(session, () => this.slurm.start(session, draft)); }
    }

    // A fresh run: the walltime re-anchors when the new job starts, and a Slurm job id is the run's while an EC2 instance outlives it.
    private submit(session: SlurmSession, start: () => Promise<void>) {
        patch(session, { desired: 'running', observed: undefined, failure: undefined, errorMessage: '', startedAt: undefined, submittedAt: Date.now(), ...!isEc2(session) && { jobId: '' } });
        live.launching.add(session.id);
        this.runSessionTask(session, 'launch', () => start().finally(() => live.launching.delete(session.id)),
            isEc2(session) ? 'Please check the AWS console for a stray instance.' : 'Please clean up any resources on the cluster if necessary.',
            (s, detail) => { fail(s, detail); void this.monitor.endSession(s); });
    }

    private runSessionTask(session: SlurmSession, verb: string, run: () => Promise<void>, hint: string, mark: (session: SlurmSession, detail: string) => void): void {
        if (live.busy.has(session.id)) { return; }
        live.busy.add(session.id);
        run().catch((error) => {
            const detail = `Failed to ${verb} session: ${errMsg(error)}`;
            this.logger.error(`${detail} (id ${session.id})`, error);
            vscode.window.showErrorMessage(`${detail}. ${hint}`);
            mark(session, detail);
        }).finally(() => { live.busy.delete(session.id); this.settle(session); });
    }

    private async prepareLaunchSession(sessionId: string) {
        const session = this.requireSession(sessionId, 'prepare launch');
        if (!session || this.preparing || live.busy.has(session.id) || live.connecting.has(session.id)) { return; } // one prepare at a time; a Start during a connect is a no-op
        this.preparing = true;
        live.busy.add(session.id);
        try {
            await this.monitor.quiesce(session);
            await this.dropDraft(); // one preview at a time; a repeated Start gives its earlier attach back through the transport it used
        }
        finally { live.busy.delete(session.id); this.preparing = false; }
        if (!this.drive(session)) { return; }
        // An EC2 session has no job script to preview, so Start submits at once.
        if (isEc2(session)) { this.submit(session, () => this.ec2.start(session)); return; }
        this.preparing = true;
        live.busy.add(session.id);
        try {
            if (session.connectionInfo) { await this.monitor.endSession(session); } // the previous run's teardown, before a transport switch hides it
            patch(session, { transport: configuredTransport() });
            const draft = await prepareLaunch(session, this.transports.transportFor(session));
            this.draft = { sessionId, ...draft };
        }
        catch (err) {
            vscode.window.showErrorMessage(errMsg(err));
            setError(session, errMsg(err));
            this.logger.error('Failed to prepare session launch:', err);
            this.settle(session);
        }
        finally { live.busy.delete(session.id); this.preparing = false; }
        void this.pushState();
    }

    private preview(): SessionsState['preview'] {
        const draft = this.draft;
        const session = draft && getSession(draft.sessionId);
        return draft && session ? { sessionId: session.id, alias: session.alias, script: draft.script } : null;
    }
}
