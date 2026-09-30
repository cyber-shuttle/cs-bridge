import * as vscode from 'vscode';
import { Logger, errMsg } from './logger';
import { legacySteps } from './modules/schema';
import { openStorage } from './storage';
import { attachWindow, detachWindow, getAllSessions } from './extensionStore';
import { csHostAlias } from './modules/sshHostsStore';
import { Plane } from './plane';
import { SessionProvider } from './sessionProvider';
import { SshHostProvider } from './sshHostProvider';
import { StatsProvider } from './statsProvider';
import { SshManager } from './modules/sshSupport';
import { Transports } from './modules/transport';
import { RemoteSessionController } from './remoteSessionController';
import { consumePendingSummary } from './summaryPanel';
import { CsBridgeMenu } from './menu';

export async function activate(context: vscode.ExtensionContext) {
    const logger = Logger.getInstance();
    logger.info('CS Bridge extension activating');

    try { await openStorage(context, legacySteps, err => logger.error('CS Bridge storage failed', err)); }
    catch (err) { void vscode.window.showErrorMessage(`CS Bridge: ${errMsg(err)}`); throw err; }
    logger.info(`Storage is ${context.globalStorageUri.toString()}`);

    const id = currentWindowSessionId();
    if (id) {
        logger.info(`Window is connected to CS Bridge session ${id}`);
        attachWindow(id);
    }

    const isRemoteWindow = !!id;
    void vscode.commands.executeCommand('setContext', 'csbridge.remote', isRemoteWindow);

    SshManager.initInstance(context.extensionUri);
    const plane = new Plane(context.secrets);
    const transports = new Transports(plane);
    const sessionProvider = new SessionProvider(context.extensionUri, transports, id);
    const sshHostProvider = new SshHostProvider(context.extensionUri);
    const statsProvider = new StatsProvider(context.extensionUri);
    const menu = new CsBridgeMenu(plane, sessionProvider, sshHostProvider, transports);
    context.subscriptions.push(
        sessionProvider,
        vscode.window.registerWebviewViewProvider(SessionProvider.viewType, sessionProvider),
        vscode.window.registerWebviewViewProvider(SshHostProvider.viewType, sshHostProvider),
        vscode.window.registerWebviewViewProvider(StatsProvider.viewType, statsProvider),
        vscode.commands.registerCommand('csbridge.menu', () => menu.open()),
        vscode.commands.registerCommand('csbridge.addHost', () => menu.open(menu.addHost)),
        vscode.commands.registerCommand('csbridge.editHost', (alias: string) => menu.open(menu.editHost(alias))),
        vscode.commands.registerCommand('csbridge.refreshHosts', () => sshHostProvider.refreshSshHosts()),
        vscode.commands.registerCommand('csbridge.refreshStats', () => statsProvider.refresh()),
        vscode.commands.registerCommand('csbridge.clearRunHistory', () => statsProvider.clearHistory()),
    );

    void sessionProvider.reattachLiveSessions();

    if (id) {
        // Remote window: own the walltime status bar + graceful end for this session.
        context.subscriptions.push(new RemoteSessionController(context, id));
    }
    else {
        void consumePendingSummary(context, context.extensionUri);
    }

    // on first-time install, show a toast with an "Open" action to reveal the sidebar panel.
    const marker = vscode.Uri.joinPath(context.globalStorageUri, 'opened.marker');
    if (!(await vscode.workspace.fs.stat(marker).then(() => true, () => false))) {
        await vscode.workspace.fs.writeFile(marker, new Uint8Array());
        void vscode.window.showInformationMessage('Completed installing CS Bridge.', 'Open')
            .then(c => c === 'Open' && vscode.commands.executeCommand('csbridge.sessionsView.focus'));
    }

    logger.info('CS Bridge extension activated');
}

function currentWindowSessionId(): string | undefined {
    const auth = vscode.workspace.workspaceFolders?.[0]?.uri.authority ?? '';
    const prefix = 'ssh-remote+';
    if (!auth.startsWith(prefix)) { return undefined; }
    const alias = auth.slice(prefix.length);
    // The alias carries no id, so reconstruct each session's and match. Safe here: extensionKind:ui runs this window's
    // extension host locally, so it can read the local session store (already initialized above).
    return getAllSessions().find(s => csHostAlias(s) === alias)?.id;
}

export function deactivate() {
    const detached = detachWindow(); // awaited by VS Code, so a closed window stops counting as open at once
    SshManager.disposeInstance();
    Logger.getInstance().dispose();
    return detached;
}
