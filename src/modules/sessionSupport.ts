import { Ec2Session, UsageSample, POLLING_INTERVAL_MS, SlurmJobStatus, SlurmSession, isEc2 } from '../models';
import { Logger, errMsg } from './../logger';
import { PlaneError } from '../plane';
import { getSession, patch, setError, observe, statusOf, live, claim, owns } from '../extensionStore';
import { recordSessionRun, sacctStats } from '../sessionRunSupport';
import { SshManager, hasSessionKey, syncSshConfig } from './sshSupport';
import { getSampleViaSrun, getSlurmJobStatus } from './slurmSupport';
import { buildSlurmScript } from './slurmParse';
import { isReachable, isTerminal } from './sessionMachine';
import { checkSlurmAvailability, linkspanIsUpToDate, installLinkspan, submitJobToSlurm, LaunchDraft } from './slurmLaunch';
import { Transport, Transports, connectSessionToTunnel, disconnectSessionFromTunnel, disposeTunnelClient, ensureRemoteSession, isTunnelClientConnected } from './transport';
import { getHealth, getSample } from './linkspanSupport';
import { appendSample, writeSessionStats, resetLive } from './runStore';

const logger = Logger.getInstance();
// How often to refresh the in-run sacct copy; coarse since usage only flushes at step end.
const SACCT_REFRESH_MS = 30_000;
// Consecutive failed probes before we stop trusting the Dev Tunnel and cross-check the job over batch sacct.
const PROBE_GIVEUP = 6;

const sessionLine = (name: string, msg: string): string => `Session ${name}: ${msg}`;

// What drives a session's remote side: the Slurm job (SlurmBackend) or an EC2 instance (ec2Session.ts). The provider
// stops, connects and removes through it; the monitor ticks and ends through it. Starting differs per backend.
export interface Backend<S extends SlurmSession = SlurmSession> {
    readonly label: string; // what an unreachable poll names
    stop(session: S): Promise<void>;
    connect(session: S): Promise<boolean>;
    remove(session: S): Promise<void>;
    tick(session: S): Promise<void>;
    end(session: S): Promise<void>;
    forget(sessionId: string): void;
}

// The one place that tells an EC2 record from a Slurm one.
export class Backends {
    constructor(private readonly slurm: Backend, private readonly ec2: Backend<Ec2Session>) { }

    use<R>(session: SlurmSession, call: <S extends SlurmSession>(backend: Backend<S>, session: S) => R): R {
        return isEc2(session) ? call(this.ec2, session) : call(this.slurm, session);
    }
}

// One independent poll loop per active session. No shared lock: each loop mutates
// only its own session and updateSession is synchronous, so ticks never race.
interface Loop { session: SlurmSession; timer: ReturnType<typeof setInterval>; ticking: boolean }
export class SessionMonitor {
    private loops = new Map<string, Loop>();

    constructor(private readonly backends: Backends) { }

    // Teardown for a Stop and for a backend that ended on its own.
    async endSession(session: SlurmSession): Promise<void> {
        this.stopMonitoring(session.id);
        await this.backends.use(session, (b, s) => b.end(s));
    }

    // A slow tick must not overlap its next fire.
    private async tick(sessionId: string): Promise<void> {
        const loop = this.loops.get(sessionId);
        if (!loop || loop.ticking) { return; }
        loop.ticking = true;
        const { session } = loop;
        const label = this.backends.use(session, b => b.label);
        try {
            if (!owns(session)) {
                this.stopMonitoring(sessionId);
                await disposeTunnelClient(sessionId);
                return;
            }
            if (isTerminal(statusOf(session))) {
                void this.endSession(session);
                return;
            }

            await this.backends.use(session, (b, s) => b.tick(s));
            if (live.unreachable.delete(session.id)) { setError(session, ''); }
            if (isTerminal(statusOf(session))) { void this.endSession(session); }
        }
        catch (error) {
            // SSH host unreachable (dead ControlMaster, Duo-needed under BatchMode) or the AWS API down — not death; stay recoverable.
            logger.warn(sessionLine(session.name, `${label} unreachable (will retry): ${errMsg(error)}`));
            live.unreachable.add(session.id);
            setError(session, `${label} unreachable: ${errMsg(error)}`);
        }
        finally {
            loop.ticking = false;
        }
    }

