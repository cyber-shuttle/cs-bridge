// CS Bridge's one menu: a QuickPick walking a stack of pages, where package.json binds Escape to Back while
// csbridge.menuNested holds. Pages render from cached account state refreshed behind them, so the menu opens at once.
// Dev Tunnels sign-out is VS Code's account action, which signs the account out of VS Code as a whole.
import * as vscode from 'vscode';
import { Logger, errMsg } from './logger';
import { Plane, type Cluster } from './plane';
import { SshHost, EC2_IMAGES, EC2_TYPES, HOST_SOURCE_ICON } from './models';
import { SessionProvider } from './sessionProvider';
import { AwsClient } from './modules/aws';
import { SshHostProvider } from './sshHostProvider';
import { SshManager } from './modules/sshSupport';
import { getMicrosoftAccountLabel, switchDevTunnelAccount } from './modules/tunnelSupport';
import { enabled } from './features';
import { parseHostToken, sshCommandToConfig } from './modules/sshCommandParser';

type Page = { title: string; placeholder?: string; items: Item[]; input?: { value: string; submit: (value: string) => Build | void } };
type Build = () => Page;
type Item = vscode.QuickPickItem & { run?: () => unknown; open?: Build };
const ask = (title: string, placeholder: string, value: string, submit: (value: string) => Build | void): Page => ({ title, placeholder, items: [], input: { value, submit } });

const fail = (err: unknown) => void vscode.window.showErrorMessage(`CS Bridge: ${errMsg(err)}`);
const nested = (value: boolean) => void vscode.commands.executeCommand('setContext', 'csbridge.menuNested', value);
// HostName defaults to the alias in ssh_config.
const destination = ({ alias, user, hostname = alias }: SshHost): string => (user ? `${user}@${hostname}` : hostname);

export class CsBridgeMenu {
    private signedIn = false;
    private microsoft: string | null = null;
    private clusters: Cluster[] = [];

    constructor(
        private readonly plane: Plane, private readonly sessions: SessionProvider,
        private readonly sshHosts: SshHostProvider, private readonly aws: AwsClient,
    ) { void this.refreshAccounts(); }

    open(start: Build = this.root): void {
        const pick = vscode.window.createQuickPick<Item>();
        const stack: Build[] = [];
        let page: Page;
        const render = (build: Build): boolean => {
            try { page = build(); }
            catch (err) { fail(err); return false; }
            Object.assign(pick, {
                title: page.title, placeholder: page.placeholder, items: page.items, ignoreFocusOut: !!page.input,
                buttons: stack.length > 1 ? [vscode.QuickInputButtons.Back] : [],
            });
            nested(stack.length > 1);
            return true;
        };
        const show = (build: Build): boolean => { if (!render(build)) { return false; } pick.value = page.input ? page.input.value : ''; return true; };
        const go = (build: Build) => { stack.push(build); if (!show(build)) { pick.hide(); } };
        pick.onDidTriggerButton(() => { stack.pop(); const top = stack.at(-1); if (top && !show(top)) { pick.hide(); } });
        pick.onDidAccept(() => {
            const item = pick.activeItems[0];
            if (page.input && !item) {
                const value = pick.value.trim();
                if (!value) { return; }
                try { const next = page.input.submit(value); if (next) { go(next); return; } pick.hide(); }
                catch (err) { fail(err); }
                return;
            }
            if (item?.open) { go(item.open); return; }
            pick.hide();
            (async () => item?.run?.())().catch(fail).finally(() => this.refreshAccounts());
        });
        pick.onDidHide(() => { stack.length = 0; nested(false); pick.dispose(); });
        stack.push(start);
        if (!show(start)) { pick.dispose(); return; } // never shown, so onDidHide will not dispose it
        pick.show();
        void this.refreshAccounts().then(() => { if (stack.at(-1) === this.root) { render(this.root); } });
    }

    private async refreshAccounts() {
        try {
            [this.signedIn, this.microsoft] = await Promise.all([this.plane.signedIn(), getMicrosoftAccountLabel(), enabled('aws') && this.aws.restored]);
        }
        catch (err) { Logger.getInstance().warn(`Menu account refresh failed: ${errMsg(err)}`); }
        await Promise.all([this.refreshClusters(), this.sshHosts.refreshSshHosts()]);
    }

    private async refreshClusters() {
        try { this.clusters = enabled('cybershuttle') && this.signedIn ? (await this.plane.clusters()).sort((a, b) => a.clusterName.localeCompare(b.clusterName)) : []; }
        catch (err) { Logger.getInstance().warn(`Listing CyberShuttle clusters failed: ${errMsg(err)}`); }
    }

