// AWS sign-in kept in VS Code's secret storage and restored on activation. The signed-in Ec2 client is what
// Ec2Backend drives sessions with; sign-in also announces itself so instances launched elsewhere can be adopted.
import * as vscode from 'vscode';
import { EC2Client } from '@aws-sdk/client-ec2';
import { Ec2 } from './ec2';
import { sshKeyPath } from './sshSupport';
import { errMsg } from '@/logger';

const CREDENTIALS_KEY = 'aws.credentials';
type Credentials = { accessKeyId: string; secretAccessKey: string; sessionToken?: string };

export class AwsClient implements vscode.Disposable {
    private readonly signedIn = new vscode.EventEmitter<void>();
    readonly onDidSignIn = this.signedIn.event;
    private session?: { ec2: Ec2; regions: string[]; accessKeyId: string };

    constructor(private readonly secrets: vscode.SecretStorage) { }

    get regions(): string[] | undefined { return this.session?.regions; }
    get account(): string | null { return this.session?.accessKeyId ?? null; }
    get ec2(): Ec2 | undefined { return this.session?.ec2; }

    requireEc2(): Ec2 {
        if (!this.session) { throw new Error('Sign in to AWS first.'); }
        return this.session.ec2;
    }

    dispose(): void { this.signedIn.dispose(); }

    async signIn(): Promise<void> {
        const ask = (title: string, password = false) => vscode.window.showInputBox({ title, password, ignoreFocusOut: true }).then(v => v?.trim());
        const accessKeyId = await ask('AWS Access Key ID');
        const secretAccessKey = accessKeyId && await ask('AWS Secret Access Key', true);
        const sessionToken = secretAccessKey && await ask('AWS Session Token (blank for a long-term key)', true);
        if (!accessKeyId || !secretAccessKey || sessionToken === undefined) { return; }
        if (await this.connect({ accessKeyId, secretAccessKey, sessionToken: sessionToken || undefined })) {
            void vscode.window.showInformationMessage('Signed in to AWS.');
        }
    }

    // Signs back in with the stored key; a key that no longer works is dropped so the menu offers Sign In again.
    async restore(): Promise<void> {
        const stored = await this.secrets.get(CREDENTIALS_KEY);
        if (stored) { await this.connect(JSON.parse(stored) as Credentials); }
    }

    private async connect(credentials: Credentials): Promise<boolean> {
        const clients = new Map<string, EC2Client>();
        const client = (region: string) => {
            let c = clients.get(region);
            if (!c) { clients.set(region, c = new EC2Client({ region, credentials, requestHandler: { connectionTimeout: 5_000, requestTimeout: 15_000 } })); }
            return c;
        };
        const ec2 = new Ec2(client, sshKeyPath);
        try { this.session = { ec2, regions: await ec2.regions(), accessKeyId: credentials.accessKeyId }; }
        catch (err) {
            void vscode.window.showErrorMessage(`AWS sign-in failed: ${errMsg(err)}`);
            await this.secrets.delete(CREDENTIALS_KEY);
            return false;
        }
        await this.secrets.store(CREDENTIALS_KEY, JSON.stringify(credentials));
        this.signedIn.fire();
        return true;
    }

    async signOut(): Promise<void> {
        this.session = undefined;
        await this.secrets.delete(CREDENTIALS_KEY);
    }
}
