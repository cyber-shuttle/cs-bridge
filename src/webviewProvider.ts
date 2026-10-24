import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { Logger } from './logger';
import { WebviewMessage } from './models';

type ViewKind = 'sessions' | 'hosts' | 'stats' | 'summary';

// One handler per command the view can post, so a message the view adds is a compile error here until handled.
export type Handlers<M extends WebviewMessage> = { [K in Exclude<M['command'], 'ready'>]: (message: Extract<M, { command: K }>) => void };

// Base for the sidebar webview views: renders the view's bundle and routes messages to/from the webview.
// Subclasses set viewKind and override the hooks below.
export abstract class WebviewProvider<M extends WebviewMessage> implements vscode.WebviewViewProvider {
    protected abstract readonly viewKind: ViewKind;
    protected abstract readonly handlers: Handlers<M>;
    protected readonly logger = Logger.getInstance();
    protected view?: vscode.WebviewView;

    constructor(protected readonly extensionUri: vscode.Uri) { }

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        const webview = webviewView.webview;
        webview.options = { enableScripts: true };
        this.view = webviewView;
        const msgSub = webview.onDidReceiveMessage((data: M) => this.handleMessage(data));
        const visSub = webviewView.onDidChangeVisibility(() => { if (webviewView.visible) { void this.pushState(); } });
        webviewView.onDidDispose(() => {
            // Ignore a replaced webview's late dispose so it can't clear the current view.
            if (this.view === webviewView) { this.view = undefined; }
            msgSub.dispose();
            visSub.dispose();
        });
        webview.html = renderHtml(webview, this.extensionUri, this.viewKind);
    }

    private handleMessage(data: M): void {
        this.logger.info('Received message from webview:', data);
        if (data.command === 'ready') { void this.pushState(); return; }
        (this.handlers[data.command as keyof Handlers<M>] as (message: M) => void)(data);
    }

    protected abstract pushState(): void;
}

export async function confirmModal(title: string, confirmLabel: string, detail?: string): Promise<boolean> {
    const choice = await vscode.window.showWarningMessage(title, { modal: true, detail }, confirmLabel);
    return choice === confirmLabel;
}

// ui/components/base's controls, in VS Code's theme colors.
const CONTROLS_CSS = `
.cs-button{display:inline-flex;align-items:center;justify-content:center;gap:4px;padding:2px 6px;border:1px solid var(--vscode-button-border,transparent);border-radius:4px;font:inherit;font-size:12px;line-height:16px;color:var(--vscode-button-foreground);background:var(--vscode-button-background);cursor:pointer}
.cs-button .codicon{font-size:inherit}
.cs-button:hover{background:var(--vscode-button-hoverBackground)}
.cs-button.secondary{color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground)}
.cs-button.secondary:hover{background:var(--vscode-button-secondaryHoverBackground)}
.cs-button:disabled{opacity:.5;cursor:default;pointer-events:none}
.cs-action{padding:2px;border:0;border-radius:5px;color:inherit;background:none;cursor:pointer}
.cs-action:hover{background:var(--vscode-toolbar-hoverBackground)}
.cs-select{padding:2px 4px;border:1px solid var(--vscode-dropdown-border);border-radius:4px;font:inherit;color:var(--vscode-dropdown-foreground);background:var(--vscode-dropdown-background)}
:is(.cs-button,.cs-action,.cs-select):focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:1px}`;

// CSP-gated HTML shell that loads the view's esbuild bundle (out/<view>.js) + codicons.
export function renderHtml(webview: vscode.Webview, extensionUri: vscode.Uri, view: ViewKind): string {
    // A CSP nonce is only worth having if it cannot be guessed, so it comes from the CSPRNG.
    const nonce = randomBytes(24).toString('base64url');
    const codiconCss = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'out', 'codicons', 'codicon.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'out', `${view}.js`));

    return `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <link rel="stylesheet" href="${codiconCss}" nonce="${nonce}">
        <style nonce="${nonce}">${CONTROLS_CSS}</style>
    </head>
    <body style="margin:0;padding:0"><div id="root"></div>
    <script nonce="${nonce}" src="${js}"></script>
    </body>
    </html>`;
}
