// CS Bridge's one menu: a QuickPick walking a stack of pages, where package.json binds Escape to Back while
// csbridge.menuNested holds. Pages render from cached account state refreshed behind them, so the menu opens at once.
// Dev Tunnels sign-out is VS Code's account action, which signs the account out of VS Code as a whole.
import * as vscode from 'vscode';
import { Logger, errMsg } from './logger';
import { Plane } from './plane';
import { SlurmSession, EC2_IMAGES, EC2_TYPES } from './models';
import { SessionProvider } from './sessionProvider';
import { AwsClient } from './modules/aws';
import { SshHostProvider } from './sshHostProvider';
import { SshManager } from './modules/sshSupport';
import { Transports } from './modules/transport';
import { getMicrosoftAccountLabel, switchDevTunnelAccount } from './modules/tunnelSupport';
import { configuredTransport, enabled } from './features';
import { sshCommandToConfig } from './modules/sshCommandParser';

type Page = { title: string; placeholder?: string; items: Item[]; input?: { value: string; submit: (value: string) => Build | void } };
type Build = () => Page;
type Item = vscode.QuickPickItem & { run?: () => unknown; open?: Build };
const ask = (title: string, placeholder: string, value: string, submit: (value: string) => Build | void): Page => ({ title, placeholder, items: [], input: { value, submit } });

const fail = (err: unknown) => void vscode.window.showErrorMessage(`CS Bridge: ${errMsg(err)}`);
const nested = (value: boolean) => void vscode.commands.executeCommand('setContext', 'csbridge.menuNested', value);

export class CsBridgeMenu {
    private email: string | null = null;
    private microsoft: string | null = null;

    constructor(
        private readonly plane: Plane, private readonly sessions: SessionProvider,
        private readonly sshHosts: SshHostProvider, private readonly transports: Transports, private readonly aws: AwsClient,
    ) { void this.refreshAccounts(); }

    open(start: Build = this.root): void {
        const pick = vscode.window.createQuickPick<Item>();
        const stack: Build[] = [];
        let page: Page;
        const render = (build: Build) => {
            page = build();
            Object.assign(pick, {
                title: page.title, placeholder: page.placeholder, items: page.items, ignoreFocusOut: !!page.input,
                buttons: stack.length > 1 ? [vscode.QuickInputButtons.Back] : [],
            });
            nested(stack.length > 1);
        };
        const show = (build: Build) => { render(build); pick.value = page.input ? page.input.value : ''; };
        const go = (build: Build) => { stack.push(build); show(build); };
        pick.onDidTriggerButton(() => { stack.pop(); const top = stack.at(-1); if (top) { show(top); } });
        pick.onDidAccept(() => {
            if (page.input) {
                const value = pick.value.trim();
                if (!value) { return; }
                try { const next = page.input.submit(value); if (next) { go(next); return; } pick.hide(); }
                catch (err) { fail(err); }
                return;
            }
            const item = pick.selectedItems[0];
            if (item?.open) { go(item.open); return; }
            pick.hide();
            (async () => item?.run?.())().catch(fail).finally(() => this.refreshAccounts());
        });
        pick.onDidHide(() => { stack.length = 0; nested(false); pick.dispose(); });
        go(start);
        pick.show();
        void this.refreshAccounts().then(() => { if (stack.at(-1) === this.root) { render(this.root); } });
    }

    private async refreshAccounts() {
        try { [this.email, this.microsoft] = await Promise.all([this.plane.identity(), getMicrosoftAccountLabel(), enabled('aws') && this.aws.restored]); }
        catch (err) { Logger.getInstance().warn(`Menu account refresh failed: ${errMsg(err)}`); }
    }

    private readonly root: Build = () => {
        const { email, microsoft } = this;
        const cybershuttle = enabled('cybershuttle');
        return {
            title: 'CS Bridge',
            items: [
                { label: '$(add) Create New SSH Session', open: this.hosts },
                { label: '$(server) Add SSH Host', open: this.addHost },
                ...enabled('aws') && this.aws.regions ? [{ label: '$(cloud) Create Cloud VM', open: this.cloudVm(this.aws.regions) }] : [],
                ...cybershuttle ? [{ label: '$(arrow-swap) Default Transport', description: this.of(this.current()).label, open: this.transport }] : [],
                { label: 'Accounts', kind: vscode.QuickPickItemKind.Separator },
                ...cybershuttle ? [email === null
                    ? { label: '$(sign-in) Sign In to CyberShuttle', run: () => signIn(this.plane) }
                    : { label: '$(sign-out) Sign Out of CyberShuttle', description: email, run: () => this.plane.signOut() }] : [],
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
            title: 'Create New SSH Session',
            placeholder: merged.length ? 'Select an SSH host to configure a session on' : 'No SSH hosts configured yet — add one with Add SSH Host.',
            items: merged.map(h => ({
                label: h.alias, description: h.hostname && `${h.user ? h.user + '@' : ''}${h.hostname}`,
                run: () => this.sessions.startSessionDraft(h.alias),
            })),
        };
    };

    readonly addHost: Build = () => ask('Add SSH Host', 'SSH connection command, e.g. ssh hello@microsoft.com -A', '', (command) => {
        const entry = sshCommandToConfig(command);
        return () => ask('Add SSH Host: Alias', 'Press Enter to use this alias, or type your own', entry.Host, alias => this.sshHosts.saveSshHost({ ...entry, Host: alias }));
    });

    readonly editHost = (alias: string): Build => () => {
        const host = SshManager.getInstance().getMergedHosts().find(h => h.alias === alias);
        if (!host) { throw new Error(`SSH host ${alias} is no longer configured.`); }
        return ask('Edit SSH Host: Alias', 'Press Enter to keep this alias, or type a new one', alias, newAlias => () =>
            ask('Edit SSH Host: Destination', '[user@]hostname', [host.user, host.hostname].filter(Boolean).join('@'), (destination) => {
                const [HostName = '', User] = destination.split('@').reverse();
                this.sshHosts.saveSshHost({ Host: newAlias, HostName, ...User && { User } }, alias);
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

    private readonly transport: Build = () => ({
        title: 'Default Transport',
        items: (['devtunnel', 'link'] as const).map(name => ({
            label: `${name === this.current() ? '$(check)' : '$(blank)'} ${this.of(name).label}`,
            description: this.of(name).description,
            run: () => vscode.workspace.getConfiguration('csbridge').update('transport', name, vscode.ConfigurationTarget.Global),
        })),
    });

    private of(transport: SlurmSession['transport']) { return this.transports.transportFor({ transport }); }
    private current() { return configuredTransport(); }
}

async function signIn(plane: Plane) {
    const code = await plane.startSignIn();
    await vscode.env.openExternal(vscode.Uri.parse(code.verificationUriComplete));
    if (await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Waiting for CyberShuttle sign-in with code ${code.userCode}`, cancellable: true },
        (_progress, token) => plane.awaitSignIn(code, () => token.isCancellationRequested),
    )) { vscode.window.showInformationMessage('Signed in to CyberShuttle.'); }
}
