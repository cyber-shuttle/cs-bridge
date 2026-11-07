import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { CREDENTIAL_KEY, Plane, PlaneError, PLANE_URL } from './plane';
import { must } from './modules/testSupport';

// A real HTTP server stands in for the CyberShuttle API; the client's fetch is the real one, only pointed at it.
async function plane(t: TestContext, answer: (path: string) => { status?: number; body: unknown }, stored?: object) {
    const secrets = new Map<string, string>(stored ? [[CREDENTIAL_KEY, JSON.stringify(stored)]] : []);
    const calls: { path: string; method: string; headers: IncomingHttpHeaders; body: string }[] = [];
    const server = createServer(async (req, res) => {
        const path = String(req.url).slice('/api/v1/'.length);
        calls.push({ path, method: String(req.method), headers: req.headers, body: String(await req.toArray()) });
        const { status = 200, body } = answer(path);
        res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    }).listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => server.close());
    const local = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
    const store = { get: async (key: string) => secrets.get(key), store: async (key: string, value: string) => void secrets.set(key, value), delete: async (key: string) => void secrets.delete(key) };
    return { calls, secrets, client: new Plane(store, (url, init) => fetch(String(url).replace(PLANE_URL, local), init)) };
}

test('calls carry the bearer, refreshing once when near expiry', async (t) => {
    const { calls, client } = await plane(t, path => ({ body: path === 'auth/token'
        ? { id_token: 'new', expires_in: 900 }
        : { app: { uri: 'u', token: 't' } } }), { idToken: 'old', refreshToken: 'r', expiresAt: 0 });

    const [, access] = await Promise.all([client.stopProcess('s1'), client.processAccess('s1')]);

    assert.deepEqual(calls.map(c => `${c.method} ${c.path}`).sort(), ['GET processes/s1/access', 'POST auth/token', 'POST processes/s1/stop']);
    assert.equal(calls[0]?.path, 'auth/token');
    assert.deepEqual(access, { app: { uri: 'u', token: 't' } });
    assert.ok(calls.slice(1).every(c => c.headers.authorization === 'Bearer new'));
});

test('a refused refresh (expired) or a 401 (live) signs out', async (t) => {
    for (const expiresAt of [0, Date.now() + 3_600_000]) {
        const { secrets, client } = await plane(t, path => ({ status: path === 'auth/token' ? 400 : 401, body: {} }), { expiresAt });
        await assert.rejects(client.processAccess('s1'));
        assert.equal(secrets.size, 0);
    }
});

const live = { idToken: 'id', expiresAt: Date.now() + 3_600_000 };

test('an error keeps the CyberShuttle API\'s status and message', async (t) => {
    const { client } = await plane(t, () => ({ status: 409, body: { status: 409, error: 'Conflict', message: 'the job has no link yet' } }), live);
    await assert.rejects(client.processAccess('s1'), (err: PlaneError) => err.status === 409 && err.message === 'the job has no link yet');
});

test('a CyberShuttle host\'s form and deployments come from the CyberShuttle API', async (t) => {
    const { client } = await plane(t, path => ({ body: {
        'slurm-cluster-configs/k1': { slurmClusterConfigId: 'k1', slurmClusterId: 'c1', workRoot: '/work/u1' },
        'slurm-cluster-configs/k1/discover-allocations': { allocations: [{ account: 'lab-alloc', partitions: [] }],
            partitions: [{ name: 'gpu', cpuPerNode: 64, maxMemory: 512000, gres: 'gpu:a100:4(S:0-1),tmpdisk:100G' }, { name: 'cpu', maxProcessors: 32 }] },
        'slurm-deployments': [{ deploymentId: 'd2', slurmClusterId: 'c2' }, { deploymentId: 'd1', slurmClusterId: 'c1', templateId: 't1' },
            { deploymentId: 'd3', slurmClusterId: 'c1', templateId: 't3' }],
        'application-templates': [{ templateId: 't1', templateName: 'JupyterLab' }, { templateId: 't3', templateName: 'Base' }],
    }[path] ?? {} }), live);
    assert.deepEqual(await client.discovery('k1'), { accounts: ['lab-alloc'], homeDir: '/work/u1', partitions: [
        { name: 'gpu', cpuCount: 64, memoryMb: 512000, gres: [{ name: 'gpu:a100', count: 4 }] }, { name: 'cpu', cpuCount: 32, memoryMb: 0, gres: [] }] });
    assert.deepEqual(await client.deployments('k1'), [{ deploymentId: 'd3', label: 'Base' }, { deploymentId: 'd1', label: 'JupyterLab' }], 'only its cluster\'s, Base first');
});

