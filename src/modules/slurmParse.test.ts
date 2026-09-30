import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSlurmScript, devTunnelLaunch, linkLaunch, classifySchedulerState, parseAccounts, parsePartitionLine, parseSacctStatus, parseSacctUtil, slurmAccount } from './slurmParse';
import { SlurmJobStatus, SlurmSession } from '../models';

test('parseAccounts de-duplicates per-partition associations', () => {
    const out = 'pearc26-tutorial\npearc26-tutorial\ndelta-cpu\n';
    assert.deepEqual(parseAccounts(out), ['pearc26-tutorial', 'delta-cpu']);
});

test('parseAccounts returns [] when there are no associations', () => {
    assert.deepEqual(parseAccounts(''), []);
    assert.deepEqual(parseAccounts('\n'), []);
});

test('parseSacctStatus classifies each Slurm state and reads ElapsedRaw', () => {
    assert.deepEqual(parseSacctStatus('FAILED|1:0|None|120'), { status: SlurmJobStatus.FAILED, elapsedSeconds: 120 });
    assert.deepEqual(parseSacctStatus('CANCELLED by 1001|0:0|None|0'), { status: SlurmJobStatus.CANCELLED, elapsedSeconds: 0 });
    assert.deepEqual(parseSacctStatus('RUNNING|0:0|None|345'), { status: SlurmJobStatus.RUNNING, elapsedSeconds: 345 });
    assert.deepEqual(parseSacctStatus('TIMEOUT|0:0|None|3600'), { status: SlurmJobStatus.TIMEOUT, elapsedSeconds: 3600 });
    assert.equal(parseSacctStatus('OUT_OF_MEMORY|0:0|None|5').status, SlurmJobStatus.OUT_OF_MEMORY);
    assert.equal(parseSacctStatus('COMPLETED|0:0|None|5').status, SlurmJobStatus.COMPLETED);
    assert.equal(parseSacctStatus('PENDING|0:0|Priority|0').status, SlurmJobStatus.QUEUED);
});

test('parseSacctStatus returns UNKNOWN for an unrecognized state and 0 elapsed for non-numeric', () => {
    assert.deepEqual(parseSacctStatus('SOMETHING_ELSE|0:0|None|n/a'), { status: SlurmJobStatus.UNKNOWN, elapsedSeconds: 0 });
});

test('parseSacctStatus throws on empty or malformed output', () => {
    assert.throws(() => parseSacctStatus(''), /No output from sacct/);
    assert.throws(() => parseSacctStatus('FAILED|1:0'), /Unexpected output format/);
});

test('parsePartitionLine strips the default-partition marker and parses "24+" CPUs', () => {
    assert.deepEqual(parsePartitionLine('cpu-small*|24+|191000+|(null)'), {
        name: 'cpu-small', cpuCount: 24, memoryMb: 191000, gres: [],
    });
});

test('parsePartitionLine parses a GPU GRES entry with socket suffix', () => {
    assert.deepEqual(parsePartitionLine('interactive-cpu|24|191000+|gpu:v100:2(S:0-1)'), {
        name: 'interactive-cpu', cpuCount: 24, memoryMb: 191000, gres: [{ name: 'gpu:v100', count: 2 }],
    });
});

test('parsePartitionLine keeps only GPU GRES, skipping others whatever their count syntax', () => {
    assert.deepEqual(parsePartitionLine('mix|16|64000|gpu:a100:4(S:0-1),tmpdisk:100G,shard:gpu:8').gres, [{ name: 'gpu:a100', count: 4 }]);
});

test('parsePartitionLine splits multiple comma-separated GRES at the top level only', () => {
    const p = parsePartitionLine('big|128|515000|gpu:a100:2(S:2,5),gpu:v100:4');
    assert.deepEqual(p.gres, [{ name: 'gpu:a100', count: 2 }, { name: 'gpu:v100', count: 4 }]);
});

test('parsePartitionLine throws on a malformed line', () => {
    assert.throws(() => parsePartitionLine('only|three|fields'), /Invalid sinfo line/);
});

