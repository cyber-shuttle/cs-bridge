// AWS sign-in kept in VS Code's secret storage and restored on activation. The signed-in Ec2 client is what
// Ec2Backend drives sessions with; sign-in also announces itself so instances launched elsewhere can be adopted.
import * as vscode from 'vscode';
import { EC2Client } from '@aws-sdk/client-ec2';
import { Ec2 } from './ec2';
import { sshKeyPath } from './sshSupport';
import { parseJson } from './json';
import { getOrSet } from './util';
import { errMsg } from '@/logger';

const CREDENTIALS_KEY = 'aws.credentials';
type Credentials = { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
// The errors AWS answers a bad key with; anything else, such as no network, is not the key's fault.
const REFUSED_KEY = /^(AuthFailure|UnrecognizedClientException|InvalidClientTokenId|ExpiredToken|SignatureDoesNotMatch)$/;

export class AwsClient implements vscode.Disposable {
    private readonly signedIn = new vscode.EventEmitter<void>();
    readonly onDidSignIn = this.signedIn.event;
    private session?: { ec2: Ec2; regions: string[]; accessKeyId: string };

    // Signs back in with the stored key; a key AWS refuses is dropped so the menu offers Sign In again.
    readonly restored: Promise<void>;

    constructor(private readonly secrets: vscode.SecretStorage) {
        this.restored = this.restore().catch(err => void vscode.window.showWarningMessage(`AWS sign-in was not restored: ${errMsg(err)}`));
    }

    private async restore(): Promise<void> {
        const stored = await this.secrets.get(CREDENTIALS_KEY);
        if (stored) { await this.connect(parseJson<Credentials>(stored)); }
    }

    get regions(): string[] | undefined { return this.session?.regions; }
    get account(): string | null { return this.session?.accessKeyId ?? null; }
    get ec2(): Ec2 | undefined { return this.session?.ec2; }

    async ready(): Promise<{ ec2: Ec2; regions: string[] }> {
        await this.restored;
        if (!this.session) { throw new Error('Sign in to AWS first.'); }
        return this.session;
    }

    dispose(): void { this.signedIn.dispose(); }

    async signIn(): Promise<void> {
        await this.restored;
        const ask = (title: string, password = false) => vscode.window.showInputBox({ title, password, ignoreFocusOut: true }).then(v => v?.trim());
        const accessKeyId = await ask('AWS Access Key ID');
        const secretAccessKey = accessKeyId && await ask('AWS Secret Access Key', true);
        const sessionToken = secretAccessKey && await ask('AWS Session Token (blank for a long-term key)', true);
        if (!accessKeyId || !secretAccessKey || sessionToken === undefined) { return; }
        if (await this.connect({ accessKeyId, secretAccessKey, sessionToken: sessionToken || undefined })) {
            void vscode.window.showInformationMessage('Signed in to AWS.');
        }
    }

    private async connect(credentials: Credentials): Promise<boolean> {
        const clients = new Map<string, EC2Client>();
        const client = (region: string) => getOrSet(clients, region, () => new EC2Client({ region, credentials, requestHandler: { connectionTimeout: 5_000, requestTimeout: 15_000 } }));
        const ec2 = new Ec2(client, sshKeyPath, vscode.env.machineId);
        try { this.session = { ec2, regions: await ec2.regions(), accessKeyId: credentials.accessKeyId }; }
        catch (err) {
            void vscode.window.showErrorMessage(`AWS sign-in failed: ${errMsg(err)}`);
            if (err instanceof Error && REFUSED_KEY.test(err.name)) { await this.secrets.delete(CREDENTIALS_KEY); }
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
