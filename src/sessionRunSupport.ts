import { SshManager } from './modules/sshSupport';
import { parseSacctUtil } from './modules/slurmParse';
import { readSessionRuns, readRecentSamples, readSessionStats, appendRun, isSameRun } from './modules/runStore';
import { statusOf } from './extensionStore';
import { RunStats, Run, SlurmSession } from './models';
import { sleep } from './modules/util';

const SACCT = 'sacct -P -n --units=K --format=JobID,AllocCPUs,ReqMem,ElapsedRaw,CPUTimeRAW,MaxRSS,TotalCPU -j';
// slurmdbd flushes step usage a beat after the job ends, so re-query until MaxRSS lands before freezing the record.
const STATS_RETRIES = 2;
const STATS_RETRY_MS = 3000;

export async function recordSessionRun(session: SlurmSession): Promise<void> {
    if (!session.jobId) { return; }
    if (readSessionRuns(session.id).some(r => isSameRun(r, session))) { return; }
    const stats = await fetchStats(session) ?? readSessionStats(session.id);
    const { id: sessionId, alias, jobId, account, partition } = session;
    const record: Run = { sessionId, alias, jobId, account, partition, endedAt: Date.now(), finalState: statusOf(session), stats, samples: readRecentSamples(session.id) };
    appendRun(record);
}

async function fetchStats(session: SlurmSession): Promise<RunStats | undefined> {
    for (let attempt = 0; ; attempt++) {
        const m = await sacctStats(session);
        if ((m && m.maxRss !== undefined) || attempt >= STATS_RETRIES) { return m; }
        await sleep(STATS_RETRY_MS);
    }
}

// One sacct read (no flush-retry) — the monitor calls this during a run to keep the live Slurm accounting copy non-stale.
export async function sacctStats(session: SlurmSession): Promise<RunStats | undefined> {
    try {
        const m = parseSacctUtil(await SshManager.getInstance().runRemoteCommand(session.alias, `${SACCT} ${session.jobId} 2>/dev/null`, { batch: true }));
        return Object.keys(m).length ? m : undefined;
    }
    catch { return undefined; }
}
