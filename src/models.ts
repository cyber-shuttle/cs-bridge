// Field names match cs-plane's wire types (Session, Resources, Run, RunStats, UsageSample). A persisted shape change
// here needs a SCHEMA_VERSION bump (modules/store.ts) and a step passed to migrate.

// As cs-plane's Resources: gpuType is a GRES type, or 'gpu' for any GPU.
export interface Resources {
    cores: number;
    memoryMb: number;
    wallMinutes: number;
    gpuType?: string;
    gpuCount?: number;
}

// Lifecycle: not_started → submitting → queued → preparing (job + Step-1 sshd) →
// ready_to_connect → connecting → connected; unreachable on a dropped connection or cluster outage; stopping → stopped/failed.
// Job end (completed or walltime killed) → stopped (can be started again).
export type SessionStatus =
    | 'not_started' | 'submitting' | 'queued' | 'preparing'
    | 'ready_to_connect' | 'connecting' | 'connected'
    | 'stopping' | 'stopped' | 'failed'
    | 'unreachable';

export interface SlurmSession {
    id: string;
    name: string;
    status: SessionStatus;
    alias: string; // the SSH host the job is submitted from
    account: string; // '' submits without --account
    partition: string;
    rootFolder: string;
    resources: Resources;
    jobId: string;
    submittedAt: number;
    startedAt?: number;
    errorMessage: string;
    transport: 'devtunnel' | 'link'; // the latest run's route to Linkspan
    devtunnel?: { id: string; cluster: string };
    planeId?: string; // the cs-plane session each link run attaches
    connectionInfo?: SessionConnectionInfo;
    jobScript?: string; // the previewed run's, cleared once submitted
}

// sshPort > 0 means Step 1 is up: Linkspan serves the session's sshd.
export interface PersistedConnectionInfo {
    sshPort: number;
    controlPort: number;
}

export interface SessionConnectionInfo extends PersistedConnectionInfo {
    localPort?: number; // this window's 127.0.0.1 forward to the sshd
    connectToken?: string; // the Dev Tunnel's connect token
}

export function persistableConnectionInfo(ci: SessionConnectionInfo | undefined): PersistedConnectionInfo | undefined {
    // A session preparing has a control port but no sshd yet; drop it and a reload orphans it.
    if (!ci?.sshPort && !ci?.controlPort) { return undefined; }
    return { sshPort: ci.sshPort, controlPort: ci.controlPort };
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
    memoryMb: number;
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

export type ViewSession = SlurmSession & { isCurrent: boolean; windowAlive: boolean; opening?: boolean; samples?: UsageSample[] };

export const SAMPLE_HISTORY_LEN = 20; // rolling live-sample window, also the sparkline slot count
export const POLLING_INTERVAL_MS = 5000;

// A resource sample from Linkspan's /usage. atMs (when taken) is set once stored, for rate derivation.
export interface UsageSample {
    memBytes?: number;
    cpuUsageUsec?: number;
    gpus?: GpuSample[];
    atMs?: number;
}

export interface GpuSample {
    index: number;
    utilPct: number;
    memUsedMiB: number;
    memTotalMiB: number;
}

export interface RunStats {
    cores?: number;
    requestedMemory?: string;
    elapsedSeconds?: number;
    maxRss?: string; // peak RSS, human-normalized (e.g. "1.2 GB")
    cpuEfficiencyPct?: number; // used / allocated CPU-seconds
    memoryEfficiencyPct?: number; // MaxRSS / requested memory
}

export interface Run {
    sessionId: string;
    alias: string;
    jobId: string;
    account: string;
    partition: string;
    endedAt: number;
    finalState: SessionStatus;
    stats?: RunStats;
    samples?: UsageSample[];
}

export interface RunsFile { runs?: Run[]; samples?: UsageSample[]; stats?: RunStats }

export interface StatsState {
    runs: Run[];
}

export interface SummaryState {
    session: SlurmSession;
    samples?: UsageSample[]; // live sample history (sparklines)
    stats?: RunStats; // sacct accounting; absent → the webview shows a "fetching…" spinner
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
    account?: string;
    resources?: Resources;
    jobId?: string;
}

export interface AWSInstanceInfo {
    name: string | undefined
    instanceID: string | undefined;
    state: string | undefined;
    instanceType: string | undefined;
    // publicIp: string | undefined;
}

export interface CloudProviderState {
    name: string;
    secretKey: string
    accessKey: string
    sessionToken: string
    instances: AWSInstanceInfo[]
    region: string
}

