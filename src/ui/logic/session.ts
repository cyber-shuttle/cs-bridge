import { ec2ImageLabel, isEc2, type Ec2Session, type SlurmSession, type ViewSession } from '@/models';
import { isDeletable, isReachable, isStoppable, wallMs } from '@/modules/sessionMachine';

export { wallMs }; // shared with the monitor via the vscode-free sessionMachine

type ActionKind = 'start' | 'stop' | 'switch' | 'connect' | 'current' | 'opening';

export interface SessionAction {
    kind: ActionKind;
    label: string;
    icon: string;
}

/** ms → "1h 30m" above an hour, "0m 45s" below. Clamps negatives to zero. */
export function fmtTime(ms: number): string {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
}

/** Elapsed since `since` as "45s" / "2m 5s". Clamps at zero: the webview clock ticks once a second, so it can
 *  momentarily trail a just-set timestamp — without the clamp that reads as a spurious "-1s". */
export function elapsedLabel(since: number, now: number): string {
    const secs = Math.max(0, Math.floor((now - since) / 1000));
    return secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`;
}

/** Milliseconds left until the wall-clock deadline; the full walltime if not yet started. */
export function remainingMs(session: Pick<SlurmSession, 'resources' | 'startedAt'>, now: number): number {
    const total = wallMs(session);
    return session.startedAt ? session.startedAt + total - now : total;
}

/** Wall-clock run-time used: elapsed since start, capped at the walltime limit (uncapped when the limit is 0/unlimited); 0 before the job starts. */
export function elapsedRunMs(session: Pick<SlurmSession, 'resources' | 'startedAt'>, now: number): number {
    if (!session.startedAt) { return 0; }
    const total = wallMs(session);
    const raw = now - session.startedAt;
    return Math.max(0, total > 0 ? Math.min(raw, total) : raw);
}

// Colour buckets for the status dot: orange = error, green = live.
// Everything else (idle/pending/stopping/stopped) falls through to neutral grey.
const ORANGE: ViewSession['status'][] = ['failed', 'unreachable'];

const STOP: SessionAction = { kind: 'stop', label: 'Stop', icon: 'debug-stop' };

export function dotColor(status: ViewSession['status']): string {
    if (ORANGE.includes(status)) { return 'var(--vscode-charts-orange)'; }
    if (isReachable(status)) { return 'var(--vscode-charts-green)'; }
    return 'var(--vscode-descriptionForeground)';
}

export function sessionActions(session: ViewSession): SessionAction[] {
    const s = session.status;
    if (isDeletable(s)) { return [{ kind: 'start', label: 'Start', icon: 'play' }]; }

    const actions: SessionAction[] = [];
    if (isStoppable(s)) { actions.push(STOP); }
    if (s === 'connected') {
        if (session.isCurrent) { actions.push({ kind: 'current', label: 'Current', icon: 'check' }); }
        else if (session.windowAlive) { actions.push({ kind: 'switch', label: 'Switch', icon: 'arrow-swap' }); }
        else if (session.opening) { actions.push({ kind: 'opening', label: 'Opening…', icon: 'loading' }); }
        else { actions.push({ kind: 'switch', label: 'Connect', icon: 'arrow-swap' }); }
    }
    else if (s === 'connecting') {
        actions.push({ kind: 'opening', label: 'Connecting…', icon: 'loading' });
    }
    else if (s === 'ready_to_connect' || s === 'unreachable') {
        // For 'unreachable', Reconnect rebuilds the Dev Tunnel connection via the Dev Tunnels API → back to reachable, off the SSH host path.
        actions.push({ kind: 'connect', label: s === 'ready_to_connect' ? 'Connect' : 'Reconnect', icon: 'arrow-swap' });
    }
    return actions;
}

// A dot at rest, a spinner in progress, a square for trouble; dotColor carries the state distinction.
const STATUS_ICON: Record<ViewSession['status'], { name: string; spin?: boolean }> = {
    not_started: { name: 'circle-outline' },
    submitting: { name: 'loading', spin: true },
    queued: { name: 'loading', spin: true },
    preparing: { name: 'loading', spin: true },
    ready_to_connect: { name: 'circle-outline' },
    connecting: { name: 'loading', spin: true },
    connected: { name: 'circle-filled' },
    unreachable: { name: 'primitive-square' },
    failed: { name: 'primitive-square' },
    stopped: { name: 'primitive-square' },
    stopping: { name: 'loading', spin: true },
};

interface Provider<S extends ViewSession = ViewSession> {
    kind: 'HPC' | 'AWS';
    theme: 'info' | 'warning';
    chips: (s: S) => string[];
    details?: (s: S) => string[]; // absent: the card renders the resource graphs
    booting: string;
    running: (s: S, now: number) => string;
}

const HPC: Provider = {
    kind: 'HPC',
    theme: 'info',
    chips: s => [s.account, s.partition],
    booting: 'Starting Linkspan…',
    running: (s, now) => `${fmtTime(remainingMs(s, now))} left`,
};

const AWS: Provider<ViewSession & Ec2Session> = {
    kind: 'AWS',
    theme: 'warning',
    chips: s => [s.ec2.type, ec2ImageLabel(s.ec2)],
    details: s => [s.ec2.region, s.jobId, s.ec2.ip].filter((d): d is string => !!d),
    booting: 'Booting…',
    running: () => 'Running',
};

export interface CardModel {
    kind: Provider['kind'];
    theme: Provider['theme'];
    icon: { name: string; spin?: boolean };
    color: string;
    chips: string[];
    walltime?: string;
    details?: string[];
    status: { text: string; title?: string };
    actions: SessionAction[];
    canDelete: boolean;
}

function statusText<S extends ViewSession>(s: S, now: number, provider: Provider<S>): CardModel['status'] {
    const err = s.errorMessage || undefined;
    switch (s.status) {
        case 'not_started': return { text: 'Not started' };
        case 'submitting': return { text: 'Submitting…' };
        case 'queued': return { text: `Queued${s.submittedAt ? ` (${elapsedLabel(s.submittedAt, now)})` : ''}` };
        case 'preparing': return { text: provider.booting };
        case 'ready_to_connect':
        case 'connected': return { text: provider.running(s, now) };
        case 'connecting': return { text: 'Connecting…' };
        case 'unreachable': return { text: err ? `Unreachable: ${err}` : 'SSH host unreachable — retrying…', title: err };
        case 'stopping': return { text: 'Stopping…' };
        case 'stopped': return { text: err ? `Stop failed: ${err}` : 'Stopped' };
        case 'failed': return { text: err ? `Failed: ${err}` : 'Failed', title: err };
    }
}

export const cardModel = (s: ViewSession, now: number, remote = false): CardModel => isEc2(s) ? card(s, AWS, now, remote) : card(s, HPC, now, remote);

function card<S extends ViewSession>(s: S, provider: Provider<S>, now: number, remote: boolean): CardModel {
    const actions = sessionActions(s);
    return {
        kind: provider.kind, theme: provider.theme, icon: STATUS_ICON[s.status], color: dotColor(s.status), chips: provider.chips(s),
        ...provider.kind === 'HPC' && { walltime: fmtTime(wallMs(s)) }, details: provider.details?.(s), status: statusText(s, now, provider),
        actions: remote ? actions.filter(a => a.kind === 'stop') : actions, canDelete: !remote && isDeletable(s.status),
    };
}
