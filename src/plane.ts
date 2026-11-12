// The CyberShuttle API client. A CyberShuttle host's run is a BATCH_JOB process the CyberShuttle API submits, reads and
// stops; its Linkspan links back and the API forwards its ports. Sign-in is a pasted CyberShuttle API token, the bearer
// of every call until a 401 signs it out.
import type * as vscode from 'vscode';
import { nonEmpty, SlurmDiscovery, SlurmJobStatus, SlurmSession } from './models';
import { parseJson } from './modules/json';
import { parseGres } from './modules/slurmParse';
import { sleep } from './modules/util';

export const PLANE_URL = 'https://jupyterapi.cybershuttle.org/api/v1';
export const CREDENTIAL_KEY = 'csbridge.plane.credential';
// The CyberShuttle API holds a login open five minutes while the user answers its prompts.
const LOGIN_TIMEOUT = 330_000;

export interface ClusterConfig { slurmClusterConfigId: string; name?: string | null; slurmClusterId: string; slurmCluster?: { clusterName: string; headnodeHost: string; partitions?: Partition[] } | null; loginUser: string; workRoot: string }
interface Partition { name: string; cpuPerNode?: number | null; maxProcessors?: number | null; maxMemory?: number | null; gres?: string | null }
interface DeploymentRecord { deploymentId: string; templateId?: string | null; slurmClusterId?: string | null; defaultBatchJobConfig?: { allocation: string } | null }
export interface Cluster { slurmClusterId: string; clusterName: string; headnodeHost: string }
export interface Deployment { deploymentId: string; label: string; allocation?: string }
interface Login { authId: string; hostName: string; loginUser: string; banner?: string; instruction?: string; prompts: { text: string }[] }
const JOB_STATUS: Record<string, SlurmJobStatus> = {
    CREATED: SlurmJobStatus.QUEUED, SUBMITTED: SlurmJobStatus.QUEUED, RUNNING: SlurmJobStatus.RUNNING,
    COMPLETED: SlurmJobStatus.COMPLETED, FAILED: SlurmJobStatus.FAILED, STOPPED: SlurmJobStatus.CANCELLED,
};

export class PlaneError extends Error {
    constructor(public readonly status: number, message: string) { super(message); }
}

export class Plane {
    private credential?: string | null;

    constructor(private readonly secrets: Pick<vscode.SecretStorage, 'get' | 'store' | 'delete'>, private readonly fetchImpl = fetch) { }

    async signIn(token: string) {
        await this.request('processes/me', 'GET', undefined, token);
        await this.save(token);
    }

    signOut() { return this.save(); }
    async signedIn() { return !!await this.load(); }

    createProcess({ clusterConfigId, account, partition, resources: { cores, memoryMb, gpuCount } }: SlurmSession, wallMinutes: number, deployment: Deployment) {
        const batchProcess = { deploymentId: deployment.deploymentId, slurmClusterConfigId: clusterConfigId,
            batchJobConfig: { wallTimeMinutes: wallMinutes, allocation: account || deployment.allocation, partition, nodes: 1, cpus: cores, mem: `${memoryMb}M`, gpus: gpuCount || undefined } };
        return this.api<{ processId: string }>('processes', 'POST', { processType: 'BATCH_JOB', batchProcess });
    }

    launchProcess(id: string) { return this.api(`processes/${id}/launch`, 'POST'); }
    stopProcess(id: string) { return this.api(`processes/${id}/stop`, 'POST', undefined, LOGIN_TIMEOUT); }
    jupyterServer(id: string) { return this.api<{ linked: boolean; token: string }>(`processes/${id}/jupyter-server`); }

    async jobStatus(id: string): Promise<{ status: SlurmJobStatus; elapsedSeconds: number }> {
        const lastStatus = (await this.api<{ status?: string | null; timestamp?: number | null }[]>(`processes/${id}/statuses`)).at(-1);
        return { status: JOB_STATUS[String(lastStatus?.status)] ?? SlurmJobStatus.UNKNOWN, elapsedSeconds: Math.max(0, (Date.now() - (lastStatus?.timestamp ?? Date.now())) / 1000) };
    }

    async clusterConfigs(): Promise<ClusterConfig[]> {
        if (!await this.signedIn()) { return []; }
        return (await Promise.all([this.api<ClusterConfig[]>('slurm-cluster-configs/me'), this.api<ClusterConfig[]>('slurm-cluster-configs/shared-with-me')])).flat();
    }

    clusters() { return this.api<Cluster[]>('slurm-clusters'); }

    // The CyberShuttle API wants a credential on every config; a prompt-only one stands for none, as in cs-jupyter.
    async addClusterConfig(slurmClusterId: string, loginUser: string, workRoot: string) {
        const held = (await this.api<{ sshCredentialId: string; fullInteractive?: boolean }[]>('ssh-credentials')).find(c => c.fullInteractive)
            ?? await this.api<{ sshCredentialId: string }>('ssh-credentials', 'POST', { sshCredentialName: 'Ask at each login', fullInteractive: true });
        await this.api('slurm-cluster-configs', 'POST', { slurmClusterId, loginUser, workRoot, sshCredentialId: held.sshCredentialId });
    }

    async discovery(id: string): Promise<SlurmDiscovery> {
        const [{ workRoot, slurmCluster }, { allocations }] = await Promise.all([this.api<ClusterConfig>(`slurm-cluster-configs/${id}`),
            this.api<{ allocations: { account: string }[] }>(`slurm-cluster-configs/${id}/discover-allocations`, 'POST', undefined, LOGIN_TIMEOUT)]);
        const partitions = slurmCluster?.partitions ?? [];
        if (!nonEmpty(partitions)) { throw new Error('CyberShuttle lists no partitions on this cluster; ask an administrator.'); }
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
        return found.sort((a, b) => Number(b.label === 'Base') - Number(a.label === 'Base'));
    }

    answerLogins(askLogin: (host: string, prompt: string) => Promise<string | undefined>): { dispose(): void } {
        let live = true;
        void (async () => {
            while (await sleep(2000), live) {
                try {
                    if (!await this.signedIn()) { continue; }
                    const [login] = await this.api<Login[]>('ssh-interactive-auths');
                    if (!login) { continue; }
                    const responses: string[] = [];
                    for (const { text } of login.prompts) {
                        const answer = await askLogin(`${login.loginUser}@${login.hostName}`, [login.banner, login.instruction, text].filter(Boolean).join('\n'));
                        if (answer === undefined) { break; }
                        responses.push(answer);
                    }
                    await this.api(`ssh-interactive-auths/${login.authId}/response`, 'POST', responses.length === login.prompts.length ? { responses } : { cancel: true });
                }
                catch { /* the next poll retries */ }
            }
        })();
        return { dispose: () => { live = false; } };
    }

    private async api<T = unknown>(path: string, method = 'GET', body?: unknown, timeout?: number): Promise<T> {
        const token = await this.load();
        if (!token) { throw new PlaneError(401, 'Sign in to CyberShuttle first (CS Bridge: Open Menu).'); }
        try { return await this.request<T>(path, method, body, token, timeout); }
        catch (err) {
            if (err instanceof PlaneError && err.status === 401) { await this.signOut(); }
            throw err;
        }
    }

    private save(token?: string) {
        this.credential = token;
        return token ? this.secrets.store(CREDENTIAL_KEY, token) : this.secrets.delete(CREDENTIAL_KEY);
    }

    private async load() { return this.credential ??= await this.secrets.get(CREDENTIAL_KEY) ?? null; }

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
