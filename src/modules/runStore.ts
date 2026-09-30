import { UsageSample, SAMPLE_HISTORY_LEN, RunStats, Run, RunsFile } from '../models';
import { Files, JsonDir } from './store';

// One file per session: runs/{id}.json = { runs, samples, stats }, the run history, live samples and live sacct copy.
const RUNS_PER_SESSION = 10;
let runsDir: JsonDir<RunsFile>;

export async function initRunStore(files: Files, onError: (err: unknown) => void) {
    runsDir = new JsonDir<RunsFile>(files, 'runs', onError);
    await runsDir.load();
    return runsDir;
}

export const isSameRun = (a: Pick<Run, 'alias' | 'jobId'>, b: Pick<Run, 'alias' | 'jobId'>): boolean =>
    a.alias === b.alias && a.jobId === b.jobId;
const read = (id: string): RunsFile => runsDir.get(id) ?? {};

// fn returns null to skip the write.
const mutate = (id: string, fn: (cur: RunsFile) => RunsFile | null): void => {
    const next = fn(read(id));
    if (next) { runsDir.set(id, next); }
};

// live samples — append one, capped to the rolling window
export function appendSample(id: string, sample: UsageSample): void {
    mutate(id, cur => ({ ...cur, samples: [...(cur.samples ?? []), sample].slice(-SAMPLE_HISTORY_LEN) }));
}
export const readRecentSamples = (id: string): UsageSample[] => read(id).samples ?? [];

export const writeSessionStats = (id: string, stats: RunStats): void => mutate(id, cur => ({ ...cur, stats }));
export const readSessionStats = (id: string): RunStats | undefined => read(id).stats;

// reset the live block for a fresh run, keeping the run history
export const resetLive = (id: string): void => mutate(id, cur => ({ runs: cur.runs }));

export function readSessionRuns(id: string): Run[] {
    return read(id).runs ?? [];
}

export function readAllRuns(): Run[] {
    return runsDir.values().flatMap(f => f.runs ?? []).sort((a, b) => b.endedAt - a.endedAt);
}

// Deduped by alias+jobId, newest-first, capped. null → already recorded.
export function mergeRun(existing: Run[], record: Run): Run[] | null {
    if (existing.some(r => isSameRun(r, record))) { return null; }
    return [record, ...existing].sort((a, b) => b.endedAt - a.endedAt).slice(0, RUNS_PER_SESSION);
}

export function appendRun(record: Run): void {
    mutate(record.sessionId, (cur) => {
        const runs = mergeRun(cur.runs ?? [], record);
        return runs && { ...cur, runs };
    });
}

export function clearAllRuns(): void {
    for (const [id, cur] of runsDir.entries()) { runsDir.set(id, { ...cur, runs: [] }); }
}

export function deleteRunsFile(id: string): void {
    runsDir.delete(id);
}

export const onRunsChange = (listener: () => void) => runsDir.onDidChange(listener);
