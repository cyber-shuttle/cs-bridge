// AWS sign-in held in memory, a poll of every enabled region, and SSH through a CS ssh_config entry aliased by instance
// id, since the Name tag is editable. Ec2 makes the API calls.
import * as vscode from 'vscode';
import { EC2Client } from '@aws-sdk/client-ec2';
import { CloudInstance } from '../models';
import { Ec2, InstanceAction, keyName } from './ec2';
import { SshManager, sshKeyPath, writeSshConfigEntry, deleteSshConfigEntry, openSshWindow } from './sshSupport';
import { confirmModal } from '@/webviewProvider';
import { Logger, errMsg } from '@/logger';

const logger = Logger.getInstance();

export class AwsClient implements vscode.Disposable {
    private readonly changed = new vscode.EventEmitter<void>();
    readonly onDidChange = this.changed.event;
    private timer?: NodeJS.Timeout;
    private polls = 0;
    // Set only by a successful sign-in, so every call below runs signed in.
    private session?: { ec2: Ec2; regions: string[] };
    private instances: CloudInstance[] = [];

    get regions(): string[] | undefined { return this.session?.regions; }
    getInstances(): CloudInstance[] { return this.instances; }

    dispose(): void {
        clearInterval(this.timer);
        this.changed.dispose();
    }

    async signIn(): Promise<void> {
        const ask = (title: string, password = false) => vscode.window.showInputBox({ title, password, ignoreFocusOut: true }).then(v => v?.trim());
        const accessKeyId = await ask('AWS Access Key ID');
        const secretAccessKey = accessKeyId && await ask('AWS Secret Access Key', true);
        const sessionToken = secretAccessKey && await ask('AWS Session Token (blank for a long-term key)', true);
        if (!accessKeyId || !secretAccessKey || sessionToken === undefined) { return; }
        const credentials = { accessKeyId, secretAccessKey, sessionToken: sessionToken || undefined };
        const clients = new Map<string, EC2Client>();
        const ec2 = new Ec2(region => clients.get(region) ?? clients.set(region, new EC2Client({ region, credentials })).get(region)!, sshKeyPath);
        try { this.session = { ec2, regions: await ec2.regions() }; }
        catch (err) {
            void vscode.window.showErrorMessage(`AWS sign-in failed: ${errMsg(err)}`);
            return;
        }
        this.timer ??= setInterval(() => void this.poll(), 20_000);
        await this.poll();
    }

    launch(image: string, type: string, region: string): Thenable<void> {
        return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Launching EC2 instance…' }, async () => {
            try {
                await this.session!.ec2.launch(image, type, region);
                void this.poll();
            }
            catch (err) {
                void vscode.window.showErrorMessage(`Failed to launch EC2 instance: ${errMsg(err)}`);
            }
        });
    }

    async act(action: InstanceAction, instance: CloudInstance): Promise<void> {
        if (action === 'terminate' && !await confirmModal(`Remove ${instance.name}?`, 'Remove', 'This terminates the instance and deletes its disk.')) { return; }
        try {
            await this.session!.ec2.act(action, instance);
            if (action === 'terminate') { await deleteSshConfigEntry(instance.id, instance.id, false); }
            void this.poll();
        }
        catch (err) {
            void vscode.window.showErrorMessage(`Failed to ${action} ${instance.name}: ${errMsg(err)}`);
        }
    }

    // Only the latest poll lands, so an overtaken one cannot overwrite a fresher list.
    private async poll(): Promise<void> {
        const poll = ++this.polls;
        const { ec2, regions } = this.session!;
        const found = await Promise.all(regions.map(region => ec2.list(region).catch((err) => {
            logger.error(`EC2 poll of ${region} failed:`, err);
            return [];
        })));
        if (poll !== this.polls) { return; }
        this.instances = found.flat();
        this.changed.fire();
    }

    private sshAlias(i: CloudInstance): Promise<string> {
        return writeSshConfigEntry(i.id, i.id, i.ip, 22, i.user, sshKeyPath(keyName(i.region)));
    }

    async openTerminal(i: CloudInstance): Promise<void> {
        SshManager.getInstance().openTerminal(await this.sshAlias(i));
    }

    async openRemote(i: CloudInstance): Promise<void> {
        await openSshWindow(await this.sshAlias(i), '', true);
    }
}
