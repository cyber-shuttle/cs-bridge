import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as net from 'node:net';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { server as WebSocketServer, w3cwebsocket } from 'websocket';
import { LinkManagementClient, LinkRelayClient } from './linkTunnel';
import { PlaneError } from '../plane';
import { must } from './testSupport';
import type { SlurmSession } from '../models';

test('each link run replaces the Airavata session', async () => {
    const calls: (string | number)[] = [];
    const plane = {
        createSession: async (s: SlurmSession) => { calls.push(s.resources.wallMinutes); return { id: 'p' }; },
        stopSession: async () => { calls.push('stop'); }, deleteSession: async () => { calls.push('delete'); },
    };
    const client = new LinkManagementClient(plane as never);
    const session = { resources: { wallMinutes: 30 } } as SlurmSession;
    assert.equal(await client.defineTunnel(session, 60), 'p');
    assert.deepEqual(calls, [60], 'a new session has nothing to replace');

    calls.length = 0;
    await client.defineTunnel({ ...session, planeId: 'p' }, 120);
    assert.deepEqual(calls, ['stop', 'delete', 120]);

    plane.stopSession = async () => { throw new PlaneError(404, 'gone'); };
    calls.length = 0;
    await client.defineTunnel({ ...session, planeId: 'p' }, 120);
    assert.deepEqual(calls, [120], 'a session deleted elsewhere is defined again');

    plane.stopSession = async () => { throw new PlaneError(500, 'down'); };
    await assert.rejects(client.defineTunnel({ ...session, planeId: 'p' }, 120), /down/);
});

// A local stand-in for cs-plane's forward: a real WebSocket server that accepts cybershuttle.v1 and pipes each socket to
// a real TCP echo server. The relay dials it over a real WebSocket; only the host differs from cs-plane's.
test('a forwarded port bridges each 127.0.0.1 connection to its own cs-plane forward socket', async () => {
    const echo = net.createServer(s => s.pipe(s)).listen(0, '127.0.0.1');
    const http = createServer().listen(0, '127.0.0.1');
    await Promise.all([once(echo, 'listening'), once(http, 'listening')]);
    const forward = new WebSocketServer({ httpServer: http });
    const offered: string[][] = [];
    forward.on('request', (request) => {
        offered.push(request.requestedProtocols);
        const ws = request.accept('cybershuttle.v1');
        const tcp = net.connect((echo.address() as net.AddressInfo).port, '127.0.0.1');
        tcp.on('data', data => ws.sendBytes(data));
        ws.on('message', ({ binaryData }) => tcp.write(must(binaryData)));
        ws.on('close', () => tcp.destroy());
    });
    const dialed: string[] = [];
    class LocalSocket extends w3cwebsocket {
        constructor(...[url, protocols]: ConstructorParameters<typeof w3cwebsocket>) {
            dialed.push(String(url));
            super(`ws://127.0.0.1:${(http.address() as net.AddressInfo).port}/`, protocols);
        }
    }

    const relay = new LinkRelayClient(LocalSocket);
    await relay.connect({ tunnelId: 'p1', accessTokens: { connect: 'tok' } });
    await relay.waitForForwardedPort(22);
    const socket = net.connect(relay.forwardedPorts[0]?.localPort ?? 0, '127.0.0.1');
    socket.write('ping');
    const [reply] = await once(socket, 'data');
    assert.equal(String(reply), 'ping');
    assert.deepEqual(dialed, ['wss://jupyterapi.cybershuttle.org/api/v1/sessions/p1/forward/22']);
    assert.deepEqual(offered, [['cybershuttle.v1', 'capability.tok']]);

    await relay.dispose();
    await once(socket, 'close');
    await assert.rejects(relay.waitForForwardedPort(22));
    forward.shutDown();
    echo.close();
    http.close();
});
