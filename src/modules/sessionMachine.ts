import { SessionStatus as Status, SlurmJobStatus, SlurmSession } from '../models';

export const wallMs = (session: Pick<SlurmSession, 'resources'>): number => session.resources.wallMinutes * 60_000;

/** Slurm kills the job at --time, so a passed deadline is authoritative even when the SSH host is unreachable
 *  for `sacct`. Assumes death within KillWait of --time; OverTimeLimit clusters may run past it. */
export function isWallTimeExpired(session: Pick<SlurmSession, 'resources' | 'startedAt'>, now: number): boolean {
    const total = wallMs(session);
    return session.startedAt !== undefined && total > 0 && now >= session.startedAt + total;
}

// Session-status categories — the single source of truth shared by the provider, monitor, and webview UI.
const TERMINAL: Status[] = ['stopped', 'failed'];
// 'stopping' is excluded so Stop neither shows nor re-triggers while a stop is already in flight.
const STOPPABLE: Status[] = ['submitting', 'queued', 'preparing', 'ready_to_connect', 'connecting', 'connected', 'unreachable'];
const REACHABLE: Status[] = ['ready_to_connect', 'connecting', 'connected'];

export const isTerminal = (status: Status): boolean => TERMINAL.includes(status);
export const isDeletable = (status: Status): boolean => isTerminal(status) || status === 'not_started';
export const isStoppable = (status: Status): boolean => STOPPABLE.includes(status);
export const isReachable = (status: Status): boolean => REACHABLE.includes(status);

export interface LiveFacts {
    launching: boolean;
    connecting: boolean;
    connected: boolean;
    unreachable: boolean; // the last poll failed to reach the backend
}

type Facts = Pick<SlurmSession, 'desired' | 'observed' | 'failure' | 'jobId' | 'startedAt' | 'resources' | 'connectionInfo'>;
const ENDED: SlurmJobStatus[] = [SlurmJobStatus.COMPLETED, SlurmJobStatus.CANCELLED, SlurmJobStatus.TIMEOUT];
const DIED: SlurmJobStatus[] = [SlurmJobStatus.FAILED, SlurmJobStatus.OUT_OF_MEMORY];

// Derived, not stored, so no writer has a status another writer must guard against.
export function deriveStatus(s: Facts, live: LiveFacts, now: number): Status {
    if (s.failure) { return 'failed'; }
    if (!s.jobId) { return live.launching ? 'submitting' : 'not_started'; }
    const state = s.observed?.state ?? SlurmJobStatus.UNKNOWN;
    if (DIED.includes(state)) { return 'failed'; }
    if (ENDED.includes(state) || isWallTimeExpired(s, now)) { return 'stopped'; }
    if (s.desired === 'stopped') { return 'stopping'; }
    const sshUp = (s.connectionInfo?.sshPort ?? 0) > 0;
    if (live.unreachable && !sshUp) { return 'unreachable'; }
    if (state !== SlurmJobStatus.RUNNING) { return 'queued'; }
    if (!sshUp) { return 'preparing'; }
    return live.connected ? 'connected' : live.connecting ? 'connecting' : 'ready_to_connect';
}

const EC2_OBSERVED: Readonly<Record<string, SlurmJobStatus>> = {
    'pending': SlurmJobStatus.RUNNING, 'running': SlurmJobStatus.RUNNING, 'stopping': SlurmJobStatus.RUNNING,
    'stopped': SlurmJobStatus.CANCELLED, 'shutting-down': SlurmJobStatus.FAILED, 'terminated': SlurmJobStatus.FAILED,
};
export const observedEc2 = (state: string): SlurmJobStatus => EC2_OBSERVED[state] ?? SlurmJobStatus.UNKNOWN;