    // No-op if already running or not yet launched. The first poll fires now so status isn't stale for a full interval.
    public startMonitoring(session: SlurmSession): void {
        if (!session.jobId || this.loops.has(session.id) || !claim(session)) { return; }
        this.loops.set(session.id, { session, timer: setInterval(() => void this.tick(session.id), POLLING_INTERVAL_MS), ticking: false });
        logger.info(sessionLine(session.name, `monitoring started (JobId=${session.jobId})`));
        void this.tick(session.id);
    }

    public stopMonitoring(sessionId: string): void {
        const loop = this.loops.get(sessionId);
        if (!loop) { return; }
        clearInterval(loop.timer);
        this.loops.delete(sessionId);
        live.unreachable.delete(sessionId);
        this.backends.use(loop.session, b => b.forget(sessionId));
        logger.info(sessionLine(loop.session.name, `monitoring stopped.`));
    }

    public dispose(): void {
        for (const id of [...this.loops.keys()]) { this.stopMonitoring(id); }
    }
}

export class SlurmBackend implements Backend {
    readonly label = 'SSH host';
    private probeFailedCounts = new Map<string, number>();
    private lastSacctAt = new Map<string, number>(); // throttles the in-run sacct refresh, per session

    // The monitor is built with this backend, so it arrives lazily.
    constructor(private readonly transports: Transports, private readonly monitor: () => SessionMonitor) { }

    private log(session: SlurmSession, msg: string): void { logger.info(sessionLine(session.name, msg)); }
    private warn(session: SlurmSession, msg: string): void { logger.warn(sessionLine(session.name, msg)); }

    private probeFails(id: string): number { return this.probeFailedCounts.get(id) ?? 0; } // no entry: no failure yet
    private bumpProbeFails(id: string): number { const n = this.probeFails(id) + 1; this.probeFailedCounts.set(id, n); return n; }

    forget(sessionId: string): void {
        this.probeFailedCounts.delete(sessionId);
        this.lastSacctAt.delete(sessionId);
    }

    async start(session: SlurmSession, draft: LaunchDraft): Promise<void> {
        this.log(session, `initiating launch`);
        const run = SshManager.getInstance();
        await checkSlurmAvailability(session, run, logger);
        if (!await linkspanIsUpToDate(session, run, logger)) {
            await installLinkspan(session, run, logger);
        }
        await submitJobToSlurm(session, run, logger, draft);
        this.monitor().startMonitoring(session);
    }

    // The teardown runs whether or not scancel was accepted; the caller marks a refused stop as the failure it is.
    async stop(session: SlurmSession): Promise<void> {
        this.log(session, `stopping`);
        try {
            if (!session.jobId) { this.warn(session, `has no job ID; marking stopped without scancel.`); return; }
            const stopCommand = `scancel ${session.jobId}`;
            this.log(session, `sending stop command: ${stopCommand}`);
            try {
                await SshManager.getInstance().runRemoteCommand(session.alias, stopCommand);
                observe(session, SlurmJobStatus.CANCELLED);
                this.log(session, `stop command sent successfully`);
            }
            catch (err) {
                // Refused: sacct says whether the job had ended anyway.
                observe(session, await getSlurmJobStatus(session).then(r => r.status, () => SlurmJobStatus.UNKNOWN));
                if (!isTerminal(statusOf(session))) { throw new Error(`failed to send stop command: ${errMsg(err)}`, { cause: err }); }
                this.log(session, `job already ended`);
            }
        }
        finally { await this.monitor().endSession(session); }
    }

