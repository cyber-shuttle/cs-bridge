import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { legacySteps } from './schema';
import { SCHEMA_VERSION, migrate } from './store';
import { memoryFiles } from './memoryFiles';

const UUID = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const write = (file: string, value: unknown) => writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));

// A tree as the releases before the store left it: 0.0.x's sessions.json, 0.2.0's records and metrics, 0.0.3's ssh_hosts,
// and 0.2.1's windowPids.
test('migrate brings every ~/.cybershuttle layout into the store, reruns idempotently and refuses a newer store', async () => {
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
        windowPids: [42],
    });
    write(join(home, 'metrics', `${UUID}.json`), {
        runs: [{ sessionId: UUID, cluster: 'anvil', jobId: '8', endedAt: 5, finalStatus: 'stopped', allocation: 'a', queue: 'q', stats: { reqMem: '2.0 GB', elapsedSec: 10, memEfficiencyPct: 50 }, metrics: [{ memBytes: 1 }] }],
        metrics: [{ memBytes: 2 }], stats: { reqMem: '1.0 GB' },
    });
    write(join(home, 'ssh_hosts'), 'Host legacy\n');
    write(join(home, 'ssh_config'), 'Host old\n');
    mkdirSync(join(home, 'ssh_keys'));
    writeFileSync(join(home, 'ssh_keys', 'id_cshost-k'), 'key', { mode: 0o600 });
    mkdirSync(join(home, 'control'));
    write(join(home, 'control', 'state.json'), '{}'); // cs's, which stays
    write(join(root, '.ssh', 'config'), `Include ${join(home, 'ssh_config')}\nInclude ${join(home, 'ssh_hosts')}\nHost x\n    HostName x\n`);
    const storage = join(root, 'storage');

    const files = memoryFiles();
    const record = (name: string) => JSON.parse(files.texts.get(name)!);
    await migrate(files, legacySteps(files, storage, home));

    assert.deepEqual(record('schema.json'), { version: SCHEMA_VERSION });
    assert.deepEqual(record(`sessions/${UUID}.json`), {
        id: UUID, name: 'n', status: 'ready_to_connect', alias: 'anvil', account: '', partition: 'gpu', rootFolder: '/home/u',
        resources: { cores: 2, memoryMb: 4096, wallMinutes: 30, gpuType: 'a100', gpuCount: 2 },
        jobId: '9', submittedAt: 1, errorMessage: '', transport: 'devtunnel', devtunnel: { id: 't', cluster: 'usw' },
        connectionInfo: { sshPort: 40, controlPort: 25000 },
    });
    assert.deepEqual(record(`runs/${UUID}.json`), {
        runs: [{ sessionId: UUID, alias: 'anvil', jobId: '8', account: 'a', partition: 'q', endedAt: 5, finalState: 'stopped', stats: { requestedMemory: '2.0 GB', elapsedSeconds: 10, memoryEfficiencyPct: 50 }, samples: [{ memBytes: 1 }] }],
        samples: [{ memBytes: 2 }], stats: { requestedMemory: '1.0 GB' },
    });
    const reissued = [...files.texts.keys()].filter(n => n.startsWith('sessions/')).map(record).find(s => s.id !== UUID);
    assert.match(reissued.id, /^00000000-06a4-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/); // 1700 ms, as submitted
    assert.deepEqual({ ...reissued, id: undefined }, {
        id: undefined, name: '1700', status: 'not_started', alias: 'delta', account: 'acct', partition: 'cpu', rootFolder: '',
        resources: { cores: 4, memoryMb: 8192, wallMinutes: 90 }, jobId: '', submittedAt: 1700, errorMessage: '', transport: 'devtunnel',
    });
    assert.ok(files.texts.has(`runs/${reissued.id}.json`));
    assert.deepEqual(readdirSync(home), ['control']);
    assert.equal(statSync(join(storage, 'ssh_keys', 'id_cshost-k')).mode & 0o777, 0o600);
    assert.equal(existsSync(join(storage, 'ssh_config')), false); // rebuilt on connect
    assert.equal(readFileSync(join(root, '.ssh', 'config'), 'utf-8'), 'Host x\n    HostName x\n');

    // A crash before the marker was written reruns the steps over their own output.
    const before = new Map(files.texts);
    await files.write('schema.json', JSON.stringify({ version: 0 }));
    await migrate(files, legacySteps(files, storage, home));
    assert.deepEqual(files.texts, before);

    await files.write('schema.json', JSON.stringify({ version: SCHEMA_VERSION + 1 }));
    await assert.rejects(migrate(files, legacySteps(files, storage, home)), /newer than this CS Bridge reads/);
    rmSync(root, { recursive: true, force: true });
});
