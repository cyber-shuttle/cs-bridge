// The link transport's tunnel clients, shaped like the Dev Tunnels SDK's so transport's session-level functions
// drive either pair. The tunnel is a cs-plane session and its connect token the Jupyter token from `/access`. A
// ForwardRelayClient has no upstream connection of its own: each forwarded port is a 127.0.0.1 listener whose every
// accepted socket rides a fresh WebSocket to a forward URL: cs-plane's for link, Linkspan's over a Dev Tunnel.
import * as net from 'node:net';
import { SlurmSession } from '../models';
import { Plane, PlaneError, PLANE_URL } from '../plane';
import type { TunnelRef, TunnelRelayClient } from './transport';

export class LinkManagementClient {
    constructor(private readonly plane: Plane) { }

    // cs-plane answers /access only for a READY session, so this also gates on Linkspan holding its link.
    async getTunnel({ tunnelId }: TunnelRef): Promise<TunnelRef> {
        return { tunnelId, accessTokens: { connect: (await this.plane.sessionAccess(tunnelId)).jupyter.token } };
    }

    // cs-plane cannot change a walltime, so each run gets a new session. A reused key would restart its run count.
    // A 404 is a session deleted elsewhere.
    async defineTunnel(session: SlurmSession, wallMinutes: number) {
        if (session.planeId) {
            await this.deleteTunnel({ tunnelId: session.planeId }).catch((err) => {
                if (!(err instanceof PlaneError && err.status === 404)) { throw err; }
            });
        }
        return (await this.plane.createSession({ ...session, resources: { ...session.resources, wallMinutes } }, `${session.id}:${Date.now()}`)).id;
    }

    // cs-plane deletes only a stopped session.
    async deleteTunnel({ tunnelId }: TunnelRef) {
        await this.plane.stopSession(tunnelId);
        await this.plane.deleteSession(tunnelId);
    }
}

export class ForwardRelayClient {
    readonly forwardedPorts: { remotePort: number; localPort: number }[] = [];
    private readonly listeners: Promise<net.Server>[] = [];
    private readonly sockets = new Set<net.Socket>();
    private disposed = false;
    protected forwardUrl = '';
    protected protocols: string[] = [];

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
        const remote = new this.WebSocket(`${this.forwardUrl}${remotePort}`, this.protocols);
        this.sockets.add(local);
        remote.binaryType = 'arraybuffer';
        // No backpressure: SSH channel windows bound the ssh stream, and Linkspan's API responses are small.
        remote.onopen = () => { local.on('data', chunk => remote.send(chunk)); };
        remote.onmessage = ({ data }) => local.write(Buffer.from(data));
        remote.onclose = () => local.destroy();
        local.on('close', () => { this.sockets.delete(local); remote.close(); }).on('error', () => { });
    }
}

export class LinkRelayClient extends ForwardRelayClient {
    async connect(tunnel: TunnelRef) {
        const token = tunnel.accessTokens?.connect;
        if (!token) { throw new Error('cs-plane returned no connect token for the session.'); }
        this.forwardUrl = `${PLANE_URL.replace(/^http/, 'ws')}/sessions/${tunnel.tunnelId}/forward/`;
        this.protocols = ['cybershuttle.v1', `capability.${token}`];
    }
}

// The local port a relay client bound for a remote port; the SDK prefers the remote port number itself.
export async function forwardedLocalPort(client: Pick<TunnelRelayClient, 'waitForForwardedPort' | 'forwardedPorts'>, port: number) {
    await client.waitForForwardedPort(port);
    return client.forwardedPorts?.find(p => p.remotePort === port)?.localPort ?? port;
}
