import * as vscode from 'vscode';
import { afterEach, before, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { panels, quickPick, registered } from '../scripts/vscodeMock.js';
import { memoryFiles } from './modules/memoryFiles';
import { must, planeResponse } from './modules/testSupport';
import type { JsonDir } from './modules/store';
import { initSessionStore, addSession, claim, owns, disown, requestStop, statusOf, live, getSession, sessionForHost, getAllSessions, deleteSession, patch, observe, onSessionsChange } from './extensionStore';
import { initRunStore, appendRun, readSessionRuns } from './modules/runStore';
import { initPlaneStore, planeParts, applyPlane, refreshPlane } from './modules/planeSessions';
import { newSession, isEc2, Run, SlurmJobStatus, SessionsMessage, SessionsState, POLLING_INTERVAL_MS, PlaneSession, SessionResponse } from './models';
import { Backend, Backends, SessionMonitor, SlurmBackend, prepareLaunch } from './modules/sessionSupport';
import { Ec2Backend } from './modules/ec2Session';
import { SessionProvider } from './sessionProvider';
import type { Transport } from './modules/transport';
import { Ec2 } from './modules/ec2';
import { fakeClient } from './modules/fakeEc2Client';
import { openSummaryPanel } from './summaryPanel';
import { sleep } from './modules/util';
import { SshManager } from './modules/sshSupport';
import { RemoteSessionController } from './remoteSessionController';
import { PlaneError } from './plane';

const files = memoryFiles();
const fail = (err: unknown) => assert.fail(String(err));
let windows: JsonDir<{ at: number }>;
before(async () => { [, windows] = await initSessionStore(files, fail); await initRunStore(files, fail); await initPlaneStore(files, fail); });
afterEach(() => { for (const s of getAllSessions()) { deleteSession(s.id); } for (const [id] of planeParts()) { deleteSession(id); } }); // a provider's sweep sees only its own test's records
const running = () => {
    const s = newSession({ alias: 'delta', account: '', partition: 'cpu', rootFolder: '/home/u', resources: { cores: 1, memoryMb: 1024, wallMinutes: 30 } });
    addSession({ ...s, jobId: '7', observed: { state: SlurmJobStatus.RUNNING, at: Date.now() }, startedAt: Date.now() - 1000 });
    return must(getSession(s.id));
};

test('a CyberShuttle session\'s remote window knows itself from local parts before any listing', async () => {
    applyPlane(planeResponse(), { alias: 'cs-lab-k1aaaaaa', rootFolder: '/work/u1' });
    await refreshPlane({ signedIn: async () => false } as never, () => { }); // signed out: no listing
    assert.equal(getSession('s1'), undefined);
    assert.equal(sessionForHost('cs-lab-k1aaaaaa-000123'), 's1');
});

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
    let release = () => { };
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
    monitor.startMonitoring(s); // the first tick is in flight
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
    const run: Run = { sessionId: s.id, alias: 'delta', jobId: '7', account: '', partition: 'cpu', startedAt: s.startedAt, endedAt: 5_000, finalState: 'stopped', wallMinutes: 120, samples: [{ memBytes: 1 }], stats: { cores: 1 } };
    appendRun(run);
    state = last();
    assert.equal(state.pending, false);
    assert.equal(state.session.resources.wallMinutes, 120, 'the run\'s own walltime');
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
    const draft = await prepareLaunch(s, { prepare: async () => ({ tunnelArgs: '', sbatchEnv: {} }) }, 60);
    assert.deepEqual(s.connectionInfo, before, 'the record keeps the old run until submit');
    assert.ok(draft.connectionInfo.controlPort >= 20000);
});

