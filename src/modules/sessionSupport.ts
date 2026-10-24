import { ConnectionInfo, Ec2Session, UsageSample, POLLING_INTERVAL_MS, SlurmJobStatus, SlurmSession, isEc2 } from '../models';
import { Logger, errMsg } from './../logger';
import { PlaneError } from '../plane';
import { getSession, patch, setError, observe, statusOf, live, claim, owns, disown } from '../extensionStore';
import { recordSessionRun, sacctStats } from '../sessionRunSupport';
import { SshManager, deleteSessionPrivateKey, hasSessionKey, syncSshConfig } from './sshSupport';
import { getSampleViaSrun, getSlurmJobStatus } from './slurmSupport';
import { buildSlurmScript } from './slurmParse';
import { isReachable, isTerminal } from './sessionMachine';
import { checkSlurmAvailability, linkspanIsUpToDate, installLinkspan, submitJobToSlurm, LaunchDraft } from './slurmLaunch';
import { Transport, Transports, connectSessionToTunnel, disconnectSessionFromTunnel, disposeTunnelClient, ensureRemoteSession, isTunnelClientConnected } from './transport';
import { getSample } from './linkspanSupport';
import { appendSample, writeSessionStats, resetLive } from './runStore';
import { getOrSet } from './util';

const logger = Logger.getInstance();
// How often to refresh the in-run sacct copy; coarse since usage only flushes at step end.
const SACCT_REFRESH_MS = 30_000;
// Consecutive failed probes before we stop trusting the tunnel and cross-check the job over batch sacct.
const PROBE_GIVEUP = 6;

const sessionLine = (name: string, msg: string): string => `Session ${name}: ${msg}`;

// What drives a session's remote side: the Slurm job (SlurmBackend) or an EC2 instance (ec2Session.ts). The provider
// stops, connects and removes through it; the monitor ticks and ends through it. Starting differs per backend.
export interface Backend<S extends SlurmSession = SlurmSession> {
    readonly label: string; // what an unreachable poll names
    stop(session: S): Promise<void>;
    connect(session: S): Promise<boolean>;
    remove(session: S): Promise<void>;
    tick(session: S, alive: () => boolean): Promise<void>; // alive: the loop still wants this tick's writes
    end(session: S): Promise<void>;
    forget(sessionId: string): void;
}

// Routes a lifecycle call to the record's backend.
export class Backends {
    constructor(private readonly slurm: Backend, private readonly ec2: Backend<Ec2Session>) { }

    use<R>(session: SlurmSession, call: <S extends SlurmSession>(backend: Backend<S>, session: S) => R): R {
        return isEc2(session) ? call(this.ec2, session) : call(this.slurm, session);
    }
}

// One independent poll loop per active session. No shared lock: each loop mutates
// only its own session and a patch applies synchronously, so ticks never race.
interface Loop { session: SlurmSession; timer: ReturnType<typeof setInterval>; ticking: boolean }
export class SessionMonitor {
    private loops = new Map<string, Loop>();
    private ending = new Map<string, Promise<void>>(); // each session's teardown while it runs

    constructor(private readonly backends: Backends) { }

    // Teardown for a Stop and for a backend that ended on its own; one in flight is the teardown, not restarted. It is
    // registered before the loop stops, since stopping the loop writes the record and a sweep on that write ends again.
    endSession(session: SlurmSession): Promise<void> {
        const inFlight = this.ending.get(session.id);
        if (inFlight) { this.stopMonitoring(session.id); return inFlight; } // a loop begun during the teardown ends with it
        const { promise, resolve, reject } = Promise.withResolvers<void>();
        this.ending.set(session.id, promise);
        void promise.finally(() => { if (this.ending.get(session.id) === promise) { this.ending.delete(session.id); } });
        this.stopMonitoring(session.id);
        this.backends.use(session, (b, s) => b.end(s)).then(resolve, reject);
        return promise;
    }

    // Resolves once the session has no loop and no teardown in flight, so what follows is not undone by either.
    async quiesce(session: SlurmSession): Promise<void> {
        if (this.loops.has(session.id)) { await this.endSession(session); }
        else { await this.ending.get(session.id); }
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

            const alive = () => this.loops.get(sessionId) === loop;
            await this.backends.use(session, (b, s) => b.tick(s, alive));
            if (!alive()) { return; } // a Stop ended the loop meanwhile
            if (live.unreachable.delete(session.id)) { setError(session, ''); }
            if (isTerminal(statusOf(session))) { void this.endSession(session); }
        }
        catch (error) {
            if (this.loops.get(sessionId) !== loop) { return; }
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

    public monitoring(sessionId: string): boolean { return this.loops.has(sessionId); }

    private stopMonitoring(sessionId: string): void {
        const loop = this.loops.get(sessionId);
        if (!loop) { return; }
        clearInterval(loop.timer);
        this.loops.delete(sessionId);
        live.unreachable.delete(sessionId);
        disown(loop.session);
        this.backends.use(loop.session, b => b.forget(sessionId));
        logger.info(sessionLine(loop.session.name, `monitoring stopped.`));
    }

    public dispose(): void {
        for (const id of [...this.loops.keys()]) { this.stopMonitoring(id); }
    }
}

interface Tally { probeFails: number; sacctAt?: number }
export class SlurmBackend implements Backend {
    readonly label = 'SSH host';
    private runs = new Map<string, Tally>(); // this window's tallies per session

