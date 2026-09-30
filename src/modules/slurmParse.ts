import { GresInfo, RunStats, SlurmJobStatus, SlurmPartitionInfo, SlurmSession } from '../models';

// Pure Slurm text helpers (no SSH/vscode), so they unit-test in isolation. See slurmParse.test.ts.

// A Slurm account is a bare token; a blank or a sentinel like "(no Slurm account)" yields '' (no --account).
export const slurmAccount = (raw: string | undefined): string => (raw ?? '').trim().match(/^[\w.-]+$/)?.[0] ?? '';

// Distinct accounts from `sacctmgr show associations ... format=Account -P`; it prints one
// row per (account, partition) association, so per-partition accounts repeat.
export function parseAccounts(output: string): string[] {
    const names = output.trim().split(/\r?\n/)
        .map(l => l.split('|')[0].trim())
        .filter(Boolean);
    return [...new Set(names)];
}

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
export const envAssignments = (env: Record<string, string>) => Object.entries(env).map(([k, v]) => `${k}=${shellQuote(v)} `).join('');

export interface LinkspanLaunch { tunnelArgs: string; sbatchEnv: Record<string, string> }

export const devTunnelLaunch = (session: SlurmSession, hostToken: string): LinkspanLaunch => ({
    tunnelArgs: `--tunnel-mode devtunnel --tunnel-devtunnel-args '--id ${session.devtunnel?.id ?? ''} --cluster ${session.devtunnel?.cluster ?? ''}'`,
    sbatchEnv: { LINKSPAN_TUNNEL_HOST_TOKEN: hostToken },
});

export const linkLaunch = (url: string, token: string): LinkspanLaunch => ({
    tunnelArgs: `--tunnel-mode link --tunnel-link-args ${shellQuote(`--url ${url}`)}`, sbatchEnv: { LINKSPAN_LINK_TOKEN: token },
});

// A GRES name as cs-plane's gpuType: without its gpu: prefix, and 'gpu' for any GPU.
export const gpuTypeOf = (gres: string): string => gres.replace(/^gpu:?/, '') || 'gpu';

// Minutes as Slurm's --time, as cs-plane's minutesToWalltime.
function minutesToWalltime(minutes: number): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    const days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60);
    return `${days ? `${days}-` : ''}${pad(hours)}:${pad(minutes % 60)}:00`;
}

// The #SBATCH lines match cs-plane's buildScript for the same session.
export function buildSlurmScript(session: SlurmSession, launch: LinkspanLaunch): string {
    const { cores, memoryMb, wallMinutes, gpuType, gpuCount } = session.resources;

    const sbatchLines = [
        `#SBATCH --job-name=linkspan-session`,
        `#SBATCH --nodes=1`,
        `#SBATCH --ntasks=1`,
        `#SBATCH --cpus-per-task=${cores}`,
        `#SBATCH --mem=${memoryMb}M`,
        `#SBATCH --time=${minutesToWalltime(wallMinutes)}`,
        `#SBATCH --partition=${session.partition}`,
        ...(session.account ? [`#SBATCH --account=${session.account}`] : []),
        ...(gpuCount ? [`#SBATCH --gres=gpu:${gpuType && gpuType !== 'gpu' ? `${gpuType}:` : ''}${gpuCount}`] : []),
    ];

    const scriptLines = [
        `#!/bin/bash`,
        ...sbatchLines,
        ``,
        `# --- Set up log files using $HOME ---`,
        `LOG_DIR="$HOME/.cybershuttle/logs"`,
        `install -d -m 700 "$LOG_DIR"`,
        `exec > "$LOG_DIR/linkspan-session-$SLURM_JOB_ID.out" 2> "$LOG_DIR/linkspan-session-$SLURM_JOB_ID.err"`,
        ``,
        `# The compute node has no logind, so the inherited /run/user/$UID (XDG_RUNTIME_DIR) is absent there;`,
        `# unset it (and TMPDIR) so the VS Code server Linkspan launches falls back to its node-local /tmp default.`,
        `unset XDG_RUNTIME_DIR TMPDIR`,
        ``,
        `# --- Run Linkspan ---`,
        `LINKSPAN_BIN="$HOME/.cybershuttle/bin/linkspan"`,
        // Bind the control port pinned at launch (no log/port discovery).
        `"$LINKSPAN_BIN" --port ${session.connectionInfo?.controlPort ?? 0} --tunnel-enable ${launch.tunnelArgs}`,
    ];

    return scriptLines.join('\n');
}