test('a relaunch preview outlives a heartbeat, and dropping it gives the claim back', async (t) => {
    t.mock.method(SshManager, 'getInstance', () => ({ runRemoteCommand: async () => '' }) as never);
    const s = running();
    await patch(s, { jobId: '7', observed: { state: SlurmJobStatus.COMPLETED, at: Date.now() }, connectionInfo: { sshPort: 40, controlPort: 21000, localPort: 5 } });
    assert.equal(statusOf(s), 'stopped');
    const transport: Transport = {
        label: 'fake', management: () => ({ getTunnel: async () => null }),
        relayClient: () => ({ connect: async () => { }, waitForForwardedPort: async () => { }, dispose: async () => { } }),
        tunnelRef: () => undefined, ensureTunnel: async () => { }, withLinkspan: async () => { throw new Error('unused'); },
        signedIn: async () => true, prepare: async () => ({ tunnelArgs: '', sbatchEnv: {} }),
    };
    const aws = { ec2: undefined, ready: async () => { throw new Error('signed out'); }, onDidSignIn: () => ({ dispose() { } }) };
    const provider = new SessionProvider(vscode.Uri.parse('/ext'), { transportFor: () => transport, remove: async () => { }, plane: {} as never }, aws);
    const posted: { command: string; state: SessionsState }[] = [];
    let receive: (m: SessionsMessage) => void = () => { };
    provider.resolveWebviewView({
        webview: { options: {}, html: '', cspSource: 'x', asWebviewUri: (u: unknown) => u, postMessage: async (m: { command: string; state: SessionsState }) => { posted.push(m); return true; }, onDidReceiveMessage: (l: (m: SessionsMessage) => void) => { receive = l; return { dispose() { } }; } },
        visible: true, onDidChangeVisibility: () => ({ dispose() { } }), onDidDispose: () => ({ dispose() { } }),
    } as never);
    const state = () => posted.at(-1)?.state;

    quickPick.minutes = 60;
    receive({ command: 'prepareLaunchSession', sessionId: s.id });
    await sleep(20);
    quickPick.minutes = 0;
    assert.equal(s.connectionInfo, undefined);
    assert.equal(state()?.preview?.sessionId, s.id, 'the preview is up');
    assert.match(must(state()?.preview).script, /^#SBATCH --time=01:00:00$/m, 'the picked walltime');
    assert.equal(s.resources.wallMinutes, 30, 'the record keeps the last run\'s walltime until Submit');
    assert.equal(owns(s), true, 'the preview holds the claim');

    await files.write('windows/other.json', JSON.stringify({ at: Date.now() }));
    await windows.reload('other'); // a heartbeat's sweep lands while the preview waits
    await sleep(20);
    assert.equal(owns(s), true, 'the sweep leaves an owned record alone');
    assert.equal(state()?.preview?.sessionId, s.id);

    receive({ command: 'dismissPreview' });
    await sleep(20);
    assert.equal(state()?.preview, null);
    assert.equal(owns(s), false, 'the claim is given back');
    provider.dispose();
});

test('a walltime Slurm refuses stops the Start before the attach', async (t) => {
    const s = running();
    await patch(s, { jobId: '7', observed: { state: SlurmJobStatus.COMPLETED, at: Date.now() } });
    const commands: string[] = [];
    t.mock.method(SshManager, 'getInstance', () => ({
        runRemoteCommand: async (_: string, command: string) => { commands.push(command); throw new Error('sbatch: error: Requested time limit is invalid'); },
    }) as never);
    let attached = false;
    const transport = {
        signedIn: async () => true, prepare: async () => { attached = true; return { tunnelArgs: '', sbatchEnv: {} }; },
    } as unknown as Transport;
    const aws = { ec2: undefined, ready: async () => { throw new Error('signed out'); }, onDidSignIn: () => ({ dispose() { } }) };
    const provider = new SessionProvider(vscode.Uri.parse('/ext'), { transportFor: () => transport, remove: async () => { }, plane: {} as never }, aws);
    let receive: (m: SessionsMessage) => void = () => { };
    provider.resolveWebviewView({
        webview: { options: {}, html: '', cspSource: 'x', asWebviewUri: (u: unknown) => u, postMessage: async () => true, onDidReceiveMessage: (l: (m: SessionsMessage) => void) => { receive = l; return { dispose() { } }; } },
        visible: true, onDidChangeVisibility: () => ({ dispose() { } }), onDidDispose: () => ({ dispose() { } }),
    } as never);

    quickPick.minutes = 1440;
    receive({ command: 'prepareLaunchSession', sessionId: s.id });
    await sleep(20);
    quickPick.minutes = 0;
    assert.match(Buffer.from(must(commands[0]?.match(/echo '(.+?)'/)?.[1]), 'base64').toString(), /^#SBATCH --time=1-00:00:00$/m, 'the picked walltime is the one checked');
    assert.equal(attached, false);
    assert.match(s.errorMessage, /time limit is invalid/);
    provider.dispose();
});

const planeSession = (r = planeResponse()) => {
    applyPlane(r, { alias: 'cs-lab-k1aaaaaa', rootFolder: '/work/u1' });
    return must(getSession(r.sessionId)) as PlaneSession;
};
const linkTransports = { transportFor: () => ({ label: 'fake', tunnelRef: () => undefined }) as never, remove: async () => { }, plane: {} as never };

test('a CyberShuttle session is read from the listing, never polled for its job', async (t) => {
    const commands: string[] = [];
    t.mock.method(SshManager, 'getInstance', () => ({ runRemoteCommand: async (_: string, c: string) => { commands.push(c); return ''; } }) as never);
    applyPlane(planeResponse({}, { state: 'SUBMITTED', startedAt: null, deadline: null }), { alias: 'cs-lab-k1aaaaaa', rootFolder: '/work/u1' });
    const s = must(getSession('s1'));
    await new SlurmBackend(linkTransports, () => ({}) as never).tick(s, () => true);
    assert.deepEqual(commands, [], 'no sacct');
    assert.equal(statusOf(s), 'queued');
});

test('a CyberShuttle run that ends in the listing is torn down once and records no run', async (t) => {
    const commands: string[] = [];
    t.mock.method(SshManager, 'getInstance', () => ({ runRemoteCommand: async (_: string, c: string) => { commands.push(c); return ''; } }) as never);
    const s = planeSession();
    await patch(s, { connectionInfo: { sshPort: 40, controlPort: 21234, localPort: 5 } });
    applyPlane(planeResponse({}, { state: 'CANCELLED' }));
    const monitor: SessionMonitor = new SessionMonitor(new Backends(new SlurmBackend(linkTransports, () => monitor), {} as never));
    monitor.startMonitoring(s);
    await sleep(20);
    await monitor.quiesce(s);
    assert.equal(s.connectionInfo, undefined);
    assert.equal(JSON.parse(must(files.texts.get('plane/s1.json'))).ports, undefined);
    assert.deepEqual(readSessionRuns('s1'), []);
    assert.deepEqual(commands, [], 'no sacct for its stats');
});

// Review Focus 3. Waits one POLLING_INTERVAL_MS for the loop's second tick.
test('a run replaced between two listings ends this window\'s hold on the old one, and its remote window', { timeout: 2 * POLLING_INTERVAL_MS }, async (t) => {
    const s = planeSession();
    const ended: string[] = [];
    const monitor = new SessionMonitor(new Backends({ label: 'fake', async tick() { }, async end(x) { ended.push(x.id); }, async stop() { }, async connect() { return true; }, async remove() { }, forget() { } }, {} as never));
    monitor.startMonitoring(s);
    const closed: string[] = [];
    t.mock.method(vscode.commands, 'executeCommand', async (c: string) => { closed.push(c); });
    const remote = new RemoteSessionController({} as never, 's1', {} as never);
    applyPlane(planeResponse({}, { processId: 'p2', state: 'SUBMITTED', startedAt: null, deadline: null }));
    await sleep(POLLING_INTERVAL_MS + 50);
    assert.deepEqual(ended, ['s1'], 'the loop bound to p1 ends once p1 is gone');
    assert.equal(monitor.monitoring('s1'), false);
    assert.ok(closed.includes('workbench.action.remote.close'));
    remote.dispose();
});

test('a second Start during a preview prepares again and keeps the claim', async (t) => {
    t.mock.method(SshManager, 'getInstance', () => ({ runRemoteCommand: async () => '' }) as never);
    const s = running();
    await patch(s, { jobId: '7', observed: { state: SlurmJobStatus.COMPLETED, at: Date.now() } });
    const log: string[] = [];
    const transport: Transport = {
        label: 'fake', management: () => ({ getTunnel: async () => null }),
        relayClient: () => ({ connect: async () => { }, waitForForwardedPort: async () => { }, dispose: async () => { } }),
        tunnelRef: () => undefined, ensureTunnel: async () => { }, withLinkspan: async () => { throw new Error('unused'); },
        signedIn: async () => true, prepare: async () => { log.push('attach'); return { tunnelArgs: '', sbatchEnv: {} }; },
    };
    const aws = { ec2: undefined, ready: async () => { throw new Error('signed out'); }, onDidSignIn: () => ({ dispose() { } }) };
    const provider = new SessionProvider(vscode.Uri.parse('/ext'), { transportFor: () => transport, remove: async () => { }, plane: {} as never }, aws);
    let receive: (m: SessionsMessage) => void = () => { };
    provider.resolveWebviewView({
        webview: { options: {}, html: '', cspSource: 'x', asWebviewUri: (u: unknown) => u, postMessage: async () => true, onDidReceiveMessage: (l: (m: SessionsMessage) => void) => { receive = l; return { dispose() { } }; } },
        visible: true, onDidChangeVisibility: () => ({ dispose() { } }), onDidDispose: () => ({ dispose() { } }),
    } as never);
    receive({ command: 'prepareLaunchSession', sessionId: s.id });
    await sleep(20);
    receive({ command: 'prepareLaunchSession', sessionId: s.id });
    await sleep(20);
    assert.deepEqual(log, ['attach', 'attach']);
    assert.equal(owns(s), true, 'the new preview holds the claim');
    provider.dispose();
});

function provider(t: TestContext, plane: object) {
    const commands: string[] = [];
    t.mock.method(SshManager, 'getInstance', () => ({
        getMergedHosts: () => [{ alias: 'cs-lab-k1aaaaaa', clusterConfigId: 'k1aaaaaaaa', source: 'cybershuttle' }],
        runRemoteCommand: async (_: string, c: string) => { commands.push(c); return ''; },
    }) as never);
    const aws = { ec2: undefined, ready: async () => { throw new Error('signed out'); }, onDidSignIn: () => ({ dispose() { } }) };
    const p = new SessionProvider(vscode.Uri.parse('/ext'), { ...linkTransports, plane: plane as never }, aws);
    t.after(() => p.dispose());
    const posted: { command: string; state: SessionsState }[] = [];
    let receive: (m: SessionsMessage) => void = () => { };
    p.resolveWebviewView({
        webview: { options: {}, html: '', cspSource: 'x', asWebviewUri: (u: unknown) => u, postMessage: async (m: { command: string; state: SessionsState }) => { posted.push(m); return true; }, onDidReceiveMessage: (l: (m: SessionsMessage) => void) => { receive = l; return { dispose() { } }; } },
        visible: true, onDidChangeVisibility: () => ({ dispose() { } }), onDidDispose: () => ({ dispose() { } }),
    } as never);
    return { receive, state: () => posted.at(-1)?.state, commands };
}

test('Add on a CyberShuttle host creates and launches the session through the CyberShuttle API', async (t) => {
    const calls: unknown[][] = [];
    const plane = { deployments: async () => [{ deploymentId: 'd1', label: 'Base' }], createSession: async (...a: unknown[]) => { calls.push(a); return planeResponse({}, { state: 'SUBMITTED', startedAt: null, deadline: null }); } };
    const { receive, state, commands } = provider(t, plane);
    quickPick.minutes = 120;
    receive({ command: 'addSession', alias: 'cs-lab-k1aaaaaa', account: '', partition: 'cpu', rootFolder: '/work/u1', resources: { cores: 2, memoryMb: 4096, wallMinutes: 0 } });
    await sleep(20);
    quickPick.minutes = 0;
    assert.deepEqual(calls, [['k1aaaaaaaa', { account: '', partition: 'cpu', resources: { cores: 2, memoryMb: 4096, wallMinutes: 0 } }, 120, { deploymentId: 'd1', label: 'Base' }]]);
    assert.deepEqual(commands, [], 'no SSH');
    const s = must(getSession('s1'));
    assert.deepEqual([s.alias, s.rootFolder, statusOf(s)], ['cs-lab-k1aaaaaa', '/work/u1/p1', 'queued']);
    assert.equal(state()?.draftAlias, null);
});

test('a launch the CyberShuttle API answers as failed shows its reason on the card', async (t) => {
    const plane = { deployments: async () => [{ deploymentId: 'd1', label: 'Base' }], createSession: async () => planeResponse({}, { state: 'FAILED', error: 'the deployment has no template' }) };
    const { receive } = provider(t, plane);
    receive({ command: 'addSession', alias: 'cs-lab-k1aaaaaa', account: 'lab-alloc', partition: 'cpu', rootFolder: '/work/u1', resources: { cores: 2, memoryMb: 4096, wallMinutes: 0 } });
    await sleep(20);
    const s = must(getSession('s1'));
    assert.deepEqual([statusOf(s), s.failure], ['failed', 'the deployment has no template']);
});

test('a create the CyberShuttle API refuses shows its message in the form\'s alert', async (t) => {
    const plane = { deployments: async () => [{ deploymentId: 'd1', label: 'Base' }], createSession: async () => { throw new PlaneError(400, 'Allocation cannot be blank'); } };
    const { receive, state } = provider(t, plane);
    receive({ command: 'addSession', alias: 'cs-lab-k1aaaaaa', account: '', partition: 'cpu', rootFolder: '/work/u1', resources: { cores: 2, memoryMb: 4096, wallMinutes: 0 } });
    await sleep(20);
    assert.deepEqual(state()?.alert, { title: 'Could not add session', message: 'Allocation cannot be blank' });
    assert.equal(state()?.validating, false);
});

test('Start runs an ended session again with the picked walltime, showing submitting until it answers', async (t) => {
    const s = planeSession(planeResponse({}, { state: 'COMPLETED' }));
    const started = Promise.withResolvers<SessionResponse>();
    const calls: unknown[][] = [];
    const { receive, state } = provider(t, { startSession: (...a: unknown[]) => { calls.push(a); return started.promise; } });
    quickPick.minutes = 60;
    receive({ command: 'prepareLaunchSession', sessionId: 's1' });
    await sleep(20);
    quickPick.minutes = 0;
    assert.deepEqual(calls, [['s1', 60]]);
    assert.equal(statusOf(s), 'submitting');
    started.resolve(planeResponse({}, { processId: 'p2', state: 'SUBMITTED', startedAt: null, deadline: null }));
    await sleep(20);
    assert.deepEqual([s.jobId, statusOf(s)], ['p2', 'queued']);
    addSession(newSession({ alias: 'lab', account: '', partition: 'cpu', rootFolder: '/home/u', resources: { cores: 1, memoryMb: 1024, wallMinutes: 30 } }));
    await sleep(20);
    assert.equal(must(state()).sessions[0]?.id, 's1', 'CyberShuttle sessions list first');
});

test('a Start answered as failed after one that threw shows the run\'s reason, not the old error', async (t) => {
    const s = planeSession(planeResponse({}, { state: 'COMPLETED' }));
    let answer = (): Promise<SessionResponse> => Promise.reject(new Error('network down'));
    const { receive, state } = provider(t, { startSession: () => answer() });
    receive({ command: 'prepareLaunchSession', sessionId: 's1' });
    await sleep(20);
    assert.match(s.errorMessage, /network down/);
    answer = async () => planeResponse({}, { processId: 'p2', state: 'FAILED', error: 'the deployment has no template' });
    receive({ command: 'prepareLaunchSession', sessionId: 's1' });
    await sleep(20);
    const card = must(state()?.sessions.find(x => x.id === 's1'));
    assert.deepEqual([card.status, card.errorMessage || card.failure], ['failed', 'the deployment has no template'], 'the card\'s reason');
});

const confirm = (t: TestContext) => t.mock.method(vscode.window, 'showWarningMessage', async (_: string, __: unknown, label: string) => label);
function errors(t: TestContext): string[] {
    const shown: string[] = [];
    t.mock.method(vscode.window, 'showErrorMessage', async (m: string) => { shown.push(m); });
    return shown;
}

test('Stop on a CyberShuttle session stops its current run from this window, owner or not', async (t) => {
    const s = planeSession();
    await files.write('windows/other.json', JSON.stringify({ at: Date.now() }));
    await windows.reload('other');
    await patch(s, { owner: 'other' });
    const stopped = Promise.withResolvers<void>();
    const calls: string[] = [];
    const { receive } = provider(t, { stopProcess: (id: string) => { calls.push(id); return stopped.promise; } });
    confirm(t);
    receive({ command: 'stopSessionExecution', sessionId: 's1' });
    await sleep(20);
    assert.deepEqual(calls, ['p1']);
    assert.equal(statusOf(s), 'stopping');
    stopped.resolve();
    applyPlane(planeResponse({}, { state: 'CANCELLED' }));
    assert.equal(statusOf(s), 'stopped');
});

test('a Stop during a CyberShuttle Start asks to wait instead of dropping it', async (t) => {
    const s = planeSession(planeResponse({}, { state: 'COMPLETED' }));
    const started = Promise.withResolvers<SessionResponse>();
    const stops: string[] = [];
    const { receive } = provider(t, { startSession: () => started.promise, stopProcess: async (id: string) => { stops.push(id); } });
    const told: string[] = [];
    t.mock.method(vscode.window, 'showInformationMessage', async (m: string) => { told.push(m); });
    receive({ command: 'prepareLaunchSession', sessionId: 's1' });
    await sleep(20);
    receive({ command: 'stopSessionExecution', sessionId: 's1' });
    await sleep(20);
    assert.deepEqual([stops, told], [[], ['Wait for the start to finish, then stop.']]);
    started.resolve(planeResponse({}, { processId: 'p2', state: 'SUBMITTED', startedAt: null, deadline: null }));
    await sleep(20);
    assert.equal(statusOf(s), 'queued');
});

// Review Focus 5
test('a refused Stop leaves the session running with the reason, and a remote window stays', async (t) => {
    const s = planeSession();
    const plane = { stopProcess: async () => { throw new PlaneError(502, 'scancel failed'); } };
    const shown = errors(t);
    const { receive } = provider(t, plane);
    confirm(t);
    receive({ command: 'stopSessionExecution', sessionId: 's1' });
    await sleep(20);
    assert.equal(statusOf(s), 'preparing');
    assert.match(s.errorMessage, /scancel failed/);
    const closed: string[] = [];
    t.mock.method(vscode.commands, 'executeCommand', async (c: string) => { closed.push(c); });
    const items: { text: string }[] = [];
    t.mock.method(vscode.window, 'createStatusBarItem', () => { const i = { text: '', show() { }, hide() { }, dispose() { } }; items.push(i); return i; });
    const remote = new RemoteSessionController({} as never, 's1', plane);
    shown.length = 0;
    await must(registered.get('csbridge.stopRemoteSession'))();
    assert.equal(closed.includes('workbench.action.remote.close'), false);
    assert.ok(shown.some(m => /scancel failed/.test(m)));
    assert.equal(items[1]?.text, '$(debug-stop) Stop', 'Stop is restored');
    remote.dispose();
});

test('a Stop that succeeds after a refused one leaves no stale error', async (t) => {
    const s = planeSession();
    let answer = async (): Promise<void> => { throw new PlaneError(502, 'scancel failed'); };
    const { receive } = provider(t, { stopProcess: () => answer() });
    confirm(t);
    receive({ command: 'stopSessionExecution', sessionId: 's1' });
    await sleep(20);
    assert.match(s.errorMessage, /scancel failed/);
    answer = async () => { };
    receive({ command: 'stopSessionExecution', sessionId: 's1' });
    await sleep(20);
    assert.equal(statusOf(s), 'stopping');
    assert.equal(s.errorMessage, '');
});

test('a run replaced while the monitor prepares it gets none of the old run\'s ports', async () => {
    const s = planeSession();
    const answered = Promise.withResolvers<{ bind_port: number }>();
    const transport = { label: 'fake', tunnelRef: () => ({ tunnelId: s.jobId }), ensureTunnel: async () => { }, withLinkspan: () => answered.promise };
    const monitor: SessionMonitor = new SessionMonitor(new Backends(new SlurmBackend({ ...linkTransports, transportFor: () => transport as never }, () => monitor), {} as never));
    monitor.startMonitoring(s); // the first tick asks p1's Linkspan for its sshd
    await sleep(5);
    applyPlane(planeResponse({}, { processId: 'p2' }));
    answered.resolve({ bind_port: 40 });
    await sleep(20);
    assert.equal(JSON.parse(must(files.texts.get('plane/s1.json'))).ports, undefined);
    assert.equal(s.connectionInfo?.sshPort, 0);
    await monitor.quiesce(s);
});

test('Delete removes the session from the CyberShuttle API, then its local parts', async (t) => {
    planeSession(planeResponse({}, { state: 'COMPLETED' }));
    const calls: string[] = [];
    const { receive } = provider(t, { deleteSession: async (id: string) => { calls.push(id); } });
    confirm(t);
    receive({ command: 'deleteSession', sessionId: 's1' });
    await sleep(20);
    assert.deepEqual(calls, ['s1']);
    assert.equal(getSession('s1'), undefined);
    assert.deepEqual(planeParts(), []);
});

// Review Focus 4
test('a Delete the CyberShuttle API refuses keeps everything local', async (t) => {
    planeSession(planeResponse({}, { state: 'COMPLETED' }));
    const shown = errors(t);
    const { receive } = provider(t, { deleteSession: async () => { throw new PlaneError(409, 'the session is live'); } });
    confirm(t);
    receive({ command: 'deleteSession', sessionId: 's1' });
    await sleep(20);
    assert.ok(getSession('s1'));
    assert.deepEqual(planeParts().map(([id]) => id), ['s1']);
    assert.ok(shown.some(m => /the session is live/.test(m)));
});
