import * as vscode from 'vscode';
import { afterEach, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { panels } from '../scripts/vscodeMock.js';
import { memoryFiles } from './modules/memoryFiles';
import { must } from './modules/testSupport';
import type { JsonDir } from './modules/store';
import { initSessionStore, addSession, claim, owns, disown, requestStop, statusOf, live, getSession, getAllSessions, deleteSession, patch, observe, onSessionsChange } from './extensionStore';
import { initRunStore, appendRun } from './modules/runStore';
import { newSession, isEc2, Run, SlurmJobStatus, SessionsMessage, SessionsState } from './models';
import { Backend, Backends, SessionMonitor, prepareLaunch } from './modules/sessionSupport';
import { Ec2Backend } from './modules/ec2Session';
import { SessionProvider } from './sessionProvider';
import type { Transport } from './modules/transport';
import { Ec2 } from './modules/ec2';
import { fakeClient } from './modules/fakeEc2Client';
import { openSummaryPanel } from './summaryPanel';
import { sleep } from './modules/util';

const files = memoryFiles();
const fail = (err: unknown) => assert.fail(String(err));
let windows: JsonDir<{ at: number }>;
before(async () => { [, windows] = await initSessionStore(files, fail); await initRunStore(files, fail); });
afterEach(() => { for (const s of getAllSessions()) { deleteSession(s.id); } }); // a provider's sweep sees only its own test's records
const running = () => {
    const s = newSession({ alias: 'delta', account: '', partition: 'cpu', rootFolder: '/home/u', resources: { cores: 1, memoryMb: 1024, wallMinutes: 30 } });
    addSession({ ...s, jobId: '7', observed: { state: SlurmJobStatus.RUNNING, at: Date.now() }, startedAt: Date.now() - 1000 });
    return must(getSession(s.id));
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

test('the summary shows a run as recorded, pinned to the job it opened on', async () => {
    const s = running();
    openSummaryPanel(vscode.Uri.parse('/ext'), s);
    const panel = must(panels.at(-1));
    panel.receive({ command: 'ready' });
    const last = () => must(panel.webview.posted.at(-1)).state;
    let state = last();
    assert.equal(state.pending, true, 'no run recorded yet');
    await patch(s, { jobId: '8' }); // a restart moves the session on; the panel stays with job 7
    const run: Run = { sessionId: s.id, alias: 'delta', jobId: '7', account: '', partition: 'cpu', startedAt: s.startedAt, endedAt: 5_000, finalState: 'stopped', samples: [{ memBytes: 1 }], stats: { cores: 1 } };
    appendRun(run);
    state = last();
    assert.equal(state.pending, false);
    assert.equal(state.at, 5_000);
    assert.equal(state.session.status, 'stopped');
    assert.deepEqual(state.session.samples, [{ memBytes: 1 }]);
    assert.deepEqual(state.stats, { cores: 1 });
    let disposed = false;
    panel.onDidDispose(() => { disposed = true; });
    deleteSession(s.id);
    assert.ok(disposed, 'the panel closes with its session');
});

test('an EC2 instance is adopted once, then started, stopped and removed through the lifecycle', async () => {
    const calls: string[] = [];
    let state = 'stopped';
    const client = fakeClient({
        DescribeInstancesCommand: () => ({ Reservations: [{ Instances: [{ InstanceId: 'i-9', InstanceType: 't3.micro', State: { Name: state }, Tags: [{ Key: 'Name', Value: 'i-9' }, { Key: 'CS-Bridge-User', Value: 'ubuntu' }] }] }] }),
        StartInstancesCommand: () => { calls.push('start'); state = 'running'; return {}; },
        StopInstancesCommand: () => { calls.push('stop'); state = 'stopped'; return {}; },
        TerminateInstancesCommand: () => { calls.push('terminate'); state = 'terminated'; return {}; },
    });
    const ec2 = new Ec2(() => client, () => '', 'm');
    const aws = { ec2, ready: async () => ({ ec2, regions: ['r1'] }) };
    const idle: Backend = { label: 'none', async tick() { }, async end() { }, async stop() { }, async connect() { return true; }, async remove() { }, forget() { } };
    const backend: Ec2Backend = new Ec2Backend(aws, () => monitor, 1);
    const monitor: SessionMonitor = new SessionMonitor(new Backends(idle, backend));
    await backend.adopt();
    await backend.adopt();
    const adopted = getAllSessions().filter(s => s.jobId === 'i-9');
    assert.equal(adopted.length, 1, 'adopted once');
    const s = must(adopted[0]);
    assert.ok(isEc2(s));
    assert.equal(statusOf(s), 'stopped');

    await patch(s, { desired: 'running' }); // as the provider's submit does
    await backend.start(s);
    assert.deepEqual(calls, ['start']);
    assert.equal(statusOf(s), 'preparing', 'running, no sshd yet');
    await backend.stop(s);
    await monitor.endSession(s); // as the provider's runStop does
    assert.deepEqual(calls, ['start', 'stop']);
    assert.equal(statusOf(s), 'stopped');
    await backend.remove(s);
    assert.deepEqual(calls, ['start', 'stop', 'terminate']);
    monitor.dispose();
});

test('a run that ends on its own is torn down once', async () => {
    const s = running();
    const ended: string[] = [];
    const backend: Backend = {
        label: 'fake',
        async tick(session) { observe(session, SlurmJobStatus.COMPLETED); },
        async end(session) { await sleep(10); ended.push(session.id); },
        async stop() { }, async connect() { return true; }, async remove() { }, forget() { },
    };
    const monitor = new SessionMonitor(new Backends(backend, backend));
    monitor.startMonitoring(s);
    await sleep(5);
    void monitor.endSession(s); // a sweep arriving while the tick's own teardown runs
    await monitor.quiesce(s);
    assert.deepEqual(ended, [s.id]);
    assert.equal(statusOf(s), 'stopped');
});

test('a teardown that the record write re-enters runs once, and a prepare leaves the record\'s connection info to submit', async () => {
    const s = running();
    const ended: string[] = [];
    const backend: Backend = {
        label: 'fake',
        async tick() { },
        async end(session) { await sleep(10); ended.push(session.id); },
        async stop() { }, async connect() { return true; }, async remove() { }, forget() { },
    };
    const monitor = new SessionMonitor(new Backends(backend, backend));
    monitor.startMonitoring(s);
    const sweep = onSessionsChange(() => void monitor.endSession(s)); // the record write of the loop's release re-enters
    await monitor.endSession(s);
    sweep.dispose();
    assert.deepEqual(ended, [s.id]);

    const before = { sshPort: 40, controlPort: 21000 };
    await patch(s, { connectionInfo: before }); // an old run's, not yet torn down by a fake end
    const draft = await prepareLaunch(s, { prepare: async () => ({ tunnelArgs: '', sbatchEnv: {} }) });
    assert.deepEqual(s.connectionInfo, before, 'the record keeps the old run until submit');
    assert.ok(draft.connectionInfo.controlPort >= 20000);
});

test('a relaunch preview outlives a heartbeat, and dropping it releases the attach it made', async () => {
    const s = running();
    await patch(s, { jobId: '7', observed: { state: SlurmJobStatus.COMPLETED, at: Date.now() }, connectionInfo: { sshPort: 40, controlPort: 21000, localPort: 5 } });
    assert.equal(statusOf(s), 'stopped');
    const released: string[] = [];
    const transport: Transport = {
        label: 'fake', description: '', management: () => ({ getTunnel: async () => null }),
        relayClient: () => ({ connect: async () => { }, waitForForwardedPort: async () => { }, dispose: async () => { } }),
        tunnelRef: () => undefined, ensureTunnel: async () => { }, withLinkspan: async () => { throw new Error('unused'); }, deleteTunnel: async () => { },
        signedIn: async () => true, prepare: async () => ({ tunnelArgs: '', sbatchEnv: {} }), release: async (session) => { released.push(session.id); },
    };
    const aws = { ec2: undefined, ready: async () => { throw new Error('signed out'); }, onDidSignIn: () => ({ dispose() { } }) };
    const provider = new SessionProvider(vscode.Uri.parse('/ext'), { transportFor: () => transport, remove: async () => { } }, aws);
    const posted: { command: string; state: SessionsState }[] = [];
    let receive: (m: SessionsMessage) => void = () => { };
    provider.resolveWebviewView({
        webview: { options: {}, html: '', cspSource: 'x', asWebviewUri: (u: unknown) => u, postMessage: async (m: { command: string; state: SessionsState }) => { posted.push(m); return true; }, onDidReceiveMessage: (l: (m: SessionsMessage) => void) => { receive = l; return { dispose() { } }; } },
        visible: true, onDidChangeVisibility: () => ({ dispose() { } }), onDidDispose: () => ({ dispose() { } }),
    } as never);
    const state = () => posted.at(-1)?.state;

    receive({ command: 'prepareLaunchSession', sessionId: s.id });
    await sleep(20);
    assert.deepEqual(released, [s.id], 'the old run is torn down before the next is prepared');
    assert.equal(s.connectionInfo, undefined);
    assert.equal(state()?.preview?.sessionId, s.id, 'the preview is up');
    assert.equal(owns(s), true, 'the preview holds the claim');

    await files.write('windows/other.json', JSON.stringify({ at: Date.now() }));
    await windows.reload('other'); // a heartbeat's sweep lands while the preview waits
    await sleep(20);
    assert.equal(owns(s), true, 'the sweep leaves an owned record alone');
    assert.equal(state()?.preview?.sessionId, s.id);

    receive({ command: 'dismissPreview' });
    await sleep(20);
    assert.deepEqual(released, [s.id, s.id], 'the prepared attach is released');
    assert.equal(state()?.preview, null);
    assert.equal(owns(s), false, 'the claim is given back');
    provider.dispose();
});

test('a second Start during a preview keeps the claim and gives the first attach back', async () => {
    const s = running();
    await patch(s, { jobId: '7', observed: { state: SlurmJobStatus.COMPLETED, at: Date.now() } });
    const log: string[] = [];
    const transport: Transport = {
        label: 'fake', description: '', management: () => ({ getTunnel: async () => null }),
        relayClient: () => ({ connect: async () => { }, waitForForwardedPort: async () => { }, dispose: async () => { } }),
        tunnelRef: () => undefined, ensureTunnel: async () => { }, withLinkspan: async () => { throw new Error('unused'); }, deleteTunnel: async () => { },
        signedIn: async () => true, prepare: async () => { log.push('attach'); return { tunnelArgs: '', sbatchEnv: {} }; }, release: async () => { log.push('release'); },
    };
    const aws = { ec2: undefined, ready: async () => { throw new Error('signed out'); }, onDidSignIn: () => ({ dispose() { } }) };
    const provider = new SessionProvider(vscode.Uri.parse('/ext'), { transportFor: () => transport, remove: async () => { } }, aws);
    let receive: (m: SessionsMessage) => void = () => { };
    provider.resolveWebviewView({
        webview: { options: {}, html: '', cspSource: 'x', asWebviewUri: (u: unknown) => u, postMessage: async () => true, onDidReceiveMessage: (l: (m: SessionsMessage) => void) => { receive = l; return { dispose() { } }; } },
        visible: true, onDidChangeVisibility: () => ({ dispose() { } }), onDidDispose: () => ({ dispose() { } }),
    } as never);
    receive({ command: 'prepareLaunchSession', sessionId: s.id });
    await sleep(20);
    receive({ command: 'prepareLaunchSession', sessionId: s.id });
    await sleep(20);
    assert.deepEqual(log, ['attach', 'release', 'attach']);
    assert.equal(owns(s), true, 'the new preview holds the claim');
    provider.dispose();
});
