// ~/.cybershuttle keeps one schema version, in schema.json. migrate() runs at activation before any store reads: under
// the tree's lock it applies each step from the version found (none is 0, any release up to 0.2.0) to SCHEMA_VERSION,
// recording the version after each, so the stores read only the current shape. Steps are idempotent, so a crash
// mid-step reruns cleanly; a tree newer than this build is refused. A persisted shape change appends a step here.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { UUID } from 'uuidv7';
import { Run, RunStats, RunsFile, SessionStatus, SlurmSession, UsageSample, persistableConnectionInfo } from '../models';
import { deleteFile, jsonFiles, lock, readJson, release, writeJson } from './fsSupport';
import { gpuTypeOf, slurmAccount } from './slurmParse';

export const CS_HOME = path.join(os.homedir(), '.cybershuttle');

// Pre-schema fields, plus the current ones: a rerun of an interrupted step meets records it already migrated.
interface V0Session extends Partial<Omit<SlurmSession, 'status' | 'connectionInfo'>> {
    id: string;
    status: SessionStatus | 'awaiting_input';
    cluster?: string; queue?: string; allocation?: string; cpus?: number; memory?: string; wallTime?: string;
    gpuClass?: string; workingDirectory?: string; tunnelId?: string; tunnelCluster?: string;
    connectionInfo?: { sshPort?: number; controlPort?: number; apiPort?: number; region?: string };
}
interface V0Stats extends RunStats { reqMem?: string; elapsedSec?: number; memEfficiencyPct?: number }
interface V0Run extends Partial<Omit<Run, 'stats'>> {
    cluster?: string; allocation?: string; queue?: string; finalStatus?: SessionStatus; stats?: V0Stats; metrics?: UsageSample[];
}
interface V0RunsFile { runs?: V0Run[]; metrics?: UsageSample[]; samples?: UsageSample[]; stats?: V0Stats }

const minutes = (hms = '') => { const [h = 0, m = 0, s = 0] = hms.split(':').map(Number); return h * 60 + m + Math.ceil(s / 60); };

// gpuClass was the GRES request, 'gpu:a100:2' or '2'.
function gpu(gpuClass = '') {
    const [, type = '', count] = gpuClass.match(/^(?:(.*):)?(\d+)$/) ?? [];
    return count ? { gpuType: gpuTypeOf(type), gpuCount: Number(count) } : {};
}

function sessionV1(r: V0Session): SlurmSession {
    const ci = r.connectionInfo ?? {};
    const cluster = r.devtunnel?.cluster ?? r.tunnelCluster ?? ci.region ?? '';
    return {
        id: r.id, name: r.name ?? r.id, status: r.status === 'awaiting_input' ? 'not_started' : r.status,
        alias: r.alias ?? r.cluster ?? '', account: r.account ?? slurmAccount(r.allocation), partition: r.partition ?? r.queue ?? '',
        rootFolder: r.rootFolder ?? r.workingDirectory ?? '',
        resources: r.resources ?? { cores: r.cpus ?? 0, memoryMb: Math.round((parseFloat(r.memory ?? '') || 0) * 1024), wallMinutes: minutes(r.wallTime), ...gpu(r.gpuClass) },
        jobId: r.jobId ?? '', submittedAt: r.submittedAt ?? 0, startedAt: r.startedAt, errorMessage: r.errorMessage ?? '', windowPids: r.windowPids,
        transport: r.transport ?? 'devtunnel', planeId: r.planeId,
        devtunnel: r.devtunnel ?? (r.tunnelId ? { id: r.tunnelId, cluster } : undefined),
        connectionInfo: persistableConnectionInfo({ sshPort: ci.sshPort ?? 0, controlPort: ci.controlPort ?? ci.apiPort ?? 0 }),
    };
}

function statsV1(s?: V0Stats): RunStats | undefined {
    if (!s) { return undefined; }
    const { reqMem, elapsedSec, memEfficiencyPct, ...rest } = s;
    return { ...rest, requestedMemory: rest.requestedMemory ?? reqMem, elapsedSeconds: rest.elapsedSeconds ?? elapsedSec, memoryEfficiencyPct: rest.memoryEfficiencyPct ?? memEfficiencyPct };
}

