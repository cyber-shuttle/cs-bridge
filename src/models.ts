// Field names match cs-plane's wire types (Session, Resources, Run, RunStats, UsageSample). A persisted shape change
// here needs a SCHEMA_VERSION bump (modules/store.ts) and a step passed to migrate.
import { uuidv7 } from 'uuidv7';

// As cs-plane's Resources: gpuType is a GRES type, or 'gpu' for any GPU.
export interface Resources {
    cores: number;
    memoryMb: number;
    wallMinutes: number;
    gpuType?: string;
    gpuCount?: number;
}

// Lifecycle: not_started → submitting → queued → preparing (job + Step-1 sshd) →
// ready_to_connect → connecting → connected; unreachable when a poll fails before the sshd is up; stopping → stopped/failed.
// Job end (completed or walltime killed) → stopped (can be started again). Derived, never stored: sessionMachine.deriveStatus.
export type SessionStatus =
    | 'not_started' | 'submitting' | 'queued' | 'preparing'
    | 'ready_to_connect' | 'connecting' | 'connected'
    | 'stopping' | 'stopped' | 'failed'
    | 'unreachable';

export interface SlurmSession {
    id: string;
    name: string;
    desired: 'running' | 'stopped';
    observed?: { state: SlurmJobStatus; at: number }; // the backend's last reading; EC2 states map onto the Slurm vocabulary
    failure?: string;
    owner?: string; // the window driving the live session, for as long as that window beats
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
    connectionInfo?: ConnectionInfo;
    ec2?: Ec2Spec; // an EC2 session: alias is aws-<region>, jobId the instance id, resources zero, transport unused
}

// image is '' when adopted from the account rather than launched here; ip is unset until the instance has a public one.
export interface Ec2Spec {
    region: string;
    type: string;
    image: string;
    user: string;
    ip?: string;
}
export type Ec2Session = SlurmSession & { ec2: Ec2Spec };
export const isEc2 = (s: SlurmSession): s is Ec2Session => s.ec2 !== undefined;

// A record not yet started. The id is a uuidv7, so sorting by id is creation order; the name is the creation time,
// whose last six digits alias the SSH host (csHostAlias).
export function newSession(fields: Pick<SlurmSession, 'alias' | 'account' | 'partition' | 'rootFolder' | 'resources'> & Partial<SlurmSession>): SlurmSession {
    const now = Date.now();
    return { id: uuidv7(), name: `${now}`, desired: 'running', jobId: '', submittedAt: now, errorMessage: '', transport: 'devtunnel', ...fields };
}

// sshPort > 0 means Step 1 is up: Linkspan serves the session's sshd.
export interface ConnectionInfo {
    sshPort: number;
    controlPort: number;
    localPort?: number; // the owner window's 127.0.0.1 forward to the sshd
}

export interface SshHost {
    alias: string;
    hostname?: string;
    user?: string;
    extraDirectives?: string[]; // "Key Value" ssh_config lines other than HostName/User
    source: 'user' | 'system'; // user is editable, system is read-only
}

export type NonEmpty<T> = readonly [T, ...T[]];
export const nonEmpty = <T>(xs: readonly T[]): xs is NonEmpty<T> => xs.length > 0;

export interface SlurmDiscovery {
    accounts: string[];
    partitions: NonEmpty<SlurmPartitionInfo>; // a host without partitions fails discovery
    homeDir: string;
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

export type ViewSession = SlurmSession & { status: SessionStatus; samples: UsageSample[]; isCurrent?: boolean; windowAlive?: boolean; opening?: boolean; starting?: boolean };

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
    startedAt?: number;
    endedAt: number;
    finalState: SessionStatus;
    wallMinutes?: number; // absent on runs from before 0.4.0
    stats?: RunStats;
    samples: UsageSample[];
}

export interface RunsFile { runs: Run[]; samples: UsageSample[]; stats?: RunStats }

export interface StatsState {
    runs: Run[];
}

export interface SummaryState {
    session: ViewSession; // its samples are the live history, or a past run's
    stats?: RunStats; // sacct accounting, absent when the run recorded none
    at: number; // when the run ended, or now while it runs
    pending: boolean; // the run is still being recorded
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
    preview: { sessionId: string; alias: string; script: string } | null;
    validating: boolean;
    alert: { title: string; message: string } | null;
}

export interface HostsState {
    sshHosts: SshHost[];
}

// What each webview posts to its provider; `ready` is every view's first message.
export type SessionsMessage =
    | { command: 'ready' | 'dismissDraftSession' | 'dismissPreview' | 'dismissAlert' | 'launchSession' | 'stopRemoteSession' }
    | { command: 'addSession'; alias: string; partition: string; account: string; rootFolder: string; resources: Resources }
    | { command: 'refreshSlurmDiscovery'; alias: string }
    | { command: 'prepareLaunchSession' | 'stopSessionExecution' | 'connectTunnel' | 'deleteSession'; sessionId: string };
export type HostsMessage = { command: 'ready' } | { command: 'deleteSshHost' | 'openTerminal' | 'editSshHost'; alias: string };
export type StatsMessage = { command: 'ready' } | { command: 'openRunSummary'; sessionId: string; jobId: string };
export type WebviewMessage = SessionsMessage | HostsMessage | StatsMessage;

// EC2 launch choices; the types run in every region, and each SSM parameter holds the image's latest x86_64 AMI id.
export const EC2_IMAGES = [
    { label: 'Amazon Linux 2023', ssmParameter: '/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64', user: 'ec2-user' },
    { label: 'Ubuntu 24.04 LTS', ssmParameter: '/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id', user: 'ubuntu' },
];
export const ec2ImageLabel = ({ image, user }: Pick<Ec2Spec, 'image' | 'user'>): string =>
    (EC2_IMAGES.find(i => i.ssmParameter === image) ?? EC2_IMAGES.find(i => i.user === user))?.label ?? user;
export const EC2_TYPES = ['t3.micro', 't3.small', 't3.medium', 't3.large', 't3.xlarge', 't3.2xlarge', 'm5.large', 'm5.xlarge', 'm5.2xlarge', 'm5.4xlarge'];
export const EC2_DEFAULTS = { region: 'us-east-1' };
