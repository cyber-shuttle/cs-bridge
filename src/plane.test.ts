import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { CREDENTIAL_KEY, Plane, PlaneError, PLANE_URL } from './plane';

// A real HTTP server stands in for cs-plane; the client's fetch is the real one, only pointed at it.
async function plane(t: TestContext, answer: (path: string) => { status?: number; body: unknown }, stored?: object) {
    const secrets = new Map<string, string>(stored ? [[CREDENTIAL_KEY, JSON.stringify(stored)]] : []);
    const calls: { path: string; method: string; headers: IncomingHttpHeaders }[] = [];
    const server = createServer((req, res) => {
        const path = req.url!.slice('/api/v1/'.length);
        calls.push({ path, method: req.method!, headers: req.headers });
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
    const { calls, client } = await plane(t, path => ({ body: path === 'oauth/refresh'
        ? { idToken: 'new', expiresInSeconds: 900 }
        : { jupyter: { token: 't' } } }), { idToken: 'old', expiresAt: 0 });

    const [, access] = await Promise.all([client.stopSession('s1'), client.sessionAccess('s1')]);
    await client.deleteSession('s1');

    assert.deepEqual(calls.map(c => `${c.method} ${c.path}`).sort(), ['DELETE sessions/s1', 'GET sessions/s1/access', 'POST oauth/refresh', 'POST sessions/s1/stop']);
    assert.equal(calls[0].path, 'oauth/refresh');
    assert.deepEqual(access, { jupyter: { token: 't' } });
    assert.ok(calls.slice(1).every(c => c.headers.authorization === 'Bearer new'));
});

test('a refused refresh (expired) or a 401 (live) signs out', async (t) => {
    for (const expiresAt of [0, Date.now() + 3_600_000]) {
        const { secrets, client } = await plane(t, path => ({ status: path === 'oauth/refresh' ? 400 : 401, body: {} }), { expiresAt });
        await assert.rejects(client.sessionAccess('s1'));
        assert.equal(secrets.size, 0);
    }
});

test('an error keeps cs-plane\'s code and message', async (t) => {
    const { client } = await plane(t, () => ({ status: 409, body: { error: { code: 'session_access_unavailable', message: 'the session is queued' } } }),
        { idToken: 'id', expiresAt: Date.now() + 3_600_000 });
    await assert.rejects(client.sessionAccess('s1'), (err: PlaneError) => err.code === 'session_access_unavailable' && err.message === 'the session is queued');
});