test('buildSlurmScript emits the resource #SBATCH directives and the Linkspan invocation', () => {
    const session = scriptSession({
        partition: 'gpu', resources: { cores: 4, memoryMb: 8192, wallMinutes: 1500, gpuType: 'a100', gpuCount: 2 },
        devtunnel: { id: 'tid', cluster: 'use' }, connectionInfo: { controlPort: 25000, sshPort: 0 },
    });
    const script = buildSlurmScript(session, devTunnelLaunch(session, 'tok'));
    assert.match(script, /^#SBATCH --nodes=1$/m);
    assert.match(script, /^#SBATCH --cpus-per-task=4$/m);
    assert.match(script, /^#SBATCH --mem=8192M$/m);
    assert.match(script, /^#SBATCH --time=1-01:00:00$/m);
    assert.match(script, /^#SBATCH --partition=gpu$/m);
    assert.match(script, /^#SBATCH --account=acct1$/m);
    assert.match(script, /^#SBATCH --gres=gpu:a100:2$/m);
    assert.match(script, /^"\$LINKSPAN_BIN" --port 25000 --tunnel-enable --tunnel-mode devtunnel --tunnel-devtunnel-args '--id tid --cluster use'$/m);
    assert.doesNotMatch(script, /TOKEN|tok'/);
});

test('buildSlurmScript launches a link session with its URL and no token', () => {
    const script = buildSlurmScript(scriptSession(), linkLaunch('wss://u', 'secret'));
    assert.match(script, /^"\$LINKSPAN_BIN" --port 0 --tunnel-enable --tunnel-mode link --tunnel-link-args '--url wss:\/\/u'$/m);
    assert.doesNotMatch(script, /TOKEN|secret/);
});

// The session every script test starts from; each names only what it varies.
function scriptSession(overrides: Partial<SlurmSession> = {}): SlurmSession {
    return { partition: 'cpu', account: 'acct1', resources: { cores: 2, memoryMb: 4096, wallMinutes: 60 }, ...overrides } as SlurmSession;
}
const launch = devTunnelLaunch(scriptSession(), 't');

test('buildSlurmScript omits the GPU directive when no GPU is selected', () => {
    const session = scriptSession();
    const script = buildSlurmScript(session, launch);
    assert.doesNotMatch(script, /--gres=/);
});

test('buildSlurmScript omits --account without a Slurm account, and gpu: types a generic GPU', () => {
    const script = buildSlurmScript(scriptSession({ account: '', resources: { cores: 2, memoryMb: 4096, wallMinutes: 60, gpuType: 'gpu', gpuCount: 1 } }), launch);
    assert.doesNotMatch(script, /--account/);
    assert.match(script, /^#SBATCH --gres=gpu:1$/m);
});

test('slurmAccount keeps real account tokens and blanks anything else', () => {
    assert.equal(slurmAccount('acct1'), 'acct1');
    assert.equal(slurmAccount('  bio-lab_2.0 '), 'bio-lab_2.0');
    assert.equal(slurmAccount('(no Slurm account)'), '');
    assert.equal(slurmAccount(''), '');
    assert.equal(slurmAccount(undefined), '');
});

test('parseSacctUtil reads job fields, ignoring the empty usage on the main row', () => {
    const out = '20041571|2|2097152K|1573|3146||';
    assert.deepEqual(parseSacctUtil(out), { cores: 2, requestedMemory: '2.0 GB', elapsedSeconds: 1573 });
});

test('parseSacctUtil derives CPU and memory efficiency from the batch step usage', () => {
    const out = [
        '20041571|2|2097152K|1573|3146||',
        '20041571.batch|2|2097152K|1573|3146|1048576K|00:26:00',
    ].join('\n');
    const m = parseSacctUtil(out);
    assert.equal(m.cores, 2);
    assert.equal(m.elapsedSeconds, 1573);
    assert.equal(m.maxRss, '1.0 GB'); // 1048576K = 1 GiB
    assert.equal(Math.round(m.memoryEfficiencyPct!), 50); // 1 GiB used / 2 GiB requested
    assert.equal(Math.round(m.cpuEfficiencyPct!), 50); // 1560s used / 3146s allocated = 49.6%
});

test('parseSacctUtil derives efficiency across a day-spanning TotalCPU', () => {
    const out = '55|4|4194304K|86400|345600||\n55.batch|4|4194304K|86400|345600|2097152K|1-00:00:00';
    const m = parseSacctUtil(out);
    assert.equal(Math.round(m.memoryEfficiencyPct!), 50); // 2 GiB used / 4 GiB requested
    assert.equal(Math.round(m.cpuEfficiencyPct!), 25); // 86400s used / 345600s allocated = 25%
});

test('parseSacctUtil ignores srun poll steps and the empty running batch (no efficiency until it flushes)', () => {
    const out = [
        '20240108|2|2097152K|1641|3282||00:00:00',
        '20240108.batch|2||1641|3282||00:00:00', // batch usage not flushed yet
        '20240108.extern|2||1641|3282||00:00:00',
        '20240108.0|2||1|2|24K|00:00:00', // our srun usage-poll steps — tiny, must not be read
        '20240108.77|2||0|0|64K|00:00:00',
    ].join('\n');
    assert.deepEqual(parseSacctUtil(out), { cores: 2, requestedMemory: '2.0 GB', elapsedSeconds: 1641 });
});

test('parseSacctUtil returns an empty object for no output', () => {
    assert.deepEqual(parseSacctUtil(''), {});
});

test('buildSlurmScript unsets the inherited XDG_RUNTIME_DIR/TMPDIR before launching Linkspan', () => {
    const session = scriptSession();
    const script = buildSlurmScript(session, launch);

    // The compute node has no logind, so the inherited /run/user/<uid> XDG_RUNTIME_DIR is absent there;
    // unset it (and TMPDIR) so the VS Code server falls back to its node-local /tmp default.
    assert.match(script, /^unset XDG_RUNTIME_DIR TMPDIR$/m);

    // Linkspan must inherit the cleaned env, so the unset has to precede its invocation.
    assert.ok(script.indexOf('unset XDG_RUNTIME_DIR') < script.indexOf('"$LINKSPAN_BIN" --port'),
        'unset precedes Linkspan invocation');
});

// This table is the twin of cs-plane's normalizeState (internal/slurm/slurm.go).
// The two must agree: they watch the same scheduler for the same jobs, and a state only
// one of them knows is a state one of them silently holds on. Change both together.
test('classifies every scheduler state cs-plane classifies', () => {
    const expected: Record<string, SlurmJobStatus> = {
        PENDING: SlurmJobStatus.QUEUED, REQUEUED: SlurmJobStatus.QUEUED, REQUEUE_FED: SlurmJobStatus.QUEUED,
        REQUEUE_HOLD: SlurmJobStatus.QUEUED, SUSPENDED: SlurmJobStatus.QUEUED, STOPPED: SlurmJobStatus.QUEUED,
        RUNNING: SlurmJobStatus.RUNNING, CONFIGURING: SlurmJobStatus.RUNNING, COMPLETING: SlurmJobStatus.RUNNING,
        RESIZING: SlurmJobStatus.RUNNING, SIGNALING: SlurmJobStatus.RUNNING, STAGE_OUT: SlurmJobStatus.RUNNING,
        COMPLETED: SlurmJobStatus.COMPLETED, CANCELLED: SlurmJobStatus.CANCELLED, TIMEOUT: SlurmJobStatus.TIMEOUT,
        BOOT_FAIL: SlurmJobStatus.FAILED, DEADLINE: SlurmJobStatus.FAILED, FAILED: SlurmJobStatus.FAILED,
        NODE_FAIL: SlurmJobStatus.FAILED, OUT_OF_MEMORY: SlurmJobStatus.OUT_OF_MEMORY,
        PREEMPTED: SlurmJobStatus.FAILED, REVOKED: SlurmJobStatus.FAILED, SPECIAL_EXIT: SlurmJobStatus.FAILED,
    };
    for (const [state, want] of Object.entries(expected)) {
        assert.equal(classifySchedulerState(state), want, `${state} must not be held as UNKNOWN`);
    }
});

test('reads the state out of sacct decoration: a reason suffix and a truncation marker', () => {
    assert.equal(classifySchedulerState('CANCELLED by 1001'), SlurmJobStatus.CANCELLED);
    assert.equal(classifySchedulerState('COMPLETING+'), SlurmJobStatus.RUNNING);
    assert.equal(classifySchedulerState('  running  '), SlurmJobStatus.RUNNING);
});

// UNKNOWN is the absence of an observation, not a state: the monitor holds rather than
// terminalizing, and the walltime deadline is what eventually settles the session.
test('an unrecognised scheduler word stays UNKNOWN', () => {
    assert.equal(classifySchedulerState('WAT'), SlurmJobStatus.UNKNOWN);
    assert.equal(classifySchedulerState(''), SlurmJobStatus.UNKNOWN);
});
