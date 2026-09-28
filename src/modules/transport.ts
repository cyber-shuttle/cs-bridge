// How a session's run reaches its Linkspan: an in-process Dev Tunnel (the default) or cs-plane's link WebSocket.
// A Transport is its tunnel clients plus the launch and the run's release. transportFor reads the record's `transport`,
// and nothing outside this module branches on it. Delete removes both transports' tunnels, since a record keeps whatever
// either one's earlier runs left behind.
import { SlurmSession } from '../models';
import { Logger, errMsg } from '../logger';
import { Plane } from '../plane';
import { LinkspanLaunch, devTunnelLaunch, linkLaunch } from './slurmParse';
import { Tunnels, deleteDevTunnel, devTunnels, ensureDevTunnel, getMicrosoftAccountLabel } from './tunnelSupport';
import { LinkManagementClient, LinkRelayClient } from './linkTunnel';

export interface Transport extends Tunnels {
    readonly linkspanMinimum?: string;
    signedIn(): Promise<boolean>; // without prompting
    hasTunnel(session: SlurmSession): boolean;
    prepare(session: SlurmSession): Promise<LinkspanLaunch>; // before sbatch: reserve the run's tunnel
    release(session: SlurmSession): Promise<void>; // end the run's remote hold and its tokens
}

const devTunnel = {
    ...devTunnels,
    signedIn: async () => await getMicrosoftAccountLabel() !== null,
    hasTunnel: session => !!session.tunnelId,
    async prepare(session) {
        // Fresh launch: drop the prior run's Dev Tunnel so its ports don't accumulate toward Microsoft's PortsPerTunnel (10) cap.
        await deleteDevTunnel(session);
        try { return devTunnelLaunch(session, await ensureDevTunnel(session)); }
        catch (err) { throw new Error(`Failed to create Dev Tunnel: ${errMsg(err)}`); }
    },
    release: async () => { },
} satisfies Transport;

class Link implements Transport {
    label = 'cs-plane link';
    linkspanMinimum = '0.22.0'; // the first with --tunnel-mode link

    constructor(private readonly plane: Plane) { }

    management = () => new LinkManagementClient(this.plane);
    relayClient = () => new LinkRelayClient();

    // cs-plane forwards any port a Linkspan task serves, so there is nothing to declare.
    async ensureTunnel(session: SlurmSession) {
        (session.connectionInfo ??= { sshPort: 0, sshTunnelId: '', region: '' }).apiTunnelId = session.planeId;
    }

    withLinkspan: Tunnels['withLinkspan'] = async (session, call) => {
        const client = this.relayClient();
        try {
            await client.connect(await this.management().getTunnel({ tunnelId: session.planeId }));
            await client.waitForForwardedPort(session.connectionInfo?.apiPort ?? 0);
            return await call(`http://127.0.0.1:${client.forwardedPorts[0].localPort}/api/v1`, {});
        }
        finally { await client.dispose(); }
    };

    signedIn = () => this.plane.signedIn();
    hasTunnel = (session: SlurmSession) => !!session.planeId;

    async prepare(session: SlurmSession) {
        try {
            const { tunnelId, port, link } = await this.management().attachTunnel(session);
            session.planeId = tunnelId;
            session.connectionInfo!.apiPort = port;
            return linkLaunch(link.url, link.token);
        }
        catch (err) { throw new Error(`Failed to attach the cs-plane session: ${errMsg(err)}`); }
    }

    // Idempotent: a terminal cs-plane session answers unchanged.
    async release({ name, planeId }: SlurmSession) {
        if (!planeId) { return; }
        await this.plane.stopSession(planeId).catch(err => Logger.getInstance().warn(`Session ${name}: releasing the cs-plane session failed: ${err}`));
    }

    async deleteTunnel({ planeId }: SlurmSession) {
        if (!planeId) { return; }
        await this.management().deleteTunnel({ tunnelId: planeId }).catch(err => Logger.getInstance().error(`Failed to delete cs-plane session ${planeId}:`, err));
    }
}

export class Transports {
    private readonly link;

    constructor(plane: Plane) { this.link = new Link(plane); }

    readonly transportFor = (session: SlurmSession) => session.transport === 'link' ? this.link : devTunnel;

    async remove(session: SlurmSession) {
        for (const t of [devTunnel, this.link]) { await t.deleteTunnel(session); }
    }
}
