import { UsageSample, POLLING_INTERVAL_MS, SlurmJobStatus, SlurmSession, SessionStatus as Status } from '../models';
import { Logger, errMsg } from './../logger';
import { PlaneError } from '../plane';
import { updateSession, observe, fail, statusOf, live } from '../extensionStore';
import { recordSessionRun, sacctStats } from '../sessionRunSupport';
import { SshManager } from './sshSupport';
import { getSampleViaSrun, getSlurmJobStatus } from './slurmSupport';
import { buildSlurmScript } from './slurmParse';
import { isReachable, isTerminal } from './sessionMachine';
import { checkSlurmAvailability, linkspanIsUpToDate, installLinkspan, submitJobToSlurm } from './slurmLaunch';
import { Transport, disconnectSessionFromTunnel, disposeTunnelClient, ensureRemoteSession, isTunnelClientConnected } from './transport';
import { getHealth, getSample } from './linkspanSupport';
import { appendSample, writeSessionStats, resetLive } from './runStore';

const logger = Logger.getInstance();
// How often to refresh the in-run sacct copy; coarse since usage only flushes at step end.
const SACCT_REFRESH_MS = 30_000;
// Consecutive failed probes before we stop trusting the Dev Tunnel and cross-check the job over batch sacct.
const PROBE_GIVEUP = 6;

// One independent poll loop per active session. No shared lock: each loop mutates
// only its own session and updateSession is synchronous, so ticks never race.
const sessionLine = (name: string, msg: string): string => `Session ${name}: ${msg}`;

// What the monitor polls and tears down for an EC2 session (ec2Session.ts); a Slurm job is this class's own code.
export interface Backend {
    tick(session: SlurmSession): Promise<void>;
    end(session: SlurmSession): Promise<void>;
}

export class SessionMonitor {
    private sessions = new Map<string, SlurmSession>();
    private tickers = new Map<string, ReturnType<typeof setInterval>>();
    private ticking = new Set<string>(); // per-session reentrancy guard: a slow tick must not overlap its next fire
    private probeFailedCounts = new Map<string, number>();
    private lastSacctAt = new Map<string, number>(); // throttles the in-run sacct refresh, per session

    constructor(private readonly transportFor: (session: SlurmSession) => Transport, private readonly ec2: Backend) { }

    private log(session: SlurmSession, msg: string): void { logger.info(sessionLine(session.name, msg)); }
    private warn(session: SlurmSession, msg: string): void { logger.warn(sessionLine(session.name, msg)); }

    private probeFails(id: string): number { return this.probeFailedCounts.get(id) ?? 0; }
    private bumpProbeFails(id: string): number { const n = this.probeFails(id) + 1; this.probeFailedCounts.set(id, n); return n; }

