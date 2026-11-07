import { afterEach, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryFiles } from './memoryFiles';
import { must, planeResponse } from './testSupport';
import type { JsonDir } from './store';
import { sleep } from './util';
import { initSessionStore, getAllSessions, getSession, deleteSession, patch } from '../extensionStore';
import { initRunStore } from './runStore';
import { PlaneParts, initPlaneStore, applyPlane, planeSessions, planeParts, refreshPlane, onPlaneChange } from './planeSessions';
import { isPlane, SessionResponse } from '../models';
import type { ClusterConfig } from '../plane';

const files = memoryFiles();
const fail = (err: unknown) => assert.fail(String(err));
let partsDir: JsonDir<PlaneParts>;
before(async () => { await initSessionStore(files, fail); await initRunStore(files, fail); partsDir = await initPlaneStore(files, fail); });
afterEach(() => { for (const id of [...getAllSessions().map(s => s.id), ...planeParts().map(([id]) => id)]) { deleteSession(id); } });

const api = (list: SessionResponse[], configs = new Map<string, ClusterConfig>()) => ({
    signedIn: async () => true,
    sessions: async () => list,
    clusterConfig: async (id: string) => must(configs.get(id)),
});

test('a listed session joins with its local parts, which the listing never overwrites', async () => {
    applyPlane(planeResponse(), { alias: 'cs-lab-k1aaaaaa', rootFolder: '/work/u1' });
    const s = must(getSession('s1'));
    assert.ok(isPlane(s));
    assert.deepEqual([s.alias, s.name, s.rootFolder, s.jobId, s.transport, s.account, s.partition], ['cs-lab-k1aaaaaa', '1790000000123', '/work/u1/p1', 'p1', 'link', 'lab-alloc', 'cpu']);
    assert.deepEqual(s.connectionInfo, { sshPort: 0, controlPort: 21234 });
    await patch(s, { owner: 'w1', connectionInfo: { sshPort: 40, controlPort: 21234, localPort: 5 }, errorMessage: 'probe failed' });
    assert.deepEqual(JSON.parse(must(files.texts.get('plane/s1.json'))), { alias: 'cs-lab-k1aaaaaa', name: '1790000000123', rootFolder: '/work/u1', owner: 'w1', ports: { processId: 'p1', sshPort: 40, localPort: 5 } });
    await refreshPlane(api([planeResponse()]), fail);
    assert.equal(getSession('s1'), s, 'one object per id');
    assert.equal(s.errorMessage, 'probe failed', 'in-memory fields survive a listing');
    assert.deepEqual(s.connectionInfo, { sshPort: 40, controlPort: 21234, localPort: 5 });
});

test('ports count only for the run they name', async () => {
    applyPlane(planeResponse(), { alias: 'cs-lab-k1aaaaaa', rootFolder: '/work/u1' });
    const s = must(getSession('s1'));
    await patch(s, { connectionInfo: { sshPort: 40, controlPort: 21234, localPort: 5 } });
    applyPlane(planeResponse({}, { processId: 'p2', state: 'SUBMITTED', startedAt: null, deadline: null }));
    assert.deepEqual(s.connectionInfo, { sshPort: 0, controlPort: 21234 }, 'a new run starts without the old ports');
    applyPlane(planeResponse({}, { processId: 'p2', state: 'COMPLETED' }));
    assert.equal(s.connectionInfo, undefined, 'an ended run with no ports of its own has nothing to tear down');
});

test('a session made elsewhere gets its parts from its cluster config on first listing', async () => {
    const configs = new Map([['k1aaaaaaaa', { slurmClusterConfigId: 'k1aaaaaaaa', name: 'lab', slurmClusterId: 'c1', loginUser: 'u1', workRoot: '/work/u1' }]]);
    await refreshPlane(api([planeResponse(), planeResponse({ sessionId: 's2', slurmClusterConfigId: 'gone' })], configs), fail);
    await sleep(5);
    assert.deepEqual(JSON.parse(must(files.texts.get('plane/s1.json'))), { alias: 'cs-lab-k1aaaaaa', name: '1790000000123', rootFolder: '/work/u1' });
    assert.deepEqual(planeSessions().map(s => s.id), ['s1'], 'a session whose config cannot be read stays unlisted');
});

