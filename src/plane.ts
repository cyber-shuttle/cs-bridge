// The cs-plane client for the `link` transport. CS Bridge still launches the job itself over the user's ssh; cs-plane
// records the session, attaches the run's link and carries Connect. Sign-in is CILogon's device grant, brokered by
// cs-plane because it holds the client secret: the user approves a short code in the browser while this polls cs-plane
// to redeem it.
import type * as vscode from 'vscode';
import { SlurmSession } from './models';

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

    startSignIn() { return this.request<DeviceCode>('oauth/device', 'POST'); }

    async awaitSignIn(code: DeviceCode, cancelled: () => boolean) {
        for (let wait = code.intervalSeconds; !cancelled();) {
            await new Promise(resolve => setTimeout(resolve, wait * 1000));
            if (cancelled()) { break; }
            const poll = await this.request<DevicePoll>('oauth/device/poll', 'POST', { deviceCode: code.deviceCode });
            if (poll.status === 'complete') { await this.store(poll); return true; }
            wait = Math.max(poll.intervalSeconds, code.intervalSeconds);
        }
        return false;
    }

    signOut() { return this.save(); }
    async signedIn() { return !!await this.load(); }
    // The signed-in user's email from the id token, or null when signed out.
    async identity(): Promise<string | null> {
        const credential = await this.load();
        return credential ? (JSON.parse(Buffer.from(credential.idToken.split('.')[1] ?? '', 'base64url').toString()) as { email?: string }).email ?? '' : null;
    }

    createSession(session: SlurmSession) { return this.api<{ id: string }>('sessions', 'POST', toSpec(session)); }
    attachLink(id: string) { return this.api<{ port: number; link: { url: string; token: string } }>(`sessions/${id}/attach`, 'POST', { tunnelModes: ['link'] }); }
    stopSession(id: string) { return this.api(`sessions/${id}/stop`, 'POST'); }
    deleteSession(id: string) { return this.api(`sessions/${id}`, 'DELETE'); }
    sessionAccess(id: string) { return this.api<{ jupyter: { token: string } }>(`sessions/${id}/access`); }

    private async api<T = unknown>(path: string, method = 'GET', body?: unknown): Promise<T> {
        const credential = await this.load();
        if (credential && Date.now() > credential.expiresAt - 60_000) {
            this.refreshing ??= this.refresh(credential).finally(() => { this.refreshing = undefined; });
            await this.refreshing;
        }
        if (!this.credential) { throw new PlaneError(401, 'Sign in to CyberShuttle first (CS Bridge: Open Menu).'); }
        try { return await this.request<T>(path, method, body, this.credential.idToken); }
        catch (err) {
            if (err instanceof PlaneError && err.status === 401) { await this.signOut(); }
            throw err;
        }
    }

    private async refresh(credential: Credential) {
        try {
            const tokens = await this.request<Tokens>('oauth/refresh', 'POST', { refreshToken: credential.refreshToken });
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

    // T is cs-plane's documented response shape; the body is trusted as such, as every wire client here does.
    private async request<T>(path: string, method: string, body?: unknown, token?: string): Promise<T> {
        const headers = { 'Content-Type': 'application/json', ...token && { Authorization: `Bearer ${token}` } };
        const response = await this.fetchImpl(`${PLANE_URL}/${path}`, { method, headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
        const value = await response.json().catch(() => { }) as (T & { error?: { code?: string; message?: string } }) | undefined;
        if (!response.ok) { throw new PlaneError(response.status, value?.error?.message ?? `cs-plane returned ${response.status}.`, value?.error?.code); }
        return value as T;
    }
}

// A session as cs-plane defines it, keyed by its local id so every launch of it maps to one cs-plane session.
const toSpec = ({ id, alias, account, partition, rootFolder, resources }: SlurmSession) =>
    ({ idempotencyKey: id, alias, account: account || undefined, partition, rootFolder: rootFolder || '$HOME', resources });
