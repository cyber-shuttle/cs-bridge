import * as vscode from 'vscode';
import { Handlers, WebviewProvider, confirmModal } from './webviewProvider';
import { StatsState, StatsMessage } from './models';
import { readAllRuns, readSessionRuns, clearAllRuns, onRunsChange } from './modules/runStore';
import { getSession } from './extensionStore';
import { openSummaryPanel } from './summaryPanel';

export class StatsProvider extends WebviewProvider<StatsMessage> {
    public static readonly viewType = 'csbridge.statsView';
    protected readonly viewKind = 'stats' as const;

    // The watch fires on every live tick too (shared file), so only re-render when the run history actually changed.
    private lastRunsJson = '';

    constructor(extensionUri: vscode.Uri) {
        super(extensionUri);
        onRunsChange(() => {
            const json = JSON.stringify(readAllRuns());
            if (json === this.lastRunsJson) { return; }
            this.lastRunsJson = json;
            void this.pushState();
        });
    }

    protected readonly handlers: Handlers<StatsMessage> = {
        openRunSummary: ({ sessionId, jobId }) => {
            const session = getSession(sessionId);
            const run = readSessionRuns(sessionId).find(r => r.jobId === jobId);
            // Show the run's own recorded snapshot, not the live session's, which may have been started again.
            if (session && run) { openSummaryPanel(this.extensionUri, session, run); }
        },
    };

    public async clearHistory(): Promise<void> {
        if (await confirmModal('Clear all recorded run history?', 'Clear')) { clearAllRuns(); }
    }

    public refresh(): void { void this.pushState(); }

    protected override pushState(): void {
        const state: StatsState = { runs: readAllRuns() };
        this.view?.webview.postMessage({ command: 'state', state });
    }
}