test('a CyberShuttle cluster config reuses a prompt-only credential, creating one only when none is held', async (t) => {
    for (const held of [[{ sshCredentialId: 'key' }, { sshCredentialId: 'ask', fullInteractive: true }], [{ sshCredentialId: 'key' }]]) {
        const { calls, client } = await plane(t, () => ({ body: calls.length === 1 ? held : { sshCredentialId: 'ask' } }), live);
        await client.addClusterConfig('c1', 'me', '/home/me/cybershuttle');
        assert.deepEqual(calls.map(c => `${c.method} ${c.path}`), ['GET ssh-credentials', ...held.length > 1 ? [] : ['POST ssh-credentials'], 'POST slurm-cluster-configs']);
        if (held.length === 1) { assert.deepEqual(JSON.parse(must(calls[1]).body), { sshCredentialName: 'Ask at each login', fullInteractive: true }); }
        assert.deepEqual(JSON.parse(must(calls.at(-1)).body), { slurmClusterId: 'c1', loginUser: 'me', workRoot: '/home/me/cybershuttle', sshCredentialId: 'ask' });
    }
});

test('a device sign-in starts at the CyberShuttle API, polls until complete and stores the tokens', async (t) => {
    let polls = 0;
    const { calls, secrets, client } = await plane(t, path => path === 'auth/device' ? { body: { device_code: 'dc', interval: 0 } }
        : polls++ ? { body: { id_token: 'id', refresh_token: 'r', expires_in: 3600 } }
            : { status: 202, body: { status: 202, error: 'Accepted', message: 'The device code is not approved yet' } });
    assert.equal(await client.awaitSignIn(await client.startSignIn(), () => false), true);
    assert.deepEqual(calls.map(c => `${c.method} ${c.path}`), ['POST auth/device', 'POST auth/token', 'POST auth/token']);
    assert.equal(JSON.parse(must(secrets.get(CREDENTIAL_KEY))).refreshToken, 'r');
});

test('a login raised after the start returned is asked in this window, which names itself on every call', async () => {
    const answered = Promise.withResolvers<unknown>();
    const connections = new Set<string | null>();
    let launched = false;
    const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
    const client = new Plane({ get: async () => JSON.stringify(live), store: async () => undefined, delete: async () => undefined }, async (url, init) => {
        const path = String(url).slice(PLANE_URL.length + 1);
        connections.add(new Headers(init?.headers).get('X-Connection-Id'));
        if (path === 'sessions/s1/start') { launched = true; }
        else if (path === 'ssh-interactive-auths') { return json(launched ? [{ authId: 'a1', hostName: 'login.example.org', loginUser: 'u1', banner: 'Welcome', prompts: [{ text: 'Passcode: ' }] }] : []); }
        else { answered.resolve([path, JSON.parse(String(init?.body))]); }
        return json({});
    });
    await client.startSession('s1', 60);
    const answering = client.answerLogins(async (host, prompt) => `${host}|${prompt}`);
    assert.deepEqual(await answered.promise, ['ssh-interactive-auths/a1/response', { responses: ['u1@login.example.org|Welcome\nPasscode: '] }]);
    answering.dispose();
    assert.equal(connections.size, 1);
    assert.match(String([...connections][0]), /^[0-9a-f-]{36}$/);
});

test('sessions are listed, created, started and deleted at /sessions', async (t) => {
    const { calls, client } = await plane(t, path => ({ status: path === 'sessions/s1' ? 204 : path === 'sessions' ? 201 : 200, body: path === 'sessions/me' ? [] : { sessionId: 's1' } }), live);
    await client.sessions();
    const deployment = { deploymentId: 'd1', label: 'Base' };
    await client.createSession('k1', { account: '', partition: 'gpu', resources: { cores: 8, memoryMb: 32768, wallMinutes: 0, gpuType: 'a100', gpuCount: 2 } }, 120, deployment);
    await client.createSession('k1', { account: 'mine', partition: 'gpu', resources: { cores: 1, memoryMb: 1024, wallMinutes: 0, gpuType: 'gpu', gpuCount: 1 } }, 30, deployment);
    await client.startSession('s1', 60);
    await client.deleteSession('s1');
    assert.deepEqual(calls.map(c => `${c.method} ${c.path}`), ['GET sessions/me', 'POST sessions', 'POST sessions', 'POST sessions/s1/start', 'DELETE sessions/s1']);
    assert.deepEqual(JSON.parse(must(calls[1]).body), { slurmClusterConfigId: 'k1', deploymentId: 'd1', account: '', partition: 'gpu',
        resources: { cores: 8, memoryMb: 32768, wallMinutes: 120, gpuCount: 2, gpuType: 'a100' } }, 'the account goes as is');
    assert.deepEqual(JSON.parse(must(calls[2]).body).resources, { cores: 1, memoryMb: 1024, wallMinutes: 30, gpuCount: 1 }, 'any GPU names no type');
    assert.deepEqual(JSON.parse(must(calls[3]).body), { wallMinutes: 60 });
});
