import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CREDENTIAL_KEY, Plane, PLANE_URL } from './plane';

function plane(answer: (path: string) => Response, stored?: object) {
    const secrets = new Map<string, string>(stored ? [[CREDENTIAL_KEY, JSON.stringify(stored)]] : []);
    const calls: { path: string; method: string; headers: Record<string, string> }[] = [];
    const fetchFake = (async (url: string, init: RequestInit) => {
        const call = { path: url.slice(PLANE_URL.length + 1), method: init.method!, headers: init.headers as Record<string, string> };
        calls.push(call);
        return answer(call.path);
    }) as typeof fetch;
    return {
        calls, secrets,
        client: new Plane({ get: async key => secrets.get(key), store: async (key, value) => void secrets.set(key, value), delete: async key => void secrets.delete(key) }, fetchFake),
    };
}

test('calls carry the bearer, refreshing once when near expiry', async () => {
    const { calls, client } = plane(path => Response.json(path === 'oauth/refresh'
        ? { idToken: 'new', expiresInSeconds: 900 }
        : { jupyter: { token: 't' } }), { idToken: 'old', expiresAt: 0 });

    const [, access] = await Promise.all([client.stopSession('s1'), client.sessionAccess('s1')]);
    await client.deleteSession('s1');

    assert.deepEqual(calls.map(c => `${c.method} ${c.path}`), ['POST oauth/refresh', 'POST sessions/s1/stop', 'GET sessions/s1/access', 'DELETE sessions/s1']);
    assert.deepEqual(access, { jupyter: { token: 't' } });
    assert.equal(calls[1].headers.Authorization, 'Bearer new');
});

test('a refused refresh (expired) or a 401 (live) signs out', async () => {
    for (const expiresAt of [0, Date.now() + 3_600_000]) {
        const { secrets, client } = plane(path => Response.json({}, { status: path === 'oauth/refresh' ? 400 : 401 }), { expiresAt });
        await assert.rejects(client.sessionAccess('s1'));
        assert.equal(secrets.size, 0);
    }
});