    // Step 2: (re)build the in-process connection from the persisted refs. No window — reattach and connect share this.
    async connect(session: SlurmSession): Promise<boolean> {
        if (live.connecting.has(session.id)) {
            this.log(session, `connect already in progress; ignoring re-entrant request`);
            return false;
        }
        live.connecting.add(session.id);
        const transport = this.transports.transportFor(session);
        try {
            const ci = await ensureRemoteSession(transport, session); // idempotent; refreshes tunnel creds for reattach
            if (!hasSessionKey(session.id)) { throw new Error('SSH private key not found for session'); }
            await connectSessionToTunnel(transport, session, ci, () => void this.reconnect(session.id));
            // These awaits can run tens of seconds against a dead node; a job that ended meanwhile gets no local port.
            if (isTerminal(statusOf(session))) { throw new Error('the job ended'); }
            await syncSshConfig();
            return true;
        }
        catch (error) {
            logger.error(`Error connecting the ${transport.label} for session ${session.id}:`, error);
            await disposeTunnelClient(session.id);
            if (session.connectionInfo) { session.connectionInfo.localPort = undefined; }
            setError(session, `Failed to connect ${transport.label}: ${errMsg(error)}`);
            return false;
        }
        finally {
            live.connecting.delete(session.id);
        }
    }

    // Auto-recover a half-open Dev Tunnel: rebuild Step 2 while the session is still reachable. connect's own guard blocks re-entry.
    private async reconnect(sessionId: string): Promise<void> {
        const session = getSession(sessionId);
        if (!session || !isReachable(statusOf(session))) { return; }
        this.warn(session, `Dev Tunnel half-open — rebuilding it.`);
        await this.connect(session);
    }

    remove(session: SlurmSession): Promise<void> { return this.transports.remove(session); }

    async tick(session: SlurmSession): Promise<void> {
        const status = statusOf(session);
        const transport = this.transports.transportFor(session);
        // Job running but not yet up: drive bring-up over the Dev Tunnel rather than Slurm,
        // cross-checking sacct only after PROBE_GIVEUP failures, so a running session
        // never SSH-polls the SSH host.
        if (status === 'preparing' && transport.tunnelRef(session) && session.connectionInfo?.controlPort) {
            await this.pingOrCrossCheck(session, () => this.prepareRemote(session));
            return;
        }

        if (transport.tunnelRef(session) && isReachable(status)) {
            // Pulling /usage is the health check: success = alive + a live sample; PROBE_GIVEUP failures
            // cross-check sacct for death. The sample comes over the Dev Tunnel when this window holds its client, else srun.
            await this.pingOrCrossCheck(session, async () => {
                try {
                    const m = await this.pullSample(session);
                    this.probeFailedCounts.delete(session.id);
                    setError(session, ''); // samples go to the per-session runs file, not the record
                    if (m.memBytes !== undefined) { appendSample(session.id, { ...m, atMs: Date.now() }); }
                    void this.refreshStats(session);
                }
                catch (err) {
                    if (isReachable(statusOf(session))) {
                        const attempt = this.bumpProbeFails(session.id);
                        this.warn(session, `healthcheck (usage): failed (attempt ${attempt}/${PROBE_GIVEUP}): ${errMsg(err)}`);
                    }
                }
            });
            return;
        }

        const { status: slurmStatus, elapsedSeconds } = await getSlurmJobStatus(session);
        this.log(session, `healthcheck (Slurm): status=${slurmStatus}`);

        // Anchor the walltime countdown to Slurm's reported elapsed run-time, not the poll time.
        if (slurmStatus === SlurmJobStatus.RUNNING && !session.startedAt) { patch(session, { startedAt: Date.now() - elapsedSeconds * 1000 }); }

        // Pre-running states (queued/unreachable): sacct is the reading. RUNNING makes the session 'preparing', after
        // which the Dev Tunnel branch above takes over — no more SSH host polls.
        if (slurmStatus === SlurmJobStatus.UNKNOWN) { this.warn(session, `job status=${slurmStatus}`); }
        observe(session, slurmStatus);
    }

    // A failed stop may leave the job alive, so it frees only the local port and keeps the refs for reattach; the run is
    // released either way, killing its tokens.
    async end(session: SlurmSession): Promise<void> {
        const transport = this.transports.transportFor(session);
        await (statusOf(session) === 'stopped' ? disconnectSessionFromTunnel(transport, session) : disposeTunnelClient(session.id))
            .catch(err => logger.error(`Session ${session.name}: Failed to disconnect from its ${transport.label}:`, err));
        await transport.release(session);
        void recordSessionRun(session);
    }

