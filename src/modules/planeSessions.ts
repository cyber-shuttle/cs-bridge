// CyberShuttle sessions. The CyberShuttle API's listing is the truth about each session and its runs; plane/<id>.json holds
// only this machine's parts of it: the host alias, name, work root, owner window and the current run's ports. A listed
// session shows once it has parts, merged into one PlaneSession per id that the monitor and transports hold, so every
// merge lands on that object. Each window polls the listing and keeps it in memory only.
import { Logger, errMsg } from '../logger';
import { POLLING_INTERVAL_MS, PlaneSession, ProcessState, SessionResponse, SlurmJobStatus, SlurmSession } from '../models';
import type { Plane } from '../plane';
import { cyberShuttleAlias } from './sshHostsStore';
import { Files, JsonDir } from './store';

export interface PlaneParts { alias: string; name: string; rootFolder: string; owner?: string; ports?: { processId: string; sshPort: number; localPort?: number } }
type PlaneApi = Pick<Plane, 'signedIn' | 'sessions' | 'clusterConfig'>;

const logger = Logger.getInstance();
const OBSERVED: Record<ProcessState, SlurmJobStatus> = {
    CREATED: SlurmJobStatus.QUEUED, SUBMITTED: SlurmJobStatus.QUEUED, READY: SlurmJobStatus.RUNNING, RUNNING: SlurmJobStatus.RUNNING,
    COMPLETED: SlurmJobStatus.COMPLETED, FAILED: SlurmJobStatus.FAILED, CANCELLED: SlurmJobStatus.CANCELLED,
};

let partsDir: JsonDir<PlaneParts>;
let listing: SessionResponse[] = [];
const views = new Map<string, PlaneSession>();
const listeners = new Set<() => void>();
let generation = 0;
let refreshing = false;
const adopting = new Set<string>();

export async function initPlaneStore(files: Files, onError: (err: unknown) => void): Promise<JsonDir<PlaneParts>> {
    partsDir = new JsonDir<PlaneParts>(files, 'plane', onError);
    await partsDir.load();
    partsDir.onDidChange(changed);
    return partsDir;
}

function changed(): void {
    for (const r of listing) {
        const p = partsDir.get(r.sessionId);
        if (!p) { continue; }
        const [run] = r.runs;
        const cur = views.get(r.sessionId);
        const fields: Omit<PlaneSession, 'desired' | 'errorMessage'> = {
            id: r.sessionId, name: p.name, alias: p.alias, rootFolder: `${p.rootFolder}/${run.processId}`,
            account: r.account, partition: r.partition, resources: r.resources, jobId: run.processId, submittedAt: 0,
            startedAt: run.startedAt ?? undefined, observed: { state: OBSERVED[r.state], at: 0 },
            failure: r.state === 'FAILED' ? run.error || 'Failed' : undefined, transport: 'link', owner: p.owner, plane: r,
            connectionInfo: p.ports?.processId === run.processId ? { sshPort: p.ports.sshPort, controlPort: run.controlPort, localPort: p.ports.localPort }
                : r.live ? { sshPort: 0, controlPort: run.controlPort } : undefined,
        };
        if (!cur) { views.set(r.sessionId, { ...fields, desired: 'running', errorMessage: '' }); }
        else { Object.assign(cur, fields, cur.jobId !== run.processId && { desired: 'running', errorMessage: '' }); }
    }
    for (const listener of listeners) { listener(); }
}

export const planeSessions = (): PlaneSession[] => listing.flatMap(r => (partsDir.get(r.sessionId) && views.get(r.sessionId)) || []);
export const planeParts = (): [string, PlaneParts][] => partsDir.entries();

export function applyPlane(r: SessionResponse, created?: Pick<PlaneParts, 'alias' | 'rootFolder'>): void {
    generation++;
    listing = listing.some(l => l.sessionId === r.sessionId) ? listing.map(l => (l.sessionId === r.sessionId ? r : l)) : [r, ...listing];
    if (created) { void partsDir.set(r.sessionId, { ...created, name: String(r.createdAt) }); }
    else { changed(); }
}

export function forgetPlane(id: string): void {
    generation++;
    listing = listing.filter(l => l.sessionId !== id);
    views.delete(id);
    void partsDir.delete(id);
}

export function patchPlane(s: PlaneSession, fields: Partial<SlurmSession>): Promise<void> {
    Object.assign(s, fields);
    const parts: Partial<PlaneParts> = {};
    if ('owner' in fields) { parts.owner = fields.owner; }
    if ('connectionInfo' in fields) { parts.ports = fields.connectionInfo && { processId: s.jobId, sshPort: fields.connectionInfo.sshPort, localPort: fields.connectionInfo.localPort }; }
    if (Object.keys(parts).length) { return partsDir.patch(s.id, parts); }
    changed();
    return Promise.resolve();
}

export async function stopPlaneRun(api: Pick<Plane, 'stopProcess'>, s: PlaneSession): Promise<void> {
    await patchPlane(s, { desired: 'stopped', errorMessage: '' });
    try { await api.stopProcess(s.plane.runs[0].processId); }
    catch (err) { await patchPlane(s, { desired: 'running' }); throw err; }
}

export async function refreshPlane(api: PlaneApi, onGone: (id: string) => void): Promise<void> {
    if (refreshing) { return; }
    refreshing = true;
    try {
        const began = generation;
        // Parts written while the listing is in flight, by a create here or another window's adopt, are not pruned by it;
        // parts deleted meanwhile are not adopted back.
        const known = partsDir.entries().map(([id]) => id);
        if (!await api.signedIn()) { list([]); return; }
        const next = await api.sessions();
        // A create, start or delete here since the listing began makes it stale.
        if (generation !== began) { return; }
        list(next);
        for (const id of known) { if (!next.some(r => r.sessionId === id)) { onGone(id); } }
        for (const r of next) { if (!known.includes(r.sessionId) && !partsDir.get(r.sessionId)) { void adopt(api, r); } }
    }
    catch (err) { logger.warn(`Listing CyberShuttle sessions failed: ${errMsg(err)}`); }
    finally { refreshing = false; }
}

function list(next: SessionResponse[]): void {
    if (JSON.stringify(next) === JSON.stringify(listing)) { return; }
    listing = next;
    changed();
}

async function adopt(api: PlaneApi, r: SessionResponse): Promise<void> {
    if (adopting.has(r.sessionId)) { return; }
    adopting.add(r.sessionId);
    try {
        const config = await api.clusterConfig(r.slurmClusterConfigId);
        await partsDir.reload(r.sessionId); // another window's adopt may not have reached the watcher; a set over it clears its owner and ports
        if (!partsDir.get(r.sessionId)) { await partsDir.set(r.sessionId, { alias: cyberShuttleAlias(config), name: String(r.createdAt), rootFolder: config.workRoot }); }
    }
    catch (err) { logger.warn(`Reading the cluster config of CyberShuttle session ${r.sessionId} failed: ${errMsg(err)}`); }
    finally { adopting.delete(r.sessionId); }
}

export function watchPlane(api: PlaneApi, onGone: (id: string) => void): { dispose(): void } {
    void refreshPlane(api, onGone);
    const timer = setInterval(() => void refreshPlane(api, onGone), POLLING_INTERVAL_MS);
    return { dispose: () => clearInterval(timer) };
}

export function onPlaneChange(listener: () => void): { dispose(): void } {
    listeners.add(listener);
    return { dispose: () => listeners.delete(listener) };
}