// One `sacct --parsable2` row: State|ExitCode|Reason|ElapsedRaw
export function parseSacctStatus(output: string): { status: SlurmJobStatus; elapsedSeconds: number } {
    if (!output) {
        throw new Error('Failed to get job status. No output from sacct command.');
    }
    const fields = output.split('|');
    if (fields.length < 4) {
        throw new Error('Failed to get job status. Unexpected output format from sacct command. Output: ' + output);
    }
    /*
    FAILED|1:0|None|120
    CANCELLED by 1001|0:0|None|0
    RUNNING|0:0|None|345
    TIMEOUT|0:0|None|3600
    */
    const [state, , , elapsedRaw] = fields;
    // ElapsedRaw is Slurm's authoritative run-time in whole seconds (no timezone/clock guessing).
    const elapsedSeconds = /^\d+$/.test(elapsedRaw.trim()) ? parseInt(elapsedRaw.trim(), 10) : 0;

    return { status: classifySchedulerState(state), elapsedSeconds };
}

// The scheduler's vocabulary in one place, mirroring cs-plane's own table. An
// absent state reads as UNKNOWN, which the monitor holds rather than treating as
// job death, so an unlisted state strands a session until its walltime.
// SUSPENDED and STOPPED still hold their nodes, so they read as QUEUED.
const SCHEDULER_STATES: Readonly<Record<string, SlurmJobStatus>> = {
    PENDING: SlurmJobStatus.QUEUED,
    REQUEUED: SlurmJobStatus.QUEUED,
    REQUEUE_FED: SlurmJobStatus.QUEUED,
    REQUEUE_HOLD: SlurmJobStatus.QUEUED,
    SUSPENDED: SlurmJobStatus.QUEUED,
    STOPPED: SlurmJobStatus.QUEUED,

    RUNNING: SlurmJobStatus.RUNNING,
    CONFIGURING: SlurmJobStatus.RUNNING,
    COMPLETING: SlurmJobStatus.RUNNING,
    RESIZING: SlurmJobStatus.RUNNING,
    SIGNALING: SlurmJobStatus.RUNNING,
    STAGE_OUT: SlurmJobStatus.RUNNING,

    COMPLETED: SlurmJobStatus.COMPLETED,
    CANCELLED: SlurmJobStatus.CANCELLED,
    TIMEOUT: SlurmJobStatus.TIMEOUT,

    BOOT_FAIL: SlurmJobStatus.FAILED,
    DEADLINE: SlurmJobStatus.FAILED,
    FAILED: SlurmJobStatus.FAILED,
    NODE_FAIL: SlurmJobStatus.FAILED,
    OUT_OF_MEMORY: SlurmJobStatus.OUT_OF_MEMORY,
    PREEMPTED: SlurmJobStatus.FAILED,
    REVOKED: SlurmJobStatus.FAILED,
    SPECIAL_EXIT: SlurmJobStatus.FAILED,
};

// sacct decorates a state with the reason ("CANCELLED by 1001") and marks a
// truncated one with a trailing "+", so only the first token is the state.
export function classifySchedulerState(raw: string): SlurmJobStatus {
    const token = raw.trim().split(/\s+/)[0] ?? '';
    return SCHEDULER_STATES[token.replace(/\+$/, '').toUpperCase()] ?? SlurmJobStatus.UNKNOWN;
}

// With `--units=K`, sacct emits every memory field (MaxRSS, ReqMem) in KiB, so a value is just its leading number —
// parseFloat drops the trailing 'K' and any legacy per-CPU/node 'c'/'n'. Blank/unparseable → undefined.
function parseKib(s: string | undefined): number | undefined {
    const n = parseFloat((s ?? '').trim());
    return Number.isFinite(n) ? n : undefined;
}

// Slurm "[DD-]HH:MM:SS" / "MM:SS" duration → seconds. Consumed CPU (TotalCPU) has no raw-seconds field, so this stays.
function hmsSeconds(s: string | undefined): number | undefined {
    const t = s?.trim();
    if (!t) { return undefined; }
    const [days, rest] = t.includes('-') ? t.split('-') : ['0', t];
    const parts = rest.split(':').map(Number);
    if (parts.length < 2 || parts.some(n => !Number.isFinite(n))) { return undefined; }
    return Number(days) * 86400 + parts.reduce((sec, p) => sec * 60 + p, 0);
}

