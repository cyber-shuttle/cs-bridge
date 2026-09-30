import * as fs from 'fs';
import * as path from 'path';
import { UsageSample, SAMPLE_HISTORY_LEN, RunStats, Run, RunsFile } from '../models';
import { readJson, lockedUpdateJson, deleteFile, jsonFiles } from './fsSupport';
import { CS_HOME } from './schema';

// One file per session: runs/{id}.json = { runs, samples, stats } — finished-run history, live samples, live sacct
// copy, each written independently. Per-file locked, so writes never contend across sessions.
const RUNS_DIR = path.join(CS_HOME, 'runs');
const filePath = (id: string): string => path.join(RUNS_DIR, `${id}.json`);
const RUNS_PER_SESSION = 10;

export const isSameRun = (a: Pick<Run, 'alias' | 'jobId'>, b: Pick<Run, 'alias' | 'jobId'>): boolean =>
    a.alias === b.alias && a.jobId === b.jobId;
const read = (id: string): RunsFile => readJson<RunsFile>(filePath(id)) ?? {};
const sessionIds = (): string[] => jsonFiles(RUNS_DIR).map(n => n.slice(0, -'.json'.length));

// fn returns null to skip the write.
const mutate = (id: string, fn: (cur: RunsFile) => RunsFile | null, onError?: (err: unknown) => void): void => {
    fs.mkdirSync(RUNS_DIR, { recursive: true });
    lockedUpdateJson<RunsFile>(filePath(id), cur => fn(cur ?? {}), onError);
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
    return sessionIds().flatMap(id => read(id).runs ?? []).sort((a, b) => b.endedAt - a.endedAt);
}

// Deduped by alias+jobId, newest-first, capped. null → already recorded.
export function mergeRun(existing: Run[], record: Run): Run[] | null {
    if (existing.some(r => isSameRun(r, record))) { return null; }
    return [record, ...existing].sort((a, b) => b.endedAt - a.endedAt).slice(0, RUNS_PER_SESSION);
}

export function appendRun(record: Run, onError?: (err: unknown) => void): void {
    mutate(record.sessionId, (cur) => {
        const runs = mergeRun(cur.runs ?? [], record);
        return runs && { ...cur, runs };
    }, onError);
}

export function clearAllRuns(): void {
    for (const id of sessionIds()) { lockedUpdateJson<RunsFile>(filePath(id), cur => (cur ? { ...cur, runs: [] } : null)); }
}

export function deleteRunsFile(id: string): void {
    deleteFile(filePath(id));
}

export function watchRuns(callback: () => void): fs.FSWatcher {
    fs.mkdirSync(RUNS_DIR, { recursive: true });
    return fs.watch(RUNS_DIR, (_event, name) => { if (!name || name.endsWith('.json')) { callback(); } });
}
