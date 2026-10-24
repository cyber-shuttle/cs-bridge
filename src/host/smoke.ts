// Runs inside a real extension host against the activated extension. Records written straight to the storage folder
// stand for another window's writes; the extension sees them through its file watcher.
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { describe, it, before, after } from 'mocha';
import assert from 'assert';
import { SlurmJobStatus, SlurmSession, newSession, Run, RunsFile } from '../models';
import { parseJson } from '../modules/json';
import { sleep } from '../modules/util';
import { storageFiles } from '../storage';
import { initSessionStore } from '../extensionStore';
import { initRunStore } from '../modules/runStore';
import { openSummaryPanel } from '../summaryPanel';
import { csHostAlias } from '../modules/sshHostsStore';

const EXTENSION_ID = 'cybershuttle.csbridge';
const userData = process.env.CSBRIDGE_USER_DATA;
if (!userData) { throw new Error('CSBRIDGE_USER_DATA names the test profile'); }
const storage = path.join(userData, 'User', 'globalStorage', EXTENSION_ID);
const file = (dir: string, id: string) => path.join(storage, dir, `${id}.json`);
const write = (dir: string, id: string, value: object) => {
    fs.mkdirSync(path.join(storage, dir), { recursive: true });
    fs.writeFileSync(`${file(dir, id)}.tmp`, JSON.stringify(value));
    fs.renameSync(`${file(dir, id)}.tmp`, file(dir, id)); // as the extension writes
};
const read = <T>(dir: string, id: string): T | undefined => (fs.existsSync(file(dir, id)) ? parseJson<T>(fs.readFileSync(file(dir, id), 'utf8')) : undefined);
const record = (id: string) => read<SlurmSession>('sessions', id);
const runs = (id: string): Run[] => read<RunsFile>('runs', id)?.runs || [];

async function until(what: string, check: () => boolean, ms = 90_000): Promise<void> {
    const end = Date.now() + ms;
    while (!check()) {
        if (Date.now() > end) { throw new Error(`timed out waiting for ${what}`); }
        await sleep(250);
    }
}

// A run on an unreachable host: every SSH step fails fast, so the paths under test are the extension's own.
const live = (fields: Partial<SlurmSession>): SlurmSession => newSession({
    alias: 'nohost.invalid', account: '', partition: 'p', rootFolder: '/tmp', resources: { cores: 1, memoryMb: 1024, wallMinutes: 60 },
    jobId: '101', startedAt: Date.now(), connectionInfo: { sshPort: 1, controlPort: 2 }, ...fields,
});

export function register(): void {
    describe('cs-bridge in a VS Code host', () => {
        const ended = live({ observed: { state: SlurmJobStatus.COMPLETED, at: Date.now() }, owner: 'closedwindow' });
        const running = live({ observed: { state: SlurmJobStatus.RUNNING, at: Date.now() }, owner: 'otherwindow', desired: 'stopped', connectionInfo: { sshPort: 1, controlPort: 2, localPort: 3 } });
        let extensionUri: vscode.Uri;

        before(async () => {
            const ext = vscode.extensions.getExtension(EXTENSION_ID);
            assert.ok(ext, 'extension installed');
            write('windows', 'otherwindow', { at: Date.now() + 600_000 }); // beats for the whole suite, loaded at activation
            await ext.activate();
            extensionUri = ext.extensionUri;
            await until('the window heartbeat', () => fs.existsSync(path.join(storage, 'windows')));
        });

        after(() => { for (const s of [ended, running]) { fs.rmSync(file('sessions', s.id), { force: true }); } });

        it('registers its views and commands', async () => {
            const commands = await vscode.commands.getCommands(true);
            for (const c of ['csbridge.menu', 'csbridge.addHost', 'csbridge.refreshHosts', 'csbridge.sessionsView.focus']) { assert.ok(commands.includes(c), c); }
            await vscode.commands.executeCommand('csbridge.sessionsView.focus');
        });

        it('tears down a run that ended while no window drove it', async () => {
            write('sessions', ended.id, ended);
            await until('the run record', () => runs(ended.id).length === 1);
            assert.deepEqual(runs(ended.id).map(r => [r.jobId, r.finalState]), [['101', 'stopped']]);
            await until('the claim release', () => record(ended.id)?.owner === undefined);
        });

        it('leaves a Stop to the beating owner and takes it once that window is gone', async () => {
            write('sessions', running.id, running);
            // The SSH config is rendered in the same change event as the sweep, so its Host block shows the record was seen.
            const sshConfig = path.join(storage, 'ssh_config'); // absent until a session has a Host block
            await until('the record to be loaded', () => fs.existsSync(sshConfig) && fs.readFileSync(sshConfig, 'utf8').includes(`Host ${csHostAlias(running)}`));
            assert.deepEqual([record(running.id)?.desired, record(running.id)?.owner], ['stopped', 'otherwindow']);
            fs.rmSync(file('windows', 'otherwindow'));
            // The stop fails on the unreachable host and is reverted; the monitor loop this window then starts may replace the message.
            await until('the failed stop to revert', () => record(running.id)?.desired === 'running' && !!record(running.id)?.errorMessage);
            assert.notEqual(record(running.id)?.owner, 'otherwindow');
        });

        it('opens a summary panel whose webview reports ready', async () => {
            const files = storageFiles(vscode.Uri.file(storage));
            await initSessionStore(files, (err) => { throw err; });
            await initRunStore(files, (err) => { throw err; });
            const panel = openSummaryPanel(extensionUri, ended);
            await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('the summary webview never reported ready')), 30_000);
                panel.webview.onDidReceiveMessage((m: { command: string }) => { if (m.command === 'ready') { clearTimeout(timer); resolve(); } });
            });
            assert.equal(panel.title, `Session ${ended.name} summary`);
            panel.dispose();
        });
    });
}
