import { createHash } from 'crypto';
import { Sample, POLLING_INTERVAL_MS } from '../models';

// Linkspan's HTTP API client — one function per endpoint, each taking the base URL + auth headers its transport
// mandates (see Tunnels.withLinkspan). It does the calling but owns no transport of its own, so the two compose at
// the caller.

const TIMEOUT_MS = POLLING_INTERVAL_MS - 500;

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

// GET /usage — Linkspan's live sample; a valid body also confirms Linkspan is up.
export async function getSample(baseUrl: string, headers: Record<string, string>): Promise<Sample> {
    return await get(baseUrl, headers, '/usage', j => typeof j === 'object' && j !== null && !Array.isArray(j)) as Sample;
}

// POST /vscode/sessions — the sshd for our public key; a ref naming the key makes it idempotent.
export async function ensureSshServer(baseUrl: string, headers: Record<string, string>, authorizedKey: string): Promise<SshServerInfo> {
    const ref = `bridge-${createHash('sha256').update(authorizedKey).digest('hex').slice(0, 16)}`;
    return await (await post(baseUrl, headers, '/vscode/sessions', { ref, authorized_key: authorizedKey })).json() as SshServerInfo;
}
