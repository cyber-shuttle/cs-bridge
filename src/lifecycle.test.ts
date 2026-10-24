import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { panels } from '../scripts/vscodeMock.js';
import { memoryFiles } from './modules/memoryFiles';
import type { JsonDir } from './modules/store';
import { initSessionStore, addSession, claim, owns, disown, requestStop, statusOf, live, getSession } from './extensionStore';
import { initRunStore, appendRun } from './modules/runStore';
import { newSession, Run, SlurmJobStatus, SummaryState } from './models';
import { Backend, Backends, SessionMonitor } from './modules/sessionSupport';
import { openSummaryPanel } from './summaryPanel';
import { sleep } from './modules/util';

const files = memoryFiles();
const fail = (err: unknown) => assert.fail(String(err));
let windows: JsonDir<{ at: number }>;
before(async () => { [, windows] = await initSessionStore(files, fail); await initRunStore(files, fail); });
const running = () => {
    const s = newSession({ alias: 'delta', account: '', partition: 'cpu', rootFolder: '/home/u', resources: { cores: 1, memoryMb: 1024, wallMinutes: 30 } });
    addSession({ ...s, jobId: '7', observed: { state: SlurmJobStatus.RUNNING, at: Date.now() }, startedAt: Date.now() - 1000 });
    return getSession(s.id)!;
};

test('a Stop asked by another window is claimed only once that window stops beating', async () => {
    const s = running();
    await files.write('windows/other.json', JSON.stringify({ at: Date.now() })); // another window's beat, as the watcher reports it
    await windows.reload('other');
    s.owner = 'other';
    await requestStop(s);
    assert.equal(statusOf(s), 'stopping');
    assert.equal(s.errorMessage, '');
    assert.equal(claim(s), false, 'the beating owner keeps the session');
    await files.write('windows/other.json', JSON.stringify({ at: Date.now() - 100_000 }));
    await windows.reload('other');
    assert.equal(claim(s), true, 'a lapsed beat hands it over');
    assert.equal(owns(s), true);
    disown(s);
    assert.equal(owns(s), false);
});

test('a tick that outlives its loop writes nothing, and a teardown is awaited by quiesce', async () => {
    const s = running();
    let release!: () => void;
    const ended: string[] = [];
    const backend: Backend = {
        label: 'fake',
        async tick(session, alive) {
            await new Promise<void>((res) => { release = res; });
            if (!alive()) { return; }
            live.unreachable.add(session.id);
        },
        async end(session) { await sleep(20); ended.push(session.id); },
        async stop() { }, async connect() { return true; }, async remove() { }, forget() { },
    };
    const monitor = new SessionMonitor(new Backends(backend, backend));
    monitor.startMonitoring(s);
    await sleep(5); // the first tick is in flight
    const quiesced = monitor.quiesce(s);
    release();
    await quiesced;
    assert.equal(live.unreachable.has(s.id), false, 'the resumed tick saw its loop gone');
    assert.deepEqual(ended, [s.id], 'one teardown, awaited');
    assert.equal(owns(s), false, 'the loop released the claim');
});

test('the summary shows a run as recorded, pinned to the job it opened on', () => {
    const s = running();
    openSummaryPanel({ fsPath: '/ext' } as never, s);
    const panel = panels.at(-1)!;
    panel.receive({ command: 'ready' });
    const last = () => panel.webview.posted.at(-1)?.state as SummaryState;
    let state = last();
    assert.equal(state.pending, true, 'no run recorded yet');
    const run: Run = { sessionId: s.id, alias: 'delta', jobId: '7', account: '', partition: 'cpu', startedAt: s.startedAt, endedAt: 5_000, finalState: 'stopped', samples: [{ memBytes: 1 }], stats: { cores: 1 } };
    appendRun(run);
    state = last();
    assert.equal(state.pending, false);
    assert.equal(state.at, 5_000);
    assert.equal(state.session.status, 'stopped');
    assert.deepEqual(state.session.samples, [{ memBytes: 1 }]);
    assert.deepEqual(state.stats, { cores: 1 });
});