// Review Focus 2
test('a listing begun before another window wrote parts does not prune them', async () => {
    const listing = Promise.withResolvers<SessionResponse[]>();
    const gone: string[] = [];
    const refreshed = refreshPlane({ ...api([]), sessions: () => listing.promise }, id => gone.push(id));
    await files.write('plane/s9.json', JSON.stringify({ alias: 'a', name: '1', rootFolder: '/w' })); // another window's adopt
    await partsDir.reload('s9'); // as the watcher reports it
    listing.resolve([]);
    await refreshed;
    assert.equal(gone.length, 0);
    await refreshPlane(api([]), id => gone.push(id));
    assert.deepEqual(gone, ['s9'], 'a later listing prunes parts it does not list');
});

test('a listing begun before a local create does not hide it', async () => {
    const listing = Promise.withResolvers<SessionResponse[]>();
    const refreshed = refreshPlane({ ...api([]), sessions: () => listing.promise }, fail);
    applyPlane(planeResponse(), { alias: 'cs-lab-k1aaaaaa', rootFolder: '/work/u1' });
    listing.resolve([]);
    await refreshed;
    assert.deepEqual(planeSessions().map(s => s.id), ['s1']);
});

test('a listing begun before another window deleted the parts does not adopt them back', async () => {
    const configs = new Map([['k1aaaaaaaa', { slurmClusterConfigId: 'k1aaaaaaaa', name: 'lab', slurmClusterId: 'c1', loginUser: 'u1', workRoot: '/work/u1' }]]);
    await files.write('plane/s1.json', JSON.stringify({ alias: 'cs-lab-k1aaaaaa', name: '1790000000123', rootFolder: '/work/u1' }));
    await partsDir.reload('s1');
    const listing = Promise.withResolvers<SessionResponse[]>();
    const refreshed = refreshPlane({ ...api([], configs), sessions: () => listing.promise }, fail);
    await files.remove('plane/s1.json'); // another window's delete
    await partsDir.reload('s1');
    listing.resolve([planeResponse()]);
    await refreshed;
    await sleep(5);
    assert.deepEqual(planeParts(), []);
    assert.equal(files.texts.get('plane/s1.json'), undefined);
});

test('an adopt that another window finished first keeps its owner', async () => {
    const config = { slurmClusterConfigId: 'k1aaaaaaaa', name: 'lab', slurmClusterId: 'c1', loginUser: 'u1', workRoot: '/work/u1' };
    const theirs = { alias: 'cs-lab-k1aaaaaa', name: '1790000000123', rootFolder: '/work/u1', owner: 'w2' };
    const clusterConfig = async () => { await files.write('plane/s1.json', JSON.stringify(theirs)); return config; }; // before the watcher reports it
    await refreshPlane({ ...api([planeResponse()]), clusterConfig }, fail);
    await sleep(5);
    assert.deepEqual(JSON.parse(must(files.texts.get('plane/s1.json'))), theirs);
});

test('signed out lists nothing, a failed listing keeps the last, an unchanged one emits nothing', async () => {
    applyPlane(planeResponse(), { alias: 'cs-lab-k1aaaaaa', rootFolder: '/work/u1' });
    let changes = 0;
    const sub = onPlaneChange(() => changes++);
    await refreshPlane({ ...api([]), sessions: async () => { throw new Error('offline'); } }, fail);
    await refreshPlane(api([planeResponse()]), fail);
    assert.equal(changes, 0);
    await refreshPlane({ ...api([]), signedIn: async () => false }, fail);
    assert.deepEqual(planeSessions(), []);
    assert.deepEqual(planeParts().map(([id]) => id), ['s1'], 'signing out keeps the parts');
    sub.dispose();
});