    // Teardown for a Stop and for a job that ended on its own. A failed stop may leave the job alive, so it frees only
    // the local port and keeps the refs for reattach; the run is released either way, killing its tokens.
    async endSession(session: SlurmSession): Promise<void> {
        this.stopMonitoring(session.id);
        if (session.ec2) { return this.ec2.end(session); }
        const transport = this.transportFor(session);
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
            const transport = this.transportFor(session);
            await ensureRemoteSession(transport, session); // also refreshes the tunnel
            await transport.withLinkspan(session, getHealth); // a reused sshd port proves nothing; Linkspan must answer
            this.probeFailedCounts.delete(session.id); // Step 1 up — clear the prepare-failure tally
            this.log(session, 'Linkspan is ready to connect.');
            if (session.errorMessage) { session.errorMessage = ''; updateSession(session); } // clear any transient-retry warning
        }
        catch (err) {
            // Linkspan not up yet, or a Dev Tunnels API blip: transient rather than job death, so
            // hold 'preparing' and count it toward the sacct cross-check.
            this.bumpProbeFails(session.id);
            if (err instanceof PlaneError && err.code === 'session_access_unavailable') { this.log(session, `waiting for Linkspan's link to cs-plane`); return; }
            this.warn(session, `Linkspan unreachable (will retry): ${errMsg(err)}`);
            session.errorMessage = `Preparing remote session: ${errMsg(err)}`;
            updateSession(session);
        }
    }

    // One independent poll for a single session. Reentrancy-guarded so a slow tick never overlaps its own next fire.
    private async tick(sessionId: string): Promise<void> {
        const session = this.sessions.get(sessionId);
        if (!session || this.ticking.has(sessionId)) { return; }
        this.ticking.add(sessionId);
        try {
            const status = statusOf(session);
            if (isTerminal(status)) {
                void this.endSession(session);
                return;
            }

            if (session.ec2) { await this.ec2.tick(session); }
            else { await this.slurmTick(session, status); }
            if (live.unreachable.delete(session.id)) { session.errorMessage = ''; updateSession(session); }
            if (isTerminal(statusOf(session))) { void this.endSession(session); }
        }
        catch (error) {
            // SSH host unreachable (dead ControlMaster, Duo-needed under BatchMode) or the AWS API down — not death; stay recoverable.
            const label = session.ec2 ? 'AWS' : 'SSH host';
            this.warn(session, `${label} unreachable (will retry): ${errMsg(error)}`);
            live.unreachable.add(session.id);
            const message = `${label} unreachable: ${errMsg(error)}`;
            if (session.errorMessage !== message) { session.errorMessage = message; updateSession(session); }
        }
        finally {
            this.ticking.delete(sessionId);
        }
    }

    private async slurmTick(session: SlurmSession, status: Status): Promise<void> {
        // Job running but not yet up: drive bring-up over the Dev Tunnel rather than Slurm,
        // cross-checking sacct only after PROBE_GIVEUP failures, so a running session
        // never SSH-polls the SSH host.
        if (status === 'preparing' && this.transportFor(session).tunnelRef(session) && (session.connectionInfo?.controlPort ?? 0) > 0) {
            await this.pingOrCrossCheck(session, () => this.prepareRemote(session));
            return;
        }

        if (this.transportFor(session).tunnelRef(session) && isReachable(status)) {
            // Pulling /usage is the health check: success = alive + a live sample; PROBE_GIVEUP failures
            // cross-check sacct for death. The sample comes over the Dev Tunnel when this window holds its client, else srun.
            await this.pingOrCrossCheck(session, async () => {
                try {
                    const m = await this.pullSample(session);
                    this.probeFailedCounts.delete(session.id);
                    // Samples go to the per-session runs file; only write the record when a persisted field changes.
                    if (session.errorMessage) { session.errorMessage = ''; updateSession(session); }
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
        if (slurmStatus === SlurmJobStatus.RUNNING && !session.startedAt) {
            session.startedAt = Date.now() - elapsedSeconds * 1000;
            updateSession(session);
        }

        // Pre-running states (queued/unreachable): sacct is the reading. RUNNING makes the session 'preparing', after
        // which the Dev Tunnel branch above takes over — no more SSH host polls.
        if (slurmStatus === SlurmJobStatus.UNKNOWN) { this.warn(session, `job status=${slurmStatus}`); }
        observe(session, slurmStatus);
    }

    private pullSample(session: SlurmSession): Promise<UsageSample> {
        if (!isTunnelClientConnected(session.id)) { return getSampleViaSrun(session); }
        return this.transportFor(session).withLinkspan(session, getSample);
    }

    // Throttled sacct refresh, fire-and-forget from the health path (sacctStats swallows its own errors).
    private async refreshStats(session: SlurmSession): Promise<void> {
        const now = Date.now();
        if (now - (this.lastSacctAt.get(session.id) ?? 0) < SACCT_REFRESH_MS) { return; }
        this.lastSacctAt.set(session.id, now);
        const m = await sacctStats(session);
        if (m) { writeSessionStats(session.id, m); }
    }

    // Begin an independent poll loop for one active session (no-op if already running or not yet launched). The first
    // poll fires now so status isn't stale for a full interval; the rest run on the interval.
    public startMonitoring(session: SlurmSession): void {
        if (!session.jobId || this.tickers.has(session.id)) { return; }
        this.sessions.set(session.id, session);
        this.tickers.set(session.id, setInterval(() => void this.tick(session.id), POLLING_INTERVAL_MS));
        this.log(session, `monitoring started (JobId=${session.jobId})`);
        void this.tick(session.id);
    }

    // Stop and forget one session's loop.
    public stopMonitoring(sessionId: string): void {
        const name = this.sessions.get(sessionId)?.name ?? sessionId;
        const ticker = this.tickers.get(sessionId);
        if (ticker) { clearInterval(ticker); }
        this.tickers.delete(sessionId);
        this.sessions.delete(sessionId);
        this.ticking.delete(sessionId);
        live.unreachable.delete(sessionId);
        this.probeFailedCounts.delete(sessionId);
        this.lastSacctAt.delete(sessionId);
        logger.info(sessionLine(name, `monitoring stopped.`));
    }

    // Tear down every loop (window close).
    public dispose(): void {
        for (const id of [...this.tickers.keys()]) { this.stopMonitoring(id); }
    }
}

export async function prepareLaunch(session: SlurmSession, transport: Transport): Promise<Record<string, string>> {
    // Fresh connection info with this run's control port pinned before transport.prepare: that call is what puts the port
    // on the Dev Tunnel, and the job's Dev Tunnel host has to find it already there.
    // Trade-off: random high port; ~1/12000 collision on a shared compute node (Linkspan log.Fatals if taken, session then fails) — probe a free port on the node if it ever bites.
    session.connectionInfo = { sshPort: 0, controlPort: 20000 + Math.floor(Math.random() * 12000) };
    resetLive(session.id); // clear the prior run's live samples + stats, keep the run history

    const launch = await transport.prepare(session);

    try { session.jobScript = buildSlurmScript(session, launch); }
    catch (err) { throw new Error(`Failed to generate Slurm script: ${errMsg(err)}`, { cause: err }); }

    session.errorMessage = '';
    updateSession(session);
    return launch.sbatchEnv;
}

export async function launchSession(session: SlurmSession, monitor: SessionMonitor, sbatchEnv: Record<string, string>): Promise<void> {
    logger.info(sessionLine(session.name, `initiating launch`));
    const run = SshManager.getInstance();
    await checkSlurmAvailability(session, run, logger);
    if (!await linkspanIsUpToDate(session, run, logger)) {
        await installLinkspan(session, run, logger);
    }
    await submitJobToSlurm(session, run, logger, sbatchEnv);
    monitor.startMonitoring(session);
}

export async function stopSession(session: SlurmSession, monitor: SessionMonitor): Promise<void> {
    logger.info(sessionLine(session.name, `stopping`));

    let stopError: Error | undefined;
    try {
        if (session.jobId) {
            const stopCommand = `scancel ${session.jobId}`;
            logger.info(sessionLine(session.name, `sending stop command: ${stopCommand}`));
            const stopResult = await SshManager.getInstance().runRemoteCommand(session.alias, stopCommand);
            // scancel accepted is the job's end, as sacct will report it; refused, sacct says whether it had ended anyway.
            observe(session, stopResult.code === 0 ? SlurmJobStatus.CANCELLED : await getSlurmJobStatus(session).then(r => r.status, () => SlurmJobStatus.UNKNOWN));
            if (!isTerminal(statusOf(session))) {
                throw new Error(`Session ${session.name}: failed to send stop command: ${stopResult.stderr}`);
            }
            logger.info(sessionLine(session.name, stopResult.code === 0 ? `stop command sent successfully` : `job already ended`));
        }
        else {
            logger.warn(sessionLine(session.name, `has no job ID; marking stopped without scancel.`));
        }
    }
    catch (error) {
        stopError = error instanceof Error ? error : new Error(String(error));
        logger.error(`Session ${session.name}: Error while stopping:`, error);
        fail(session, stopError.message);
    }

    await monitor.endSession(session);
    if (stopError) { throw stopError; }
}