function runsFileV1(f: V0RunsFile): RunsFile {
    return {
        runs: f.runs?.map(r => ({
            sessionId: r.sessionId ?? '', alias: r.alias ?? r.cluster ?? '', jobId: r.jobId ?? '', account: r.account ?? slurmAccount(r.allocation),
            partition: r.partition ?? r.queue ?? '', endedAt: r.endedAt ?? 0, finalState: r.finalState ?? r.finalStatus ?? 'stopped',
            stats: statsV1(r.stats), samples: r.samples ?? r.metrics,
        })),
        samples: f.samples ?? f.metrics,
        stats: statsV1(f.stats),
    };
}

const IS_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A uuidv7 whose time is the record's submit time and whose random bits hash its old id, so ids still sort by creation
// and a rerun reissues the same one.
function reissuedId({ id, submittedAt = 0 }: V0Session): string {
    const hash = createHash('sha256').update(id).digest('hex'), bits = (from: number, to: number) => parseInt(hash.slice(from, to), 16);
    return UUID.fromFieldsV7(submittedAt, bits(0, 3), bits(3, 11) >>> 2, bits(11, 19)).toString();
}

// Pre-schema: sessions.json (to 0.0.4) splits into sessions/, non-uuid ids are reissued, metrics/ becomes runs/, and
// 0.0.3's ssh_hosts file and its ~/.ssh/config Include go.
function v0ToV1(home: string): void {
    const sessionsDir = path.join(home, 'sessions'), metricsDir = path.join(home, 'metrics'), runsDir = path.join(home, 'runs');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.mkdirSync(runsDir, { recursive: true });
    const legacy = path.join(home, 'sessions.json');
    for (const r of readJson<V0Session[]>(legacy) ?? []) { writeJson(path.join(sessionsDir, `${r.id}.json`), r); }
    deleteFile(legacy);

    for (const name of jsonFiles(sessionsDir)) {
        const record = readJson<V0Session>(path.join(sessionsDir, name));
        if (!record) { continue; }
        const session = { ...sessionV1(record), id: IS_UUID.test(record.id) ? record.id : reissuedId(record) };
        const runs = path.join(metricsDir, `${record.id}.json`);
        if (session.id !== record.id && fs.existsSync(runs)) { fs.renameSync(runs, path.join(metricsDir, `${session.id}.json`)); }
        writeJson(path.join(sessionsDir, `${session.id}.json`), session);
        if (session.id !== record.id) { deleteFile(path.join(sessionsDir, name)); }
    }

    for (const name of jsonFiles(metricsDir)) {
        writeJson(path.join(runsDir, name), runsFileV1(readJson<V0RunsFile>(path.join(metricsDir, name)) ?? {}));
    }
    fs.rmSync(metricsDir, { recursive: true, force: true });

    const sshConfig = path.join(path.dirname(home), '.ssh', 'config');
    const text = fs.existsSync(sshConfig) ? fs.readFileSync(sshConfig, 'utf-8') : '';
    const kept = text.split('\n').filter(line => !/^\s*Include\s+\S*\.cybershuttle\/ssh_hosts\s*$/.test(line)).join('\n');
    if (kept !== text) { fs.writeFileSync(sshConfig, kept); }
    deleteFile(path.join(home, 'ssh_hosts'));
}

// STEPS[n] brings the tree from version n to n + 1.
const STEPS: ((home: string) => void)[] = [v0ToV1];
export const SCHEMA_VERSION = STEPS.length;

export function migrate(home = CS_HOME): void {
    fs.mkdirSync(home, { recursive: true });
    const marker = path.join(home, 'schema.json');
    lock(marker);
    try {
        let version = readJson<{ version: number }>(marker)?.version ?? 0;
        if (version > SCHEMA_VERSION) {
            throw new Error(`~/.cybershuttle is at schema ${version}, newer than this CS Bridge reads (${SCHEMA_VERSION}); update CS Bridge.`);
        }
        for (; version < SCHEMA_VERSION; version++) {
            STEPS[version](home);
            writeJson(marker, { version: version + 1 });
        }
    }
    finally { release(marker); }
}