export function humanKib(kib: number): string {
    if (kib >= 1024 ** 2) { return `${(kib / 1024 ** 2).toFixed(1)} GB`; }
    if (kib >= 1024) { return `${(kib / 1024).toFixed(1)} MB`; }
    return `${Math.round(kib)} KB`;
}

// Parse `sacct -P -n --units=K` rows (JobID|AllocCPUs|ReqMem|ElapsedRaw|CPUTimeRAW|MaxRSS|TotalCPU).
// Usage lives on the .batch step where the workload runs; .extern and our own srun
// poll steps would mask it with their near-zero values.
export function parseSacctUtil(output: string): RunStats {
    const rows = output.split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(l => l.split('|'));
    if (rows.length === 0) { return {}; }
    const alloc = rows.find(r => !r[0].includes('.')) ?? rows[0];
    const usage = rows.find(r => r[0].endsWith('.batch')) ?? alloc;

    const m: RunStats = {};
    const cores = Number(alloc[1]);
    if (Number.isFinite(cores) && cores > 0) { m.cores = cores; }
    const reqMemKib = parseKib(alloc[2]);
    if (alloc[3] && Number.isFinite(Number(alloc[3]))) { m.elapsedSeconds = Number(alloc[3]); }
    const allocCpuSec = Number(alloc[4]); // CPUTimeRAW = elapsed × cpus

    const maxRssKib = parseKib(usage[5]);
    const usedCpuSec = hmsSeconds(usage[6]);

    if (reqMemKib !== undefined) { m.requestedMemory = humanKib(reqMemKib); }
    if (maxRssKib !== undefined) { m.maxRss = humanKib(maxRssKib); }
    // TotalCPU is 00:00:00 until the step ends, so a zero means "not flushed yet", not a truly idle job — skip it.
    if (usedCpuSec && Number.isFinite(allocCpuSec) && allocCpuSec > 0) {
        m.cpuEfficiencyPct = usedCpuSec / allocCpuSec * 100;
    }
    if (maxRssKib !== undefined && reqMemKib) { m.memoryEfficiencyPct = maxRssKib / reqMemKib * 100; }
    return m;
}

// One `sinfo -h -o "%P|%c|%m|%G"` line: name|cpuCount|memoryMb|gres
export function parsePartitionLine(line: string): SlurmPartitionInfo {
    const parts = line.split('|').map(p => p.trim());

    if (parts.length !== 4) {
        throw new Error(`Invalid sinfo line: ${line}`);
    }

    const [rawName, rawCpuCount, rawMemory, rawGres] = parts;

    return {
        name: rawName.replace(/\*$/, ''), // trailing "*" marks the default partition
        cpuCount: parseLeadingInt(rawCpuCount),
        memoryMb: parseInt(rawMemory, 10) || 0, // sinfo's %m is MB, '+' when nodes differ
        gres: parseGres(rawGres),
    };
}

function parseLeadingInt(value: string): number {
    const match = value.match(/\d+/);
    if (!match) {
        throw new Error(`Could not parse integer from: ${value}`);
    }
    return Number.parseInt(match[0], 10);
}

function parseGres(rawGres: string): GresInfo[] {
    if (!rawGres || rawGres === '(null)') {
        return [];
    }

    // GPUs only, as cs-plane's hasGPU: gpu:v100:2(S:0-1) and gpu:8, not tmpdisk:100G.
    return splitCommaOutsideParens(rawGres).flatMap((entry) => {
        const match = entry.match(/^(gpu(?::.+)?):(\d+)(?:\([^)]*\))?$/);
        return match ? [{ name: match[1], count: Number.parseInt(match[2], 10) }] : [];
    });
}

function splitCommaOutsideParens(value: string): string[] {
    const result: string[] = [];
    let current = '';
    let depth = 0;

    for (const ch of value) {
        if (ch === '(') { depth++; }
        if (ch === ')') { depth--; }

        if (ch === ',' && depth === 0) {
            result.push(current.trim());
            current = '';
            continue;
        }

        current += ch;
    }

    if (current.trim()) {
        result.push(current.trim());
    }

    return result;
}
