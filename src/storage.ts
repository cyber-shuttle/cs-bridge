import * as vscode from 'vscode';
import { Files, Steps, migrate } from './modules/store';
import { initSessionStore } from './extensionStore';
import { initRunStore } from './modules/runStore';
import { initCloudStore } from './modules/cloudStore';

function storageFiles(root: vscode.Uri): Files {
    const fs = vscode.workspace.fs;
    const uri = (name: string) => vscode.Uri.joinPath(root, name);
    const missing = <T>(value: T) => (err: unknown) => {
        if (err instanceof vscode.FileSystemError && err.code === 'FileNotFound') { return value; }
        throw err;
    };
    return {
        read: name => Promise.resolve(fs.readFile(uri(name))).then(b => new TextDecoder().decode(b), missing(undefined)),
        write: (name, text) => Promise.resolve(fs.writeFile(uri(name), new TextEncoder().encode(text))), // creates the folder
        remove: name => Promise.resolve(fs.delete(uri(name))).catch(missing(undefined)),
        list: dir => Promise.resolve(fs.readDirectory(uri(dir))).then(es => es.map(([name]) => name), missing([])),
    };
}

export async function openStorage(context: vscode.ExtensionContext, legacy: (files: Files, dir: string) => Steps,
    onError: (err: unknown) => void) {
    const root = context.globalStorageUri;
    const files = storageFiles(root);
    await migrate(files, legacy(files, root.fsPath));
    const dirs = [...await initSessionStore(files, onError), await initRunStore(files, onError),];
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, '*/*.json'));
    const reload = (uri: vscode.Uri) => {
        const [dir, name] = uri.path.split('/').slice(-2);
        void dirs.find(d => d.dir === dir)?.reload(name.slice(0, -'.json'.length));
    };
    await initCloudStore(files)
    watcher.onDidCreate(reload);
    watcher.onDidChange(reload);
    watcher.onDidDelete(reload);
    context.subscriptions.push(watcher);
}
