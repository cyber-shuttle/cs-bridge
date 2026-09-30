import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCHEMA_VERSION, migrate } from './schema';

const UUID = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const write = (file: string, value: unknown) => writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
const read = (file: string) => JSON.parse(readFileSync(file, 'utf-8'));

// A tree as the releases before the schema left it: 0.0.x's sessions.json, 0.2.0's records and metrics, 0.0.3's ssh_hosts.
test('migrate brings every pre-schema layout to the current one, reruns idempotently and refuses a newer tree', () => {
    const root = mkdtempSync(join(tmpdir(), 'cs-schema-'));
    const home = join(root, '.cybershuttle');
    mkdirSync(join(home, 'sessions'), { recursive: true });
    mkdirSync(join(home, 'metrics'));
    mkdirSync(join(root, '.ssh'));
    write(join(home, 'sessions.json'), [{ id: 'old-1', name: '1700', submittedAt: 1700, cluster: 'delta', status: 'awaiting_input', cpus: 4, memory: '8 GB', wallTime: '01:30:00', queue: 'cpu', allocation: 'acct', gpuClass: '', gpuCount: 0, sshPassword: 'secret' }]);
    write(join(home, 'metrics', 'old-1.json'), { runs: [] });
    write(join(home, 'sessions', `${UUID}.json`), {
        id: UUID, name: 'n', cluster: 'anvil', status: 'ready_to_connect', cpus: 2, memory: '4 GB', wallTime: '00:30:00', queue: 'gpu',
        allocation: '(no Slurm account)', gpuClass: 'gpu:a100:2', gpuCount: 1, tunnelId: 't', tunnelCluster: 'usw', workingDirectory: '/home/u',
        connectionInfo: { sshTunnelId: 't', sshPort: 40, region: 'usw', apiPort: 25000 }, jobId: '9', submittedAt: 1, errorMessage: '', batchScript: 'x',
    });
    write(join(home, 'metrics', `${UUID}.json`), {
        runs: [{ sessionId: UUID, cluster: 'anvil', jobId: '8', endedAt: 5, finalStatus: 'stopped', allocation: 'a', queue: 'q', stats: { reqMem: '2.0 GB', elapsedSec: 10, memEfficiencyPct: 50 }, metrics: [{ memBytes: 1 }] }],
        metrics: [{ memBytes: 2 }], stats: { reqMem: '1.0 GB' },
    });
    write(join(home, 'ssh_hosts'), 'Host legacy\n');
    write(join(root, '.ssh', 'config'), `Include ${join(home, 'ssh_hosts')}\nHost x\n    HostName x\n`);

    migrate(home);

    assert.deepEqual(read(join(home, 'schema.json')), { version: SCHEMA_VERSION });
    assert.deepEqual(read(join(home, 'sessions', `${UUID}.json`)), {
        id: UUID, name: 'n', status: 'ready_to_connect', alias: 'anvil', account: '', partition: 'gpu', rootFolder: '/home/u',
        resources: { cores: 2, memoryMb: 4096, wallMinutes: 30, gpuType: 'a100', gpuCount: 2 },
        jobId: '9', submittedAt: 1, errorMessage: '', transport: 'devtunnel', devtunnel: { id: 't', cluster: 'usw' },
        connectionInfo: { sshPort: 40, controlPort: 25000 },
    });
    assert.deepEqual(read(join(home, 'runs', `${UUID}.json`)), {
        runs: [{ sessionId: UUID, alias: 'anvil', jobId: '8', account: 'a', partition: 'q', endedAt: 5, finalState: 'stopped', stats: { requestedMemory: '2.0 GB', elapsedSeconds: 10, memoryEfficiencyPct: 50 }, samples: [{ memBytes: 1 }] }],
        samples: [{ memBytes: 2 }], stats: { requestedMemory: '1.0 GB' },
    });
    const reissued = readdirSync(join(home, 'sessions')).map(n => read(join(home, 'sessions', n))).find(s => s.id !== UUID);
    assert.match(reissued.id, /^00000000-06a4-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/); // 1700 ms, as submitted
    assert.deepEqual({ ...reissued, id: undefined }, {
        id: undefined, name: '1700', status: 'not_started', alias: 'delta', account: 'acct', partition: 'cpu', rootFolder: '',
        resources: { cores: 4, memoryMb: 8192, wallMinutes: 90 }, jobId: '', submittedAt: 1700, errorMessage: '', transport: 'devtunnel',
    });
    assert.ok(existsSync(join(home, 'runs', `${reissued.id}.json`)));
    for (const gone of ['sessions.json', 'metrics', 'ssh_hosts']) { assert.equal(existsSync(join(home, gone)), false, gone); }
    assert.equal(readFileSync(join(root, '.ssh', 'config'), 'utf-8'), 'Host x\n    HostName x\n');

    // A crash before the marker was written reruns the step over its own output.
    const snapshot = () => ['sessions', 'runs'].map(d => readdirSync(join(home, d)).sort().map(n => readFileSync(join(home, d, n), 'utf-8')));
    const before = snapshot();
    write(join(home, 'schema.json'), { version: 0 });
    migrate(home);
    assert.deepEqual(snapshot(), before);

    write(join(home, 'schema.json'), { version: SCHEMA_VERSION + 1 });
    assert.throws(() => migrate(home), /newer than this CS Bridge reads/);
    rmSync(root, { recursive: true, force: true });
});
