import * as vscode from 'vscode';
import { getSession, statusOf, onSessionsChange } from './extensionStore';
import { renderHtml } from './webviewProvider';
import { isSameRun, readSessionRuns, readRecentSamples, readSessionStats, onRunsChange } from './modules/runStore';
import { Run, SlurmSession, SummaryState, WebviewMessage } from './models';

const PENDING_KEY = 'csbridge.pendingSummaries';
// Trade-off: hard cap so a never-consumed baton (e.g. an activation that errors before consuming) can't grow globalState unbounded. Bump if summaries ever legitimately queue deeper than this.
const MAX_PENDING = 8;

// Records "show a summary for <id> after the next local activation". Awaited by the caller so the write flushes before remote.close reloads the window.
export async function enqueuePendingSummary(context: vscode.ExtensionContext, id: string): Promise<void> {
    const queue = context.globalState.get<string[]>(PENDING_KEY, []).filter(x => x !== id);
    queue.push(id);
    await context.globalState.update(PENDING_KEY, queue.slice(-MAX_PENDING));
}

export async function consumePendingSummary(context: vscode.ExtensionContext): Promise<void> {
    const [id, ...rest] = context.globalState.get<string[]>(PENDING_KEY, []);
    if (!id) { return; }
    await context.globalState.update(PENDING_KEY, rest);
    const session = getSession(id);
    if (session) { openSummaryPanel(context.extensionUri, session); }
}

// A past run (from the Run History view) shows as it ended, while the live session may have been started again.
export function openSummaryPanel(extensionUri: vscode.Uri, session: SlurmSession, past?: Run): vscode.WebviewPanel {
    const panel = vscode.window.createWebviewPanel(
        'csbridge.summary', `Session ${session.name} summary`,
        vscode.ViewColumn.One, { enableScripts: true },
    );
    // Re-read the session each post: it may still be 'stopping' at open and flip to 'stopped' while the tab is up.
    // Pinned to the run the panel opened on, which the session may leave behind.
    const job = { alias: session.alias, jobId: session.jobId };
    const post = () => {
        const live = getSession(session.id) ?? session;
        const recorded = past ?? readSessionRuns(live.id).find(r => isSameRun(r, job));
        const state: SummaryState = {
            session: recorded
                ? { ...live, alias: recorded.alias, account: recorded.account, partition: recorded.partition, jobId: recorded.jobId, startedAt: recorded.startedAt, status: recorded.finalState, samples: recorded.samples }
                : { ...live, status: statusOf(live), samples: readRecentSamples(live.id) },
            stats: recorded ? recorded.stats : readSessionStats(live.id), // the live copy sacct refreshes in-run
            at: recorded ? recorded.endedAt : Date.now(),
            pending: !recorded,
        };
        void panel.webview.postMessage({ command: 'state', state });
    };
    const msgSub = panel.webview.onDidReceiveMessage((m: WebviewMessage) => { if (m.command === 'ready') { post(); } });
    const runsSub = onRunsChange(() => post());
    const sessSub = onSessionsChange(() => post());
    panel.webview.html = renderHtml(panel.webview, extensionUri, 'summary');
    panel.onDidDispose(() => { msgSub.dispose(); sessSub.dispose(); runsSub.dispose(); });
    return panel;
}
