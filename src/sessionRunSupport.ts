import { SshManager } from './modules/sshSupport';
import { parseSacctUtil } from './modules/slurmParse';
import { readSessionRuns, readRecentSamples, readSessionStats, appendRun, isSameRun } from './modules/runStore';
import { getSession, statusOf } from './extensionStore';
import { RunStats, SlurmSession } from './models';
import { sleep } from './modules/util';

const SACCT = 'sacct -P -n --units=K --format=JobID,AllocCPUs,ReqMem,ElapsedRaw,CPUTimeRAW,MaxRSS,TotalCPU -j';
// slurmdbd flushes step usage a beat after the job ends, so re-query until MaxRSS lands before freezing the record.
const STATS_RETRIES = 2;
const STATS_RETRY_MS = 3000;

export async function recordSessionRun(session: SlurmSession): Promise<void> {
    if (readSessionRuns(session.id).some(r => isSameRun(r, session))) { return; }
    // Captured before the sacct wait: a restart meanwhile would change the job and reset the live samples and stats.
    const { id: sessionId, alias, jobId, account, partition, startedAt } = session;
    const run = { sessionId, alias, jobId, account, partition, startedAt, endedAt: Date.now(), finalState: statusOf(session), samples: readRecentSamples(session.id) };
    const inRun = readSessionStats(session.id);
    const stats = await fetchStats(run) ?? inRun;
    if (getSession(sessionId)) { appendRun({ ...run, stats }); } // a session deleted during the wait keeps no runs file
}

async function fetchStats(job: Pick<SlurmSession, 'alias' | 'jobId'>): Promise<RunStats | undefined> {
    for (let attempt = 0; ; attempt++) {
        const m = await sacctStats(job);
        if ((m && m.maxRss !== undefined) || attempt >= STATS_RETRIES) { return m; }
        await sleep(STATS_RETRY_MS);
    }
}

// One sacct read (no flush-retry) — the monitor calls this during a run to keep the live Slurm accounting copy non-stale.
export async function sacctStats({ alias, jobId }: Pick<SlurmSession, 'alias' | 'jobId'>): Promise<RunStats | undefined> {
    try {
        const m = parseSacctUtil(await SshManager.getInstance().runRemoteCommand(alias, `${SACCT} ${jobId} 2>/dev/null`, { batch: true }));
        return Object.keys(m).length ? m : undefined;
    }
    catch { return undefined; }
}
