// The link transport's tunnel clients, shaped like the Dev Tunnels SDK's so tunnelSupport's session-level functions
// drive either pair. The tunnel is a cs-plane session and its connect token is cs-plane's `/access` capability. A
// ForwardRelayClient has no upstream connection of its own: each forwarded port is a 127.0.0.1 listener whose every
// accepted socket rides a fresh WebSocket to a forward URL: cs-plane's for link, Linkspan's over a Dev Tunnel.
import * as net from 'node:net';
import { SlurmSession } from '../models';
import { Plane, PlaneError, PLANE_URL } from '../plane';
import { Tunnel } from '@microsoft/dev-tunnels-contracts';

export class LinkManagementClient {
    constructor(private readonly plane: Plane) { }

    // cs-plane answers /access only for a READY session, so this also gates on Linkspan holding its link.
    async getTunnel({ tunnelId }: Tunnel) {
        return { tunnelId, accessTokens: { connect: (await this.plane.sessionAccess(tunnelId!)).jupyter.token } };
    }

    // Attach refuses a live session and a lost release would leave one; a 404 on stop is a session deleted elsewhere.
    async attachTunnel(session: SlurmSession) {
        const define = async () => (await this.plane.createSession(session)).id;
        let tunnelId = session.planeId ?? await define();
        await this.plane.stopSession(tunnelId).catch(async (err) => {
            if (!(err instanceof PlaneError && err.status === 404)) { throw err; }
            tunnelId = await define();
        });
        return { tunnelId, ...await this.plane.attachLink(tunnelId) };
    }

    // cs-plane deletes only a stopped session.
    async deleteTunnel({ tunnelId }: Tunnel) {
        await this.plane.stopSession(tunnelId!);
        await this.plane.deleteSession(tunnelId!);
    }
}

export class ForwardRelayClient {
    connectionStatus = 'none';
    readonly forwardedPorts: { remotePort: number; localPort: number }[] = [];
    private readonly listeners: Promise<net.Server>[] = [];
    private readonly sockets = new Set<net.Socket>();
    private disposed = false;
    protected forwardUrl = '';
    protected protocols: string[] = [];

    constructor(protected readonly WebSocket: typeof globalThis.WebSocket | undefined = globalThis.WebSocket) { }

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
        this.forwardedPorts.push({ remotePort, localPort: (server.address() as net.AddressInfo).port });
        return server;
    }

    private bridge(local: net.Socket, remotePort: number) {
        const remote = new this.WebSocket!(`${this.forwardUrl}${remotePort}`, this.protocols);
        let opened = false;
        this.sockets.add(local);
        remote.binaryType = 'arraybuffer';
        // No backpressure: SSH channel windows bound the ssh stream, and Linkspan's API responses are small.
        remote.onopen = () => { opened = true; this.connectionStatus = 'connected'; local.on('data', chunk => remote.send(chunk)); };
        remote.onmessage = ({ data }) => local.write(Buffer.from(data));
        // A socket that never opened was refused (a revoked token or a session no longer READY).
        remote.onclose = () => { if (!opened) { this.connectionStatus = 'disconnected'; } local.destroy(); };
        local.on('close', () => { this.sockets.delete(local); remote.close(); }).on('error', () => { });
    }
}

export class LinkRelayClient extends ForwardRelayClient {
    async connect(tunnel: Tunnel) {
        if (!this.WebSocket) { throw new Error('The link transport needs VS Code 1.101 or newer.'); }
        this.forwardUrl = `${PLANE_URL.replace(/^http/, 'ws')}/sessions/${tunnel.tunnelId}/forward/`;
        this.protocols = ['cybershuttle.v1', `capability.${tunnel.accessTokens?.connect ?? ''}`];
        this.connectionStatus = 'connected';
    }
}
