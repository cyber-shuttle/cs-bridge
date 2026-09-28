import { Sample, POLLING_INTERVAL_MS } from '../models';

// Linkspan's HTTP API client — one function per endpoint, each taking the base URL + auth headers its transport
// mandates (a Dev Tunnel today; see tunnelSupport.linkspanEndpoint). It does the calling but owns no transport of its
// own, so the Dev Tunnel and Linkspan stay separate and compose at the caller.

const TIMEOUT_MS = POLLING_INTERVAL_MS - 500;

export interface LinkspanSshStatus {
    id: string;
    state: string; // "running" while the listener is up; "restarting"/"failed" otherwise
    addr?: string; // ":<port>" the sshd is bound to
}

interface SshServerInfo { bind_port: number; id: string }

// GET and require a shape-checked JSON body — the Dev Tunnel edge answers 200 with an HTML page once Linkspan is gone,
// so a valid body (not resp.ok) is the real liveness signal.
async function get(baseUrl: string, headers: Record<string, string>, path: string, valid: (json: unknown) => boolean): Promise<unknown> {
    const resp = await fetch(baseUrl + path, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const body = await resp.text();
    let json: unknown;
    try { json = JSON.parse(body); }
    catch { /* not JSON: the edge's interstitial page */ }
    if (!resp.ok || !valid(json)) { throw new Error(`Linkspan ${path} unhealthy (status=${resp.status}): ${body.slice(0, 200)}`); }
    return json;
}

async function post(baseUrl: string, headers: Record<string, string>, path: string, body: unknown): Promise<Response> {
    const resp = await fetch(baseUrl + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    if (!resp.ok) { throw new Error(`Linkspan ${path} failed (status=${resp.status} ${resp.statusText}): ${(await resp.text()).slice(0, 200)}`); }
    return resp;
}

export async function getHealth(baseUrl: string, headers: Record<string, string>): Promise<void> {
    await get(baseUrl, headers, '/health', j => (j as { status?: unknown })?.status === 'ok');
}

// GET /vscode/sessions — the sshd supervisor state (a JSON array also confirms Linkspan is up).
export async function getSshServers(baseUrl: string, headers: Record<string, string>): Promise<LinkspanSshStatus[]> {
    return await get(baseUrl, headers, '/vscode/sessions', Array.isArray) as LinkspanSshStatus[];
}

// GET /metrics — Linkspan's live sample; a valid body also confirms Linkspan is up.
export async function getSample(baseUrl: string, headers: Record<string, string>): Promise<Sample> {
    return await get(baseUrl, headers, '/metrics', j => typeof j === 'object' && j !== null && !Array.isArray(j)) as Sample;
}

// POST /vscode/sessions — create a fresh sshd authorized for our public key. Not idempotent; the caller guards re-creation.
export async function createSshServer(baseUrl: string, headers: Record<string, string>, authorizedKey: string): Promise<SshServerInfo> {
    return await (await post(baseUrl, headers, '/vscode/sessions', { authorized_key: authorizedKey })).json() as SshServerInfo;
}

// Linkspan binds each sshd on ":<port>" and ids it "s-<port>", so both fields encode the (restart-stable) port.
export const sshdPort = (s: LinkspanSshStatus): number =>
    Number(s.addr?.split(':').pop()) || Number(s.id.replace(/^s-/, '')) || 0;
