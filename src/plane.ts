// The CyberShuttle API client. A CyberShuttle host's run is a BATCH_JOB process the CyberShuttle API submits, reads and
// stops; its Linkspan links back and the API forwards its ports. Sign-in is CILogon's device grant, brokered by the
// CyberShuttle API because it holds the client secret: the user approves a short code in the browser while this polls
// to redeem it; the ID token answered is the bearer.
import type * as vscode from 'vscode';
import { NonEmpty, SlurmDiscovery, SlurmJobStatus, SlurmSession } from './models';
import { parseJson } from './modules/json';
import { parseGres } from './modules/slurmParse';
import { sleep } from './modules/util';

export const PLANE_URL = 'https://jupyterapi.cybershuttle.org/api/v1';
export const CREDENTIAL_KEY = 'csbridge.plane.credential';

interface DeviceCode { device_code: string; user_code: string; verification_uri_complete: string; interval: number }
interface Tokens { id_token: string; refresh_token?: string; expires_in: number }
interface Credential { idToken: string; refreshToken?: string; expiresAt: number }
export interface ClusterConfig { slurmClusterConfigId: string; name?: string | null; slurmClusterId: string; slurmCluster?: { clusterName: string; headnodeHost: string } | null; loginUser: string; workRoot: string }
interface Partition { name: string; cpuPerNode?: number | null; maxProcessors?: number | null; maxMemory?: number | null; gres?: string | null }
interface DeploymentRecord { deploymentId: string; templateId?: string | null; slurmClusterId?: string | null; defaultBatchJobConfig?: { allocation: string } | null }
export interface Deployment { deploymentId: string; label: string; allocation?: string }
interface Login { authId: string; hostName: string; loginUser: string; banner?: string; instruction?: string; prompts: { text: string }[] }
const JOB_STATUS: Record<string, SlurmJobStatus> = {
    CREATED: SlurmJobStatus.QUEUED, SUBMITTED: SlurmJobStatus.QUEUED, RUNNING: SlurmJobStatus.RUNNING, READY: SlurmJobStatus.RUNNING,
    COMPLETED: SlurmJobStatus.COMPLETED, FAILED: SlurmJobStatus.FAILED, CANCELLED: SlurmJobStatus.CANCELLED,
};

export class PlaneError extends Error {
    constructor(public readonly status: number, message: string) { super(message); }
}

export class Plane {
    private credential?: Credential | null;
    private refreshing?: Promise<void>;

    constructor(private readonly secrets: Pick<vscode.SecretStorage, 'get' | 'store' | 'delete'>, private readonly fetchImpl = fetch,
        private readonly askLogin: (host: string, prompt: string) => Promise<string | undefined> = async () => undefined) { }

    startSignIn() { return this.request<DeviceCode>('auth/device', 'POST'); }

    async awaitSignIn(code: DeviceCode, cancelled: () => boolean) {
        while (!cancelled()) {
            await sleep(code.interval * 1000);
            if (cancelled()) { break; }
            const poll = await this.request<Tokens | { status: 202 }>('auth/token', 'POST', { device_code: code.device_code }); // 202, in the error shape, until approved
            if (!('status' in poll)) { await this.store(poll); return true; }
        }
        return false;
    }

    signOut() { return this.save(); }
    async signedIn() { return !!await this.load(); }
    // The signed-in user's email from the id token, or null when signed out.
    async identity(): Promise<string | null> {
        const credential = await this.load();
        if (!credential) { return null; }
        const payload = credential.idToken.split('.')[1];
        if (!payload) { throw new Error('The CyberShuttle id token is malformed.'); }
        const { email = '' } = parseJson<{ email?: string }>(Buffer.from(payload, 'base64url').toString());
        return email;
    }

    createProcess({ clusterConfigId, account, partition, resources: { cores, memoryMb, gpuCount } }: SlurmSession, wallMinutes: number, deployment: Deployment) {
        const batchProcess = { deploymentId: deployment.deploymentId, slurmClusterConfigId: clusterConfigId,
            batchJobConfig: { wallTimeMinutes: wallMinutes, allocation: account || deployment.allocation, partition, nodes: 1, cpus: cores, mem: `${memoryMb}M`, gpus: gpuCount || undefined } };
        return this.api<{ processId: string; batchProcess: { controlPort: number } }>('processes', 'POST', { processType: 'BATCH_JOB', batchProcess });
    }

    launchProcess(id: string) { return this.loggingIn(`processes/${id}/launch`); }
    stopProcess(id: string) { return this.loggingIn(`processes/${id}/stop`); }
    processAccess(id: string) { return this.api<{ app: { token: string } }>(`processes/${id}/access`); }

    async jobStatus(id: string): Promise<{ status: SlurmJobStatus; elapsedSeconds: number }> {
        const { lastStatus } = await this.api<{ lastStatus?: { status?: string | null; timestamp?: number | null } | null }>(`processes/${id}`);
        return { status: JOB_STATUS[String(lastStatus?.status)] ?? SlurmJobStatus.UNKNOWN, elapsedSeconds: Math.max(0, (Date.now() - (lastStatus?.timestamp ?? Date.now())) / 1000) };
    }

