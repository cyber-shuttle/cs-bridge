// A `vscode` module for `bun test`: the API surface the extension host modules touch at import or in tests.
import { mock } from 'bun:test';

const noop = () => { };
const disposable = () => ({ dispose: noop });
class EventEmitter {
    constructor() { this.listeners = new Set(); }
    event = (listener) => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; };
    fire(value) { for (const l of this.listeners) { l(value); } }
    dispose() { this.listeners.clear(); }
}
export const panels = [];
mock.module('vscode', () => ({
    EventEmitter,
    ThemeColor: class { constructor(id) { this.id = id; } },
    ConfigurationTarget: { Global: 1 },
    StatusBarAlignment: { Left: 1 },
    ViewColumn: { One: 1, Active: -1 },
    QuickPickItemKind: { Separator: -1 },
    QuickInputButtons: { Back: {} },
    ProgressLocation: { Notification: 15 },
    FileSystemError: class extends Error { },
    RelativePattern: class { },
    Uri: { parse: s => ({ toString: () => s, fsPath: s, authority: '' }), joinPath: (base, ...parts) => ({ toString: () => [base.toString(), ...parts].join('/'), fsPath: [base.fsPath, ...parts].join('/') }) },
    env: { machineId: 'test-machine', openExternal: async () => true },
    window: {
        createOutputChannel: () => ({ info: noop, warn: noop, error: noop, trace: noop, dispose: noop }),
        showErrorMessage: async () => undefined, showWarningMessage: async () => undefined, showInformationMessage: async () => undefined,
        createQuickPick: () => { const pick = { activeItems: [], onDidHide: noop, dispose: noop, onDidAccept: f => { pick.show = () => { pick.selectedItems = pick.activeItems; f(); }; } }; return pick; },
        createWebviewPanel: () => {
            const received = new EventEmitter(), disposed = new EventEmitter();
            const panel = { webview: { html: '', cspSource: 'vscode-webview:', asWebviewUri: u => u, posted: [], postMessage: async m => { panel.webview.posted.push(m); return true; }, onDidReceiveMessage: received.event }, onDidDispose: disposed.event, dispose: () => disposed.fire(), receive: m => received.fire(m) };
            panels.push(panel);
            return panel;
        },
        createStatusBarItem: () => ({ show: noop, hide: noop, dispose: noop }),
        createTerminal: () => ({ show: noop }),
    },
    commands: { executeCommand: async () => undefined, registerCommand: disposable },
    workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback, update: async () => undefined }), workspaceFolders: undefined, onDidChangeConfiguration: disposable },
    authentication: { getSession: async () => undefined, onDidChangeSessions: disposable },
}));
