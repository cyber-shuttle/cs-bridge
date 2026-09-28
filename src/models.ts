export interface SlurmSession extends Session {
    jobId: string;
    queue: string;
    wallTime: string;
    gpuCount: number;
    gpuClass: string;
    cpus: number;
    memory: string;
    allocation: string;
    jobScript?: string;
    tunnelId?: string;
    tunnelCluster?: string;
}

// Lifecycle: not_started → submitting → queued → preparing (job + Step-1 sshd/Dev Tunnel) →
// ready_to_connect → connecting → connected; unreachable on a dropped Dev Tunnel connection or cluster outage; stopping → stopped/failed.
// Job end (completed or walltime killed) → stopped (can be started again).
interface Session {
    id: string;
    name: string;
    cluster: string;
    status:
        | 'not_started' | 'submitting' | 'queued' | 'preparing'
        | 'ready_to_connect' | 'connecting' | 'connected'
        | 'stopping' | 'stopped' | 'failed'
        | 'unreachable';
    submittedAt: number;
    startedAt?: number;
    errorMessage: string;
    connectionInfo?: SessionConnectionInfo;
    workingDirectory?: string;
    windowPids?: number[];
}

export interface PersistedConnectionInfo {
    sshPort: number;
    sshTunnelId: string;
    region: string;
    apiPort?: number;
}

export interface SessionConnectionInfo extends PersistedConnectionInfo {
    sshTunnelForwardPort?: number;
    apiTunnelId?: string;
    apiTunnelAccessToken?: string;
}

export function persistableConnectionInfo(ci: SessionConnectionInfo | undefined): PersistedConnectionInfo | undefined {
    // A session preparing on the Dev Tunnel has an apiPort but no sshd yet; drop it and a reload orphans it.
    if (!ci?.sshTunnelId && !ci?.apiPort) { return undefined; }
    const { sshTunnelId, sshPort, region, apiPort } = ci;
    return { sshTunnelId, sshPort, region, apiPort };
}

export interface SshHost {
    alias: string;
    hostname?: string;
    user?: string;
    extraDirectives?: string[]; // "Key Value" ssh_config lines other than HostName/User
    source?: 'user' | 'system'; // user is editable, system is read-only
}

export interface SlurmDiscovery {
    alias: string;
    accounts: string[];
    partitions: SlurmPartitionInfo[];
    homeDir?: string;
}

export interface SlurmPartitionInfo {
    name: string;
    cpuCount: number;
    memory: string;
    gres: GresInfo[];
}

export interface GresInfo {
    name: string;
    count: number;
}

export enum SlurmJobStatus {
    QUEUED = 'queued',
    RUNNING = 'running',
    COMPLETED = 'completed',
    FAILED = 'failed',
    CANCELLED = 'cancelled',
    TIMEOUT = 'timeout',
    OUT_OF_MEMORY = 'out_of_memory',
    UNKNOWN = 'unknown',
}

export type ViewSession = SlurmSession & { isCurrent: boolean; windowAlive: boolean; opening?: boolean; samples?: Sample[] };

export const SAMPLE_HISTORY_LEN = 20; // rolling live-sample window, also the sparkline slot count
export const POLLING_INTERVAL_MS = 5000;

// A resource sample from Linkspan's /metrics. atMs (when taken) is set once stored, for rate derivation.
export interface Sample {
    memBytes?: number;
    cpuUsageUsec?: number;
    gpus?: GpuStat[];
    atMs?: number;
}

export interface GpuStat {
    index: number;
    utilPct: number;
    memUsedMiB: number;
    memTotalMiB: number;
}

export interface Stats {
    cores?: number;
    reqMem?: string;
    elapsedSec?: number;
    maxRss?: string; // peak RSS, human-normalized (e.g. "1.2 GB")
    cpuEfficiencyPct?: number; // used / allocated CPU-seconds
    memEfficiencyPct?: number; // MaxRSS / ReqMem
}

export interface SessionRunRecord {
    sessionId: string;
    cluster: string;
    jobId: string;
    endedAt: number;
    finalStatus: Session['status'];
    stats?: Stats;
    metrics?: Sample[];
    allocation?: string;
    queue?: string;
}

export interface StatsState {
    runs: SessionRunRecord[];
}

export interface SummaryState {
    session: SlurmSession;
    samples?: Sample[]; // live sample history (sparklines)
    stats?: Stats; // sacct accounting; absent → the webview shows a "fetching…" spinner
}

// An SSH host's runtime-details fetch is in exactly one phase; the draft form renders straight off it.
export type HostRuntime =
    | { phase: 'loading' }
    | { phase: 'error'; message: string }
    | { phase: 'ready'; info: SlurmDiscovery };

export interface SessionsState {
    isRemote: boolean;
    sessions: ViewSession[];
    draftAlias: string | null;
    hostRuntime: Record<string, HostRuntime>;
    previewSession: SlurmSession | null;
    validating: boolean;
    alert: { title: string; message: string } | null;
}

export interface HostsState {
    sshHosts: SshHost[];
}

// A message posted from a webview to its provider. Fields are optional; each command reads the ones it needs.
export interface WebviewMessage {
    command: string;
    sessionId?: string;
    alias?: string;
    partition?: string;
    wallTime?: string;
    gpu?: string;
    cpus?: string;
    memory?: string;
    account?: string;
    jobId?: string;
}
