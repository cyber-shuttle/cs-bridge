import { createHash } from 'crypto';
import { UsageSample, POLLING_INTERVAL_MS } from '../models';
import { parseJson } from './json';

// Linkspan's HTTP API client — one function per endpoint, each taking the base URL + auth headers its transport
// mandates (see Tunnels.withLinkspan). It does the calling but owns no transport of its own, so the two compose at
// the caller.

const TIMEOUT_MS = POLLING_INTERVAL_MS - 500;
const POST_TIMEOUT_MS = 30_000; // starting the sshd can take a while, and a stall must not hold the session's tick forever

interface SshServerInfo { bind_port: number; id: string }

// Every field of a UsageSample is optional, so any JSON object is one.
export function parseSample(body: string): UsageSample {
    const json = parseJson<unknown>(body);
    if (typeof json !== 'object' || json === null || Array.isArray(json)) { throw new Error(`Linkspan /usage answered no object: ${body.slice(0, 200)}`); }
    return json;
}

async function post(baseUrl: string, headers: Record<string, string>, path: string, body: unknown): Promise<Response> {
    const resp = await fetch(baseUrl + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(POST_TIMEOUT_MS) });
    if (!resp.ok) { throw new Error(`Linkspan ${path} failed (status=${resp.status} ${resp.statusText}): ${(await resp.text()).slice(0, 200)}`); }
    return resp;
}

// GET /usage — Linkspan's live sample; a valid body also confirms Linkspan is up. The Dev Tunnel edge answers 200 with
// an HTML page once Linkspan is gone, so the body's shape, not resp.ok, is the liveness signal.
export async function getSample(baseUrl: string, headers: Record<string, string>): Promise<UsageSample> {
    const resp = await fetch(`${baseUrl}/usage`, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const body = await resp.text();
    try { if (resp.ok) { return parseSample(body); } }
    catch { /* not JSON: the edge's interstitial page */ }
    throw new Error(`Linkspan /usage unhealthy (status=${resp.status}): ${body.slice(0, 200)}`);
}

// POST /vscode/sessions — the sshd for our public key; a ref naming the key, in cs-plane's StartSSH format, makes it idempotent.
export async function ensureSshServer(baseUrl: string, headers: Record<string, string>, authorizedKey: string): Promise<SshServerInfo> {
    const ref = `ssh-${createHash('sha256').update(authorizedKey).digest('hex').slice(0, 16)}`;
    return parseJson<SshServerInfo>(await (await post(baseUrl, headers, '/vscode/sessions', { ref, authorized_key: authorizedKey })).text());
}
