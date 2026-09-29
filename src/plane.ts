// The cs-plane client for the `link` transport. CS Bridge still launches the job itself over the user's ssh; cs-plane
// records the session, attaches the run's link and carries Connect. Sign-in is CILogon's device grant, brokered by
// cs-plane because it holds the client secret: the user approves a short code in the browser while this polls cs-plane
// to redeem it.
import type * as vscode from 'vscode';
import { SlurmSession } from './models';
import { parseGpuClass } from './ui/logic/cluster';
import { wallMs } from './modules/sessionMachine';
import { slurmAccount } from './modules/slurmParse';

export const PLANE_URL = 'https://jupyterapi.cybershuttle.org/api/v1';
export const CREDENTIAL_KEY = 'csbridge.plane.credential';

interface DeviceCode { deviceCode: string; userCode: string; verificationUriComplete: string; intervalSeconds: number }
interface Tokens { idToken: string; refreshToken?: string; expiresInSeconds: number }
type DevicePoll = { status: 'pending'; intervalSeconds: number } | { status: 'complete' } & Tokens;
type Credential = Tokens & { expiresAt: number };

export class PlaneError extends Error {
    constructor(public readonly status: number, message: string, public readonly code?: string) { super(message); }
}

export class Plane {
    private credential?: Credential | null;
    private refreshing?: Promise<void>;

    constructor(private readonly secrets: Pick<vscode.SecretStorage, 'get' | 'store' | 'delete'>, private readonly fetchImpl = fetch) { }

    startSignIn() { return this.request('oauth/device', 'POST') as Promise<DeviceCode>; }

    async awaitSignIn(code: DeviceCode, cancelled: () => boolean) {
        for (let wait = code.intervalSeconds; !cancelled();) {
            await new Promise(resolve => setTimeout(resolve, wait * 1000));
            if (cancelled()) { break; }
            const poll = await this.request('oauth/device/poll', 'POST', { deviceCode: code.deviceCode }) as DevicePoll;
            if (poll.status === 'complete') { await this.store(poll); return true; }
            wait = Math.max(poll.intervalSeconds, code.intervalSeconds);
        }
        return false;
    }

    signOut() { return this.save(); }
    async signedIn() { return !!await this.load(); }
    async account() {
        const credential = await this.load();
        return credential && JSON.parse(Buffer.from(credential.idToken.split('.')[1], 'base64url').toString()).email as string | undefined;
    }

    createSession(session: SlurmSession) { return this.api('sessions', 'POST', toSpec(session)) as Promise<{ id: string }>; }
    attachLink(id: string) { return this.api(`sessions/${id}/attach`, 'POST', { tunnelModes: ['link'] }) as Promise<{ port: number; link: { url: string; token: string } }>; }
    stopSession(id: string) { return this.api(`sessions/${id}/stop`, 'POST'); }
    deleteSession(id: string) { return this.api(`sessions/${id}`, 'DELETE'); }
    sessionAccess(id: string) { return this.api(`sessions/${id}/access`) as Promise<{ jupyter: { token: string } }>; }

    private async api(path: string, method = 'GET', body?: unknown) {
        const credential = await this.load();
        if (credential && Date.now() > credential.expiresAt - 60_000) {
            this.refreshing ??= this.refresh(credential).finally(() => { this.refreshing = undefined; });
            await this.refreshing;
        }
        if (!this.credential) { throw new PlaneError(401, 'Sign in to CyberShuttle first (CS Bridge: Open Menu).'); }
        try { return await this.request(path, method, body, this.credential.idToken); }
        catch (err) {
            if (err instanceof PlaneError && err.status === 401) { await this.signOut(); }
            throw err;
        }
    }

    private async refresh(credential: Credential) {
        try {
            const tokens = await this.request('oauth/refresh', 'POST', { refreshToken: credential.refreshToken }) as Tokens;
            await this.store({ ...tokens, refreshToken: tokens.refreshToken ?? credential.refreshToken });
        }
        catch (err) {
            if (!(err instanceof PlaneError && err.status < 500)) { throw err; }
            await this.signOut();
        }
    }

    private store(tokens: Tokens) { return this.save({ ...tokens, expiresAt: Date.now() + tokens.expiresInSeconds * 1000 }); }

    private save(credential?: Credential) {
        this.credential = credential;
        return credential ? this.secrets.store(CREDENTIAL_KEY, JSON.stringify(credential)) : this.secrets.delete(CREDENTIAL_KEY);
    }

    private async load() { return this.credential ??= JSON.parse(await this.secrets.get(CREDENTIAL_KEY) ?? 'null') as Credential | null; }

    private async request(path: string, method: string, body?: unknown, token?: string): Promise<unknown> {
        const headers = { 'Content-Type': 'application/json', ...token && { Authorization: `Bearer ${token}` } };
        const response = await this.fetchImpl(`${PLANE_URL}/${path}`, { method, headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
        const value = await response.json().catch(() => { }) as { error?: { code?: string; message?: string } } | undefined;
        if (!response.ok) { throw new PlaneError(response.status, value?.error?.message ?? `cs-plane returned ${response.status}.`, value?.error?.code); }
        return value;
    }
}

// A session as cs-plane defines it, keyed by its local id so every launch of it maps to one cs-plane session.
function toSpec(session: SlurmSession) {
    const gpu = session.gpuCount > 0 ? parseGpuClass(session.gpuClass) : undefined;
    return {
        idempotencyKey: session.id, alias: session.cluster, account: slurmAccount(session.allocation) || undefined, partition: session.queue,
        rootFolder: session.workingDirectory || '$HOME',
        resources: {
            cores: session.cpus, memoryMb: Math.round(parseFloat(session.memory) * 1024), wallMinutes: Math.round(wallMs(session.wallTime) / 60_000),
            ...gpu && { gpuType: gpu.gpuType.replace(/^gpu:/, '') || 'gpu', gpuCount: Number(gpu.gpuCount) },
        },
    };
}
