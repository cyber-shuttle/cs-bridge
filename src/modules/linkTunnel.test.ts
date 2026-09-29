import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as net from 'node:net';
import { once } from 'node:events';
import { LinkRelayClient } from './linkTunnel';

test('a forwarded port bridges each 127.0.0.1 connection to its own cs-plane forward socket', async () => {
    const opened: [string, string[]][] = [];
    class EchoSocket {
        onopen?: () => void;
        onmessage?: (event: { data: ArrayBuffer }) => void;
        constructor(url: string, protocols: string[]) { opened.push([url, protocols]); setImmediate(() => this.onopen?.()); }
        send(data: Uint8Array) { this.onmessage?.({ data: Uint8Array.from(data).buffer }); }
        close() { }
    }
    const relay = new LinkRelayClient(EchoSocket as never);
    await relay.connect({ tunnelId: 'p1', accessTokens: { connect: 'tok' } });
    await relay.waitForForwardedPort(22);

    const socket = net.connect(relay.forwardedPorts[0].localPort, '127.0.0.1');
    socket.write('ping');
    const [echo] = await once(socket, 'data');
    assert.equal(String(echo), 'ping');
    assert.deepEqual(opened, [['wss://jupyterapi.cybershuttle.org/api/v1/sessions/p1/forward/22', ['cybershuttle.v1', 'capability.tok']]]);

    await relay.dispose();
    await once(socket, 'close');
    await assert.rejects(relay.waitForForwardedPort(22));
});