    // Dev Tunnel health gave up — only an authoritative sacct terminal state may tear the session down; else it's alive, resume pinging.
    private async crossCheckSlurmForDeath(session: SlurmSession): Promise<void> {
        try {
            observe(session, (await getSlurmJobStatus(session)).status);
            if (!isTerminal(statusOf(session))) { this.probeFailedCounts.delete(session.id); }
        }
        catch (err) {
            this.warn(session, `healthcheck (Slurm): unreachable (will retry): ${errMsg(err)}`);
        }
    }

    // Probe over the Dev Tunnel until PROBE_GIVEUP consecutive failures, then fall back
    // to an authoritative sacct cross-check. The probe differs by phase.
    private async pingOrCrossCheck(session: SlurmSession, probe: () => Promise<void>): Promise<void> {
        if (this.probeFails(session.id) < PROBE_GIVEUP) { await probe(); }
        else { await this.crossCheckSlurmForDeath(session); }
    }

    // Drives a running session to ready_to_connect. Awaited under tick()'s reentrancy
    // guard, so it needs no in-flight guard of its own.
    private async prepareRemote(session: SlurmSession): Promise<void> {
        try {
            const transport = this.transports.transportFor(session);
            await ensureRemoteSession(transport, session); // also refreshes the tunnel
            await transport.withLinkspan(session, getHealth); // a reused sshd port proves nothing; Linkspan must answer
            this.probeFailedCounts.delete(session.id); // Step 1 up — clear the prepare-failure tally
            this.log(session, 'Linkspan is ready to connect.');
            setError(session, ''); // clear any transient-retry warning
        }
        catch (err) {
            // Linkspan not up yet, or a Dev Tunnels API blip: transient rather than job death, so
            // hold 'preparing' and count it toward the sacct cross-check.
            this.bumpProbeFails(session.id);
            if (err instanceof PlaneError && err.code === 'session_access_unavailable') { this.log(session, `waiting for Linkspan's link to cs-plane`); return; }
            this.warn(session, `Linkspan unreachable (will retry): ${errMsg(err)}`);
            setError(session, `Preparing remote session: ${errMsg(err)}`);
        }
    }

    private pullSample(session: SlurmSession): Promise<UsageSample> {
        if (!isTunnelClientConnected(session.id)) { return getSampleViaSrun(session); }
        return this.transports.transportFor(session).withLinkspan(session, getSample);
    }

    // Throttled sacct refresh, fire-and-forget from the health path (sacctStats swallows its own errors).
    private async refreshStats(session: SlurmSession): Promise<void> {
        const now = Date.now(), last = this.lastSacctAt.get(session.id);
        if (last !== undefined && now - last < SACCT_REFRESH_MS) { return; }
        this.lastSacctAt.set(session.id, now);
        const m = await sacctStats(session);
        if (m) { writeSessionStats(session.id, m); }
    }
}

export async function prepareLaunch(session: SlurmSession, transport: Transport): Promise<LaunchDraft> {
    // Fresh connection info with this run's control port pinned before transport.prepare: that call is what puts the port
    // on the Dev Tunnel, and the job's Dev Tunnel host has to find it already there.
    // Trade-off: random high port; ~1/12000 collision on a shared compute node (Linkspan log.Fatals if taken, session then fails) — probe a free port on the node if it ever bites.
    const ci = session.connectionInfo = { sshPort: 0, controlPort: 20000 + Math.floor(Math.random() * 12000) };
    resetLive(session.id); // clear the prior run's live samples + stats, keep the run history

    const launch = await transport.prepare(session, ci);

    let script: string;
    try { script = buildSlurmScript(session, launch, ci.controlPort); }
    catch (err) { throw new Error(`Failed to generate Slurm script: ${errMsg(err)}`, { cause: err }); }

    setError(session, '');
    return { script, sbatchEnv: launch.sbatchEnv };
}