    async clusterConfigs(): Promise<ClusterConfig[]> {
        if (!await this.signedIn()) { return []; }
        return (await Promise.all([this.api<ClusterConfig[]>('slurm-cluster-configs/me'), this.api<ClusterConfig[]>('slurm-cluster-configs/shared-with-me')])).flat();
    }

    async discovery(id: string): Promise<SlurmDiscovery> {
        const [{ workRoot }, { allocations, partitions }] = await Promise.all([this.api<ClusterConfig>(`slurm-cluster-configs/${id}`),
            this.loggingIn<{ allocations: { account: string }[]; partitions: NonEmpty<Partition> }>(`slurm-cluster-configs/${id}/discover-allocations`)]);
        const info = (p: Partition) => ({ name: p.name, cpuCount: p.cpuPerNode ?? p.maxProcessors ?? 0, memoryMb: p.maxMemory ?? 0, gres: parseGres(p.gres ?? '') });
        const [first, ...rest] = partitions;
        return { accounts: allocations.map(a => a.account), partitions: [info(first), ...rest.map(info)], homeDir: workRoot };
    }

    async deployments(clusterConfigId: string): Promise<Deployment[]> {
        const [{ slurmClusterId }, deployments, templates] = await Promise.all([this.api<ClusterConfig>(`slurm-cluster-configs/${clusterConfigId}`),
            this.api<DeploymentRecord[]>('slurm-deployments'), this.api<{ templateId: string; templateName: string }[]>('application-templates')]);
        const found = deployments.filter(d => d.slurmClusterId === slurmClusterId).map(d => ({ deploymentId: d.deploymentId,
            allocation: d.defaultBatchJobConfig?.allocation, label: templates.find(t => t.templateId === d.templateId)?.templateName ?? d.deploymentId }));
        if (!found.length) { throw new Error('CyberShuttle has no deployment on this cluster; ask an administrator.'); }
        return found;
    }

    // The CyberShuttle API holds a login open five minutes while the user answers its prompts.
    private async loggingIn<T = unknown>(path: string): Promise<T> {
        let done = false;
        void (async () => {
            while (await sleep(1000), !done) {
                try {
                    const [login] = await this.api<Login[]>('ssh-interactive-auths');
                    if (!login) { continue; }
                    const responses: string[] = [];
                    for (const { text } of login.prompts) {
                        const answer = await this.askLogin(`${login.loginUser}@${login.hostName}`, [login.banner, login.instruction, text].filter(Boolean).join('\n'));
                        if (answer === undefined) { break; }
                        responses.push(answer);
                    }
                    await this.api(`ssh-interactive-auths/${login.authId}/response`, 'POST', responses.length === login.prompts.length ? { responses } : { cancel: true });
                }
                catch { /* the next poll retries */ }
            }
        })();
        try { return await this.api<T>(path, 'POST', undefined, 330_000); }
        finally { done = true; }
    }

    private async api<T = unknown>(path: string, method = 'GET', body?: unknown, timeout?: number): Promise<T> {
        const credential = await this.load();
        if (credential && Date.now() > credential.expiresAt - 60_000) {
            this.refreshing ??= this.refresh(credential).finally(() => { this.refreshing = undefined; });
            await this.refreshing;
        }
        if (!this.credential) { throw new PlaneError(401, 'Sign in to CyberShuttle first (CS Bridge: Open Menu).'); }
        try { return await this.request<T>(path, method, body, this.credential.idToken, timeout); }
        catch (err) {
            if (err instanceof PlaneError && err.status === 401) { await this.signOut(); }
            throw err;
        }
    }

    private async refresh(credential: Credential) {
        try {
            const tokens = await this.request<Tokens>('auth/token', 'POST', { refresh_token: credential.refreshToken });
            await this.store({ ...tokens, refresh_token: tokens.refresh_token ?? credential.refreshToken });
        }
        catch (err) {
            if (!(err instanceof PlaneError && err.status < 500)) { throw err; }
            await this.signOut();
        }
    }

    private store(tokens: Tokens) { return this.save({ idToken: tokens.id_token, refreshToken: tokens.refresh_token, expiresAt: Date.now() + tokens.expires_in * 1000 }); }

    private save(credential?: Credential) {
        this.credential = credential;
        return credential ? this.secrets.store(CREDENTIAL_KEY, JSON.stringify(credential)) : this.secrets.delete(CREDENTIAL_KEY);
    }

    private async load() {
        const stored = await this.secrets.get(CREDENTIAL_KEY);
        return this.credential ??= stored ? parseJson<Credential>(stored) : null;
    }

    // T is the server's documented response shape; the body is trusted as such, as every wire client here does.
    private async request<T>(path: string, method: string, body?: unknown, token?: string, timeout = 30_000): Promise<T> {
        const headers = { 'Content-Type': 'application/json', ...token && { Authorization: `Bearer ${token}` } };
        const response = await this.fetchImpl(`${PLANE_URL}/${path}`, { method, headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
        let value: (T & { message?: string; fieldErrors?: { message: string }[] }) | undefined;
        try { value = parseJson((await response.text()) || 'null'); } // 204 carries no body
        catch { /* an error page from a proxy */ }
        if (!response.ok || value === undefined) { throw new PlaneError(response.status, value?.fieldErrors?.map(f => f.message).join(' ') || value?.message || `The server returned ${response.status}.`); }
        return value;
    }
}
