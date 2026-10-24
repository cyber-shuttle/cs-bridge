import * as vscode from 'vscode';
import { getSession, statusOf, requestStop, onSessionsChange } from './extensionStore';
import { deadline, isTerminal } from './modules/sessionMachine';
import { isEc2 } from './models';
import { remainingMs, fmtTime, wallMs } from './ui/logic/session';
import { enqueuePendingSummary } from './summaryPanel';
import { confirmModal } from './webviewProvider';

const WARN_THRESHOLD_MS = 10 * 60_000;

// Lives only in a remote window. Owns the walltime status bar + a Stop button, and the end-to-local:
// on walltime expiry, terminal status, or the user hitting Stop, queue the summary and convert this window to local.
export class RemoteSessionController implements vscode.Disposable {
    private readonly item: vscode.StatusBarItem;
    private readonly stopItem: vscode.StatusBarItem;
    private readonly stopCommand: vscode.Disposable;
    private readonly ticker: ReturnType<typeof setInterval>;
    private readonly watcher: vscode.Disposable;
    private torndown = false;

    constructor(private readonly context: vscode.ExtensionContext, private readonly sessionId: string) {
        this.item = vscode.window.createStatusBarItem('csbridge.walltime', vscode.StatusBarAlignment.Left, 1000);
        this.item.command = 'csbridge.sessionsView.focus';

        this.stopItem = vscode.window.createStatusBarItem('csbridge.stopSession', vscode.StatusBarAlignment.Left, 999);
        this.stopItem.text = '$(debug-stop) Stop';
        this.stopItem.tooltip = 'Stop this session and return to a local window';
        this.stopItem.command = 'csbridge.stopRemoteSession';
        this.stopCommand = vscode.commands.registerCommand('csbridge.stopRemoteSession', () => this.requestStopHandoff());

        this.render();
        if (!this.torndown) { this.item.show(); this.stopItem.show(); }

        this.ticker = setInterval(() => this.render(), 1000);
        // Catches terminal transitions, from this window or another.
        this.watcher = onSessionsChange(() => this.render());
    }

    private render(): void {
        const s = getSession(this.sessionId);
        if (!s) { return; }
        if (isTerminal(statusOf(s))) { void this.teardown(); return; }

        if (wallMs(s) <= 0) {
            this.item.text = '$(clock) no limit';
            this.item.tooltip = `${s.name} · ${s.alias}`;
            this.item.backgroundColor = undefined;
            return;
        }
        const now = Date.now(), left = remainingMs(s, now);
        const endsAt = new Date(deadline(s) ?? now + left).toLocaleTimeString();
        this.item.text = `$(clock) ${fmtTime(left)} left`;
        this.item.tooltip = `${s.name} · ${s.alias} · ends ${endsAt}`;
        this.item.backgroundColor = left <= WARN_THRESHOLD_MS
            ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    }

    private async teardown(): Promise<void> {
        if (this.torndown) { return; }
        this.torndown = true;
        await this.endToLocal();
    }

    private async requestStopHandoff(): Promise<void> {
        if (this.torndown) { return; }
        const session = getSession(this.sessionId);
        if (!session) { return; }
        const confirmed = await confirmModal(
            'Stop session?', 'Stop', 'This stops the running job and returns this window to local.');
        if (!confirmed || this.torndown) { return; } // may have torn down (walltime/terminal) during the dialog

        this.torndown = true; // claim now so the 1s render tick can't race the reload
        this.stopItem.text = '$(loading~spin) Stopping…';
        await requestStop(session); // on disk before the reload
        await this.endToLocal();
    }

    // Enqueue the summary, then convert the window to local (which reloads it). Caller has claimed `torndown`.
    private async endToLocal(): Promise<void> {
        clearInterval(this.ticker);
        this.item.hide();
        this.stopItem.hide();
        const session = getSession(this.sessionId);
        if (session && !isEc2(session)) { await enqueuePendingSummary(this.context, this.sessionId); } // an instance has no Slurm accounting to summarize
        // remote.close reuses this window with remoteAuthority:null → local reload. If unavailable, fall back to closing.
        try { await vscode.commands.executeCommand('workbench.action.remote.close'); }
        catch { void vscode.commands.executeCommand('workbench.action.closeWindow'); }
    }

    dispose(): void {
        clearInterval(this.ticker);
        this.watcher.dispose();
        this.item.dispose();
        this.stopItem.dispose();
        this.stopCommand.dispose();
    }
}
