import * as vscode from 'vscode';
import { HostsState, WebviewMessage } from './models';
import { WebviewProvider } from './webviewProvider';
import { SshManager } from './modules/sshSupport';
import { SshConfigEntry, assertValidHost } from './modules/sshCommandParser';
import { USER_SSH_CONFIG_PATH, addHostToConfigFile, deleteHostFromConfigFile, editHostInConfigFile } from './modules/sshHostsStore';

// Webview provider for the SSH Hosts view: reads user + read-only system SSH config, writes user SSH hosts to ~/.ssh/config.
export class SshHostProvider extends WebviewProvider {
    public static readonly viewType = 'csbridge.hostsView';
    protected readonly viewKind = 'hosts' as const;

    protected handleMessage(data: WebviewMessage): void {
        switch (data.command) {
            case 'ready': this.pushState(); break;
            case 'deleteSshHost': void this.deleteSshHost(data.alias ?? ''); break;
            case 'openTerminal': this.openTerminal(data.alias ?? ''); break;
            case 'editSshHost': void vscode.commands.executeCommand('csbridge.editHost', data.alias); break;
            default: this.logger.warn('Unknown command from hosts webview:', data);
        }
    }

    protected pushState(): void {
        if (!this.view) { return; }
        const state: HostsState = { sshHosts: SshManager.getInstance().getMergedHosts() };
        this.view.webview.postMessage({ command: 'state', state });
    }

    // Rides the SSH host's ControlMaster socket (Unix), so a shell on an already-authenticated host costs no second 2FA push.
    private openTerminal(alias: string): void {
        vscode.window.createTerminal({ name: alias, shellPath: 'ssh', shellArgs: [...SshManager.getInstance().buildControlMasterArgs(alias), alias] }).show();
    }

    // Title-bar action: re-read so hosts added externally (e.g. via Remote-SSH) appear without a window reload.
    public refreshSshHosts(): void {
        this.pushState();
    }

    public saveSshHost(entry: SshConfigEntry, alias?: string): void {
        assertValidHost(entry);
        if (alias) { editHostInConfigFile(USER_SSH_CONFIG_PATH, alias, entry); }
        else { addHostToConfigFile(USER_SSH_CONFIG_PATH, entry); }
        this.pushState();
        void vscode.window.showInformationMessage(`${alias ? 'Updated' : 'Added'} SSH host ${entry.Host}.`);
    }

    private async deleteSshHost(alias: string): Promise<void> {
        // Delete controls render only on user-config rows (system is read-only), so the target is always ~/.ssh/config.
        const choice = await vscode.window.showWarningMessage(
            `Delete SSH host '${alias}'?`,
            { modal: true, detail: 'This deletes it from ~/.ssh/config.' },
            'Delete',
        );
        if (choice !== 'Delete') { return; }
        try {
            deleteHostFromConfigFile(USER_SSH_CONFIG_PATH, alias);
        }
        catch (err) {
            this.showError(`Failed to delete SSH host ${alias}`, err);
        }
        this.pushState();
    }
}