    private readonly root: Build = () => {
        const { signedIn, microsoft } = this;
        const cybershuttle = enabled('cybershuttle');
        return {
            title: 'CS Bridge',
            items: [
                { label: '$(add) Create New Session', open: this.hosts },
                { label: '$(server) Add Compute Host', open: this.addHost },
                ...enabled('aws') && this.aws.regions ? [{ label: '$(cloud) Create Cloud VM', open: this.cloudVm(this.aws.regions) }] : [],
                { label: 'Accounts', kind: vscode.QuickPickItemKind.Separator },
                ...cybershuttle ? [!signedIn
                    ? { label: '$(sign-in) Sign In to CyberShuttle', run: () => signIn(this.plane) }
                    : { label: '$(sign-out) Sign Out of CyberShuttle', run: () => this.plane.signOut() }] : [],
                microsoft === null
                    ? { label: '$(sign-in) Sign In to Microsoft DevTunnel', run: switchDevTunnelAccount }
                    : { label: '$(sign-out) Sign Out of Microsoft DevTunnel', description: microsoft, run: () => vscode.commands.executeCommand('_signOutOfAccount', { providerId: 'microsoft', accountLabel: microsoft }) },
                ...enabled('aws') ? [this.aws.account === null
                    ? { label: '$(sign-in) Sign In to AWS', description: 'access key', run: () => this.aws.signIn() }
                    : { label: '$(sign-out) Sign Out of AWS', description: this.aws.account, run: () => this.aws.signOut() }] : [],
            ],
        };
    };

    private readonly hosts: Build = () => {
        const merged = SshManager.getInstance().getMergedHosts();
        return {
            title: 'Create New Session',
            placeholder: merged.length ? 'Select a compute host to configure a session on' : 'No compute hosts yet — add one with Add Compute Host.',
            items: merged.sort((a, b) => a.alias.localeCompare(b.alias)).map(h => ({
                label: `$(${HOST_SOURCE_ICON[h.source]}) ${h.alias}`, description: destination(h),
                run: () => this.sessions.startSessionDraft(h.alias),
            })),
        };
    };

    readonly addHost: Build = () => ({
        ...ask('Add Compute Host', `Type an SSH command, e.g. ssh hello@microsoft.com -A${this.clusters.length ? ', or pick a CyberShuttle cluster' : ''}`, '', (command) => {
            const entry = sshCommandToConfig(command);
            return () => ask('Add Compute Host: Alias', 'Press Enter to use this alias, or type your own', entry.Host, alias => this.sshHosts.saveSshHost({ ...entry, Host: alias }));
        }),
        items: this.clusters.map(c => ({ label: `$(${HOST_SOURCE_ICON.cybershuttle}) ${c.clusterName}`, description: c.headnodeHost, open: this.addCluster(c) })),
    });

    private readonly addCluster = ({ slurmClusterId, clusterName }: Cluster): Build => () =>
        ask(`Add ${clusterName}: Login User`, `Your username on ${clusterName}`, '', user => () =>
            ask(`Add ${clusterName}: Work Folder`, 'Where sessions run on the cluster', `/home/${user}/cybershuttle`, (workRoot) => {
                void this.plane.addClusterConfig(slurmClusterId, user, workRoot).then(() => this.sshHosts.refreshSshHosts())
                    .then(() => vscode.window.showInformationMessage(`Added ${clusterName} as a compute host.`)).catch(fail);
            }));

    readonly editHost = (alias: string): Build => () => {
        const host = SshManager.getInstance().getMergedHosts().find(h => h.alias === alias);
        if (!host) { throw new Error(`Compute host ${alias} is no longer configured.`); }
        return ask('Edit Compute Host: Alias', 'Press Enter to keep this alias, or type a new one', alias, newAlias => () =>
            ask('Edit Compute Host: Destination', '[user@]hostname', destination(host), (dest) => {
                const { hostname, username } = parseHostToken(dest);
                this.sshHosts.saveSshHost({ Host: newAlias, HostName: hostname, ...username && { User: username } }, alias);
            }));
    };

    private readonly cloudVm = (regions: string[]): Build => () => ({
        title: 'Create Cloud VM: Region',
        placeholder: 'Select the AWS region to launch in',
        items: regions.map(region => ({ label: region, open: () => ({
            title: 'Create Cloud VM: Instance Type',
            placeholder: 'Select the instance type',
            items: EC2_TYPES.map(type => ({ label: type, open: () => ({
                title: 'Create Cloud VM: Image',
                placeholder: 'Select the image; the VM is added to the Sessions view, where Start launches it',
                items: EC2_IMAGES.map(image => ({ label: image.label, run: () => this.sessions.createCloudVm({ region, type, image: image.ssmParameter, user: image.user }) })),
            }) })),
        }) })),
    });
}

async function signIn(plane: Plane) {
    const token = (await vscode.window.showInputBox({ title: 'CyberShuttle API Token', password: true, ignoreFocusOut: true }))?.trim();
    if (!token) { return; }
    await plane.signIn(token);
    vscode.window.showInformationMessage('Signed in to CyberShuttle.');
}
