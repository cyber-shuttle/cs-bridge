// CS Bridge's one menu: a QuickPick walking a stack of pages, where package.json binds Escape to Back while
// csbridge.menuNested holds. Pages render from cached account state refreshed behind them, so the menu opens at once.
// Dev Tunnels sign-out is VS Code's account action, which signs the account out of VS Code as a whole.
import * as vscode from 'vscode';
import { Logger, errMsg } from './logger';
import { Plane } from './plane';
import { SlurmSession } from './models';
import { SessionProvider } from './sessionProvider';
import { SshHostProvider } from './sshHostProvider';
import { SshManager } from './modules/sshSupport';
import { Transports } from './modules/transport';
import { getMicrosoftAccountLabel, switchDevTunnelAccount } from './modules/tunnelSupport';
import { enabled } from './features';
import { sshCommandToConfig } from './modules/sshCommandParser';

type Page = { title: string; placeholder?: string; value?: string; items?: Item[]; submit?: (value: string) => Build | void };
type Build = () => Page;
type Item = vscode.QuickPickItem & { run?: () => unknown; open?: Build };

const fail = (err: unknown) => void vscode.window.showErrorMessage(`CS Bridge: ${errMsg(err)}`);
const nested = (value: boolean) => void vscode.commands.executeCommand('setContext', 'csbridge.menuNested', value);

export class CsBridgeMenu {
    private email?: string | null = null;
    private microsoft: string | null = null;

    constructor(
        private readonly plane: Plane, private readonly sessions: SessionProvider,
        private readonly sshHosts: SshHostProvider, private readonly transports: Transports,
    ) { void this.refreshAccounts(); }

    open(start: Build = this.root): void {
        const pick = vscode.window.createQuickPick<Item>();
        const stack: Build[] = [];
        let page: Page;
        const render = () => {
            page = stack.at(-1)!();
            Object.assign(pick, {
                title: page.title, placeholder: page.placeholder, items: page.items ?? [], ignoreFocusOut: !!page.submit,
                buttons: stack.length > 1 ? [vscode.QuickInputButtons.Back] : [],
            });
            nested(stack.length > 1);
        };
        const show = () => { render(); pick.value = page.value ?? ''; };
        const go = (build: Build) => { stack.push(build); show(); };
        pick.onDidTriggerButton(() => { stack.pop(); show(); });
        pick.onDidAccept(() => {
            if (page.submit) {
                const value = pick.value.trim();
                if (!value) { return; }
                try { const next = page.submit(value); if (next) { go(next); return; } pick.hide(); }
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
        void this.refreshAccounts().then(() => { if (stack.at(-1) === this.root) { render(); } });
    }

    private async refreshAccounts() {
        try { [this.email, this.microsoft] = await Promise.all([this.plane.identity(), getMicrosoftAccountLabel()]); }
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
                ...cybershuttle ? [{ label: '$(arrow-swap) Default Transport', description: this.of(this.current()).label, open: this.transport }] : [],
                { label: 'Accounts', kind: vscode.QuickPickItemKind.Separator },
                ...cybershuttle ? [email === null
                    ? { label: '$(sign-in) Sign In to CyberShuttle', run: () => signIn(this.plane) }
                    : { label: '$(sign-out) Sign Out of CyberShuttle', description: email, run: () => this.plane.signOut() }] : [],
                microsoft === null
                    ? { label: '$(sign-in) Sign In to Microsoft DevTunnel', run: switchDevTunnelAccount }
                    : { label: '$(sign-out) Sign Out of Microsoft DevTunnel', description: microsoft, run: () => vscode.commands.executeCommand('_signOutOfAccount', { providerId: 'microsoft', accountLabel: microsoft }) },
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

    readonly addHost: Build = () => ({
        title: 'Add SSH Host',
        placeholder: 'SSH connection command, e.g. ssh hello@microsoft.com -A',
        submit: (command) => {
            const entry = sshCommandToConfig(command);
            return () => ({
                title: 'Add SSH Host: Alias', value: entry.Host, placeholder: 'Press Enter to use this alias, or type your own',
                submit: alias => this.sshHosts.saveSshHost({ ...entry, Host: alias }),
            });
        },
    });

    readonly editHost = (alias: string): Build => () => {
        const host = SshManager.getInstance().getMergedHosts().find(h => h.alias === alias)!;
        return {
            title: 'Edit SSH Host: Alias', value: alias, placeholder: 'Press Enter to keep this alias, or type a new one',
            submit: newAlias => () => ({
                title: 'Edit SSH Host: Destination', value: [host.user, host.hostname].filter(Boolean).join('@'),
                placeholder: '[user@]hostname',
                submit: (destination) => {
                    const [HostName, User] = destination.split('@').reverse();
                    this.sshHosts.saveSshHost({ Host: newAlias, HostName, ...User && { User } }, alias);
                },
            }),
        };
    };

    private readonly transport: Build = () => ({
        title: 'Default Transport',
        items: (['devtunnel', 'link'] as const).map(name => ({
            label: `${name === this.current() ? '$(check)' : '$(blank)'} ${this.of(name).label}`,
            description: this.of(name).description,
            run: () => vscode.workspace.getConfiguration('csbridge').update('transport', name, vscode.ConfigurationTarget.Global),
        })),
    });

    private of(transport: SlurmSession['transport']) { return this.transports.transportFor({ transport }); }
    private current() { return vscode.workspace.getConfiguration('csbridge').get<SlurmSession['transport']>('transport', 'devtunnel'); }
}

async function signIn(plane: Plane) {
    const code = await plane.startSignIn();
    await vscode.env.openExternal(vscode.Uri.parse(code.verificationUriComplete));
    if (await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Waiting for CyberShuttle sign-in with code ${code.userCode}`, cancellable: true },
        (_progress, token) => plane.awaitSignIn(code, () => token.isCancellationRequested),
    )) { vscode.window.showInformationMessage('Signed in to CyberShuttle.'); }
}
