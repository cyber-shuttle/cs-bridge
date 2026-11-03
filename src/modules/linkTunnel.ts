// The link transport's tunnel clients, shaped like the Dev Tunnels SDK's so transport's session-level functions
// drive either pair. The tunnel is the run's CyberShuttle API process and its connect token the run token from `/access`.
// A ForwardRelayClient has no upstream connection of its own: each forwarded port is a 127.0.0.1 listener whose every
// accepted socket rides a fresh WebSocket to Linkspan's forward: through the CyberShuttle API's proxy for link, over a Dev Tunnel otherwise.
import * as net from 'node:net';
import { Plane, PLANE_URL } from '../plane';
import type { TunnelRef, TunnelRelayClient } from './transport';

export class LinkManagementClient {
    constructor(private readonly plane: Plane) { }

    // The CyberShuttle API answers /access only for a linked run, and 409 before, so this also gates on Linkspan holding its link.
    async getTunnel({ tunnelId }: TunnelRef): Promise<TunnelRef> {
        return { tunnelId, accessTokens: { connect: (await this.plane.processAccess(tunnelId)).app.token } };
    }
}

export class ForwardRelayClient {
    readonly forwardedPorts: { remotePort: number; localPort: number }[] = [];
    private readonly listeners: Promise<net.Server>[] = [];
    private readonly sockets = new Set<net.Socket>();
    private disposed = false;
    protected forwardUrl: (port: number) => string = () => '';

    constructor(private readonly WebSocket: typeof globalThis.WebSocket = globalThis.WebSocket) { }

    async waitForForwardedPort(remotePort: number) {
        if (this.disposed) { throw new Error('The relay client is disposed.'); }
        this.listeners.push(this.listen(remotePort));
        await this.listeners.at(-1);
    }

    async dispose() {
        this.disposed = true;
        for (const server of this.listeners) { void server.then(s => s.close(), () => { }); }
        for (const socket of this.sockets) { socket.destroy(); }
    }

    // Prefers the remote port number locally, as the SDK does, so a rebuilt relay keeps the ssh config's port.
    private async listen(remotePort: number) {
        const server = net.createServer(socket => this.bridge(socket, remotePort));
        const bind = (port: number) => new Promise<void>((resolve, reject) => server.once('error', reject).listen(port, '127.0.0.1', resolve));
        await bind(remotePort).catch(() => bind(0));
        const address = server.address();
        if (!address || typeof address === 'string') { throw new Error(`The forward for port ${remotePort} is not listening on TCP.`); }
        this.forwardedPorts.push({ remotePort, localPort: address.port });
        return server;
    }

    private bridge(local: net.Socket, remotePort: number) {
        const remote = new this.WebSocket(this.forwardUrl(remotePort));
        this.sockets.add(local);
        remote.binaryType = 'arraybuffer';
        // No backpressure: SSH channel windows bound the ssh stream, and Linkspan's API responses are small.
        remote.onopen = () => { local.on('data', chunk => remote.send(chunk)); };
        remote.onmessage = ({ data }) => local.write(Buffer.from(data));
        remote.onclose = () => local.destroy();
        local.on('close', () => { this.sockets.delete(local); remote.close(); }).on('error', () => { });
    }
}

export const linkspanUrl = (processId: string, controlPort: number) => `${PLANE_URL}/processes/${processId}/proxy/${controlPort}/api/v1`;

export class LinkRelayClient extends ForwardRelayClient {
    constructor(private readonly controlPort: number, WebSocket?: typeof globalThis.WebSocket) { super(WebSocket); }

    async connect(tunnel: TunnelRef) {
        const token = tunnel.accessTokens?.connect;
        if (!token) { throw new Error('CyberShuttle returned no connect token for the session.'); }
        const forward = `${linkspanUrl(tunnel.tunnelId, this.controlPort).replace(/^http/, 'ws')}/forward/`;
        this.forwardUrl = port => `${forward}${port}?token=${token}`; // a WebSocket cannot carry a header
    }
}

// The local port a relay client bound for a remote port; the SDK prefers the remote port number itself.
export async function forwardedLocalPort(client: Pick<TunnelRelayClient, 'waitForForwardedPort' | 'forwardedPorts'>, port: number) {
    await client.waitForForwardedPort(port);
    return client.forwardedPorts?.find(p => p.remotePort === port)?.localPort ?? port;
}