    // The monitor is built with this backend, so it arrives lazily.
    constructor(private readonly transports: Transports, private readonly monitor: () => SessionMonitor) { }

    private log(session: SlurmSession, msg: string): void { logger.info(sessionLine(session.name, msg)); }
    private warn(session: SlurmSession, msg: string): void { logger.warn(sessionLine(session.name, msg)); }

    private run(id: string) { return getOrSet(this.runs, id, (): Tally => ({ probeFails: 0 })); }

    forget(sessionId: string): void { this.runs.delete(sessionId); }

    async start(session: SlurmSession, draft: LaunchDraft): Promise<void> {
        this.log(session, `initiating launch`);
        const run = SshManager.getInstance();
        await checkSlurmAvailability(session, run, logger);
        if (!await linkspanIsUpToDate(session, run, logger)) {
            await installLinkspan(session, run, logger);
        }
        patch(session, { jobId: await submitJobToSlurm(session, run, logger, draft), connectionInfo: draft.connectionInfo, submittedAt: Date.now() });
        this.monitor().startMonitoring(session);
    }

    // Throws when the job is still running after a refused scancel; the caller then leaves the session as it was.
    async stop(session: SlurmSession): Promise<void> {
        const stopCommand = `scancel ${session.jobId}`;
        this.log(session, `sending stop command: ${stopCommand}`);
        try {
            await SshManager.getInstance().runRemoteCommand(session.alias, stopCommand); // a Stop is the user's, so the owner window may authenticate for it
            observe(session, SlurmJobStatus.CANCELLED);
            this.log(session, `stop command sent successfully`);
        }
        catch (err) {
            const read = await getSlurmJobStatus(session).catch(() => undefined); // it may have ended anyway
            if (read) { observe(session, read.status); }
            if (!isTerminal(statusOf(session))) { throw new Error(`failed to send stop command: ${errMsg(err)}`, { cause: err }); }
            this.log(session, `job already ended`);
        }
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
            if (!hasSessionKey(session.id)) { throw new Error('SSH private key not found for session'); }
            const ci = await ensureRemoteSession(transport, session); // idempotent; refreshes tunnel creds for reattach
            // These awaits can run tens of seconds against a dead node; a job that ended meanwhile gets no connection info written.
            if (isTerminal(statusOf(session))) { throw new Error('the job ended'); }
            patch(session, { connectionInfo: ci });
            await connectSessionToTunnel(transport, session, ci, () => void this.reconnect(session.id));
            if (isTerminal(statusOf(session))) { throw new Error('the job ended'); }
            await syncSshConfig();
            return true;
        }
        catch (error) {
            logger.error(`Error connecting the ${transport.label} for session ${session.id}:`, error);
            await disposeTunnelClient(session.id);
            if (session.connectionInfo) { patch(session, { connectionInfo: { ...session.connectionInfo, localPort: undefined } }); }
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

    async remove(session: SlurmSession): Promise<void> {
        await this.transports.remove(session);
        deleteSessionPrivateKey(session.id);
    }

    async tick(session: SlurmSession, alive: () => boolean): Promise<void> {
        const status = statusOf(session);
        const transport = this.transports.transportFor(session);
        // Job running but not yet up: drive bring-up over the tunnel rather than Slurm,
        // cross-checking sacct only after PROBE_GIVEUP failures.
        if (status === 'preparing' && transport.tunnelRef(session) && session.connectionInfo?.controlPort) {
            await this.pingOrCrossCheck(session, alive, () => this.prepareRemote(session, alive));
            return;
        }

        const ci = session.connectionInfo;
        if (transport.tunnelRef(session) && isReachable(status) && ci) {
            // Pulling /usage is the health check: success = alive + a live sample; PROBE_GIVEUP failures
            // cross-check sacct for death. The sample comes over the tunnel when this window holds its client, else srun.
            await this.pingOrCrossCheck(session, alive, async () => {
                try {
                    const m = await this.pullSample(session, ci);
                    if (!alive()) { return; }
                    this.run(session.id).probeFails = 0;
                    setError(session, ''); // samples go to the per-session runs file, not the record
                    if (m.memBytes !== undefined) { appendSample(session.id, { ...m, atMs: Date.now() }); }
                    void this.refreshStats(session, alive);
                }
                catch (err) {
                    if (alive() && isReachable(statusOf(session))) {
                        const attempt = ++this.run(session.id).probeFails;
                        this.warn(session, `healthcheck (usage): failed (attempt ${attempt}/${PROBE_GIVEUP}): ${errMsg(err)}`);
                    }
                }
            });
            return;
        }

        const { status: slurmStatus, elapsedSeconds } = await getSlurmJobStatus(session);
        if (!alive()) { return; }
        this.log(session, `healthcheck (Slurm): status=${slurmStatus}`);

        // Anchor the walltime countdown to Slurm's reported elapsed run-time, not the poll time.
        if (slurmStatus === SlurmJobStatus.RUNNING && !session.startedAt) { patch(session, { startedAt: Date.now() - elapsedSeconds * 1000 }); }

        // Pre-running states (queued/unreachable): sacct is the reading. RUNNING makes the session 'preparing', after
        // which the tunnel branches above take over.
        if (slurmStatus === SlurmJobStatus.UNKNOWN) { this.warn(session, `job status=${slurmStatus}`); }
        observe(session, slurmStatus);
    }

    async end(session: SlurmSession): Promise<void> {
        void recordSessionRun(session); // before the release, which a Start could overtake
        const transport = this.transports.transportFor(session);
        await disconnectSessionFromTunnel(transport, session)
            .catch(err => logger.error(`Session ${session.name}: Failed to disconnect from its ${transport.label}:`, err));
        await transport.release(session);
    }

    // Tunnel health gave up — only an authoritative sacct terminal state may tear the session down; else it's alive, resume pinging.
    private async crossCheckSlurmForDeath(session: SlurmSession, alive: () => boolean): Promise<void> {
        try {
            const { status } = await getSlurmJobStatus(session);
            if (!alive()) { return; }
            observe(session, status);
            if (!isTerminal(statusOf(session))) { this.run(session.id).probeFails = 0; }
        }
        catch (err) {
            if (alive()) { this.warn(session, `healthcheck (Slurm): unreachable (will retry): ${errMsg(err)}`); }
        }
    }

    // Probe over the tunnel until PROBE_GIVEUP consecutive failures, then fall back
    // to an authoritative sacct cross-check. The probe differs by phase.
    private async pingOrCrossCheck(session: SlurmSession, alive: () => boolean, probe: () => Promise<void>): Promise<void> {
        if (this.run(session.id).probeFails < PROBE_GIVEUP) { await probe(); }
        else { await this.crossCheckSlurmForDeath(session, alive); }
    }

    // Drives a running session to ready_to_connect. Awaited under tick()'s reentrancy
    // guard, so it needs no in-flight guard of its own.
    private async prepareRemote(session: SlurmSession, alive: () => boolean): Promise<void> {
        try {
            const transport = this.transports.transportFor(session);
            const ci = await ensureRemoteSession(transport, session); // Linkspan answered, so it is up; also refreshes the tunnel
            if (!alive()) { return; }
            patch(session, { connectionInfo: ci });
            this.run(session.id).probeFails = 0;
            this.log(session, 'Linkspan is ready to connect.');
            setError(session, ''); // clear any transient-retry warning
        }
        catch (err) {
            if (!alive()) { return; }
            // Linkspan not up yet, or a tunnel API blip: transient rather than job death, so
            // hold 'preparing' and count it toward the sacct cross-check.
            this.run(session.id).probeFails++;
            if (err instanceof PlaneError && err.code === 'session_access_unavailable') { this.log(session, `waiting for Linkspan's link to cs-plane`); return; }
            this.warn(session, `Linkspan unreachable (will retry): ${errMsg(err)}`);
            setError(session, `Preparing remote session: ${errMsg(err)}`);
        }
    }

    private pullSample(session: SlurmSession, ci: ConnectionInfo): Promise<UsageSample> {
        if (!isTunnelClientConnected(session.id)) { return getSampleViaSrun(session, ci.controlPort); }
        return this.transports.transportFor(session).withLinkspan(session, ci, getSample);
    }

    // Throttled sacct refresh, fire-and-forget from the health path (sacctStats swallows its own errors).
    private async refreshStats(session: SlurmSession, alive: () => boolean): Promise<void> {
        const now = Date.now(), run = this.run(session.id);
        if (run.sacctAt !== undefined && now - run.sacctAt < SACCT_REFRESH_MS) { return; }
        run.sacctAt = now;
        const m = await sacctStats(session);
        if (m && alive()) { writeSessionStats(session.id, m); }
    }
}

export async function prepareLaunch(session: SlurmSession, transport: Transport): Promise<LaunchDraft> {
    // Fresh connection info with a control port picked before transport.prepare, which puts it on the Dev Tunnel for the
    // job's host to find, or replaces it with cs-plane's for link.
    // Trade-off: random high port; ~1/12000 collision on a shared compute node (Linkspan log.Fatals if taken, session then fails) — probe a free port on the node if it ever bites.
    const ci: ConnectionInfo = { sshPort: 0, controlPort: 20000 + Math.floor(Math.random() * 12000) };
    resetLive(session.id);

    const launch = await transport.prepare(session, ci);
    setError(session, '');
    return { script: buildSlurmScript(session, launch, ci.controlPort), sbatchEnv: launch.sbatchEnv, connectionInfo: ci };
}
