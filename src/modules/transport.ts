// How a session's run reaches its Linkspan: an in-process Dev Tunnel (the default) or cs-plane's link WebSocket.
// A Transport is its tunnel clients plus the launch and the run's release. transportFor reads the record's `transport`,
// and nothing outside this module branches on it. Delete removes both transports' tunnels, since a record keeps whatever
// either one's earlier runs left behind.
import { ConnectionInfo, SlurmSession } from '../models';
import { Logger, errMsg } from '../logger';
import { Plane } from '../plane';
import { live, patch } from '../extensionStore';
import type { TunnelRequestOptions } from '@microsoft/dev-tunnels-management';
import { ConnectionStatus, type TunnelConnectionOptions, type TunnelRelayTunnelClient } from '@microsoft/dev-tunnels-connections';
import { Tunnel, TunnelAccessScopes } from '@microsoft/dev-tunnels-contracts';
import { LinkspanLaunch, devTunnelLaunch, linkLaunch } from './slurmParse';
import { deleteDevTunnel, devTunnels, ensureDevTunnel, getMicrosoftAccountLabel } from './tunnelSupport';
import { LinkManagementClient, LinkRelayClient, forwardedLocalPort } from './linkTunnel';
import { sessionPublicKey } from './sshSupport';
import { ensureSshServer } from './linkspanSupport';

const logger = Logger.getInstance();
// Consecutive 15s keep-alive misses (~1 min of dead Dev Tunnel) before we rebuild a half-open Dev Tunnel the SDK won't self-heal.
const RECONNECT_AFTER_MISSES = 4;

// A transport's management and relay clients, as this module's session-level steps use them: the Dev Tunnels SDK's
// (devTunnels) or linkTunnel's mirror of them over cs-plane.
export type TunnelRef = Tunnel & { tunnelId: string };
interface TunnelManagement {
    getTunnel(tunnel: TunnelRef, options?: TunnelRequestOptions): Promise<Tunnel | null>;
}

export interface TunnelRelayClient {
    readonly forwardedPorts?: { find(predicate: (port: { remotePort: number | null }) => boolean): { localPort: number | null } | undefined };
    readonly connectionStatusChanged?: TunnelRelayTunnelClient['connectionStatusChanged'];
    readonly keepAliveFailed?: TunnelRelayTunnelClient['keepAliveFailed'];
    connect(tunnel: Tunnel, options?: TunnelConnectionOptions): Promise<void>;
    waitForForwardedPort(remotePort: number): Promise<void>;
    dispose(): Promise<void>;
}

export interface Tunnels {
    readonly label: string;
    management(): TunnelManagement;
    relayClient(management: TunnelManagement, ci: ConnectionInfo): TunnelRelayClient;
    tunnelRef(session: SlurmSession): TunnelRef | undefined; // the run's tunnel, once prepared
    ensureTunnel(session: SlurmSession, ci: ConnectionInfo): Promise<void>;
    withLinkspan<T>(session: SlurmSession, ci: ConnectionInfo, call: (baseUrl: string, headers: Record<string, string>) => Promise<T>): Promise<T>;
    deleteTunnel(session: SlurmSession): Promise<void>;
}

export interface Transport extends Tunnels {
    readonly description: string;
    signedIn(): Promise<boolean>; // without prompting
    prepare(session: SlurmSession, ci: ConnectionInfo): Promise<LinkspanLaunch>; // before sbatch: reserve the run's tunnel on its control port
    release(session: SlurmSession): Promise<void>; // end the run's remote hold and its tokens
}

const devTunnel = {
    ...devTunnels,
    description: 'Stable, relayed by Microsoft\'s network',
    signedIn: async () => await getMicrosoftAccountLabel() !== null,
    async prepare(session, ci) {
        // Fresh launch: drop the prior run's Dev Tunnel so its ports don't accumulate toward Microsoft's PortsPerTunnel (10) cap.
        await deleteDevTunnel(session);
        try {
            const { devtunnel, hostToken } = await ensureDevTunnel(session, ci);
            return devTunnelLaunch(devtunnel, hostToken);
        }
        catch (err) { throw new Error(`Failed to create Dev Tunnel: ${errMsg(err)}`, { cause: err }); }
    },
    release: async () => { },
} satisfies Transport;

class Link implements Transport {
    label = 'Cybershuttle Link';
    description = 'Experimental, relayed by Cybershuttle';

    constructor(private readonly plane: Plane) { }

    management = () => new LinkManagementClient(this.plane);
    relayClient = () => new LinkRelayClient();

    tunnelRef = ({ planeId }: SlurmSession) => planeId ? { tunnelId: planeId } : undefined;
    // cs-plane forwards any port a Linkspan task serves, so there is nothing to declare.
    async ensureTunnel() { }

    withLinkspan: Tunnels['withLinkspan'] = async (session, ci, call) => {
        const client = this.relayClient();
        try {
            const ref = this.tunnelRef(session);
            if (!ref) { throw new Error(`Session ${session.id} has no cs-plane session to reach Linkspan through.`); }
            await client.connect(await this.management().getTunnel(ref));
            return await call(`http://127.0.0.1:${await forwardedLocalPort(client, ci.controlPort)}/api/v1`, {});
        }
        finally { await client.dispose(); }
    };

    signedIn = () => this.plane.signedIn();

    async prepare(session: SlurmSession, ci: ConnectionInfo) {
        try {
            const { tunnelId, port, link } = await this.management().attachTunnel(session);
            patch(session, { planeId: tunnelId });
            ci.controlPort = port;
            return linkLaunch(link.url, link.token);
        }
        catch (err) { throw new Error(`Failed to attach the cs-plane session: ${errMsg(err)}`, { cause: err }); }
    }

    // Idempotent: a terminal cs-plane session answers unchanged.
    async release({ name, planeId }: SlurmSession) {
        if (!planeId) { return; }
        await this.plane.stopSession(planeId).catch(err => logger.warn(`Session ${name}: releasing the cs-plane session failed: ${err}`));
    }

    async deleteTunnel({ planeId }: SlurmSession) {
        if (!planeId) { return; }
        await this.management().deleteTunnel({ tunnelId: planeId }).catch(err => logger.error(`Failed to delete cs-plane session ${planeId}:`, err));
    }
}

export class Transports {
    private readonly link;

    constructor(plane: Plane) { this.link = new Link(plane); }

    readonly transportFor = (session: Pick<SlurmSession, 'transport'>) => session.transport === 'link' ? this.link : devTunnel;

    async remove(session: SlurmSession) {
        for (const t of [devTunnel, this.link]) { await t.deleteTunnel(session); }
    }
}

const activeTunnelClients = new Map<string, TunnelRelayClient>();

// Step 1: the session's sshd. Linkspan answers a repeat with the running one, so asking each time self-heals a port a
// Linkspan restart changed. Returns the connection info to record; the caller writes it, once it knows the run still wants it.
export async function ensureRemoteSession(t: Tunnels, session: SlurmSession): Promise<ConnectionInfo> {
    if (!session.connectionInfo) { throw new Error(`Session ${session.id} has no run to reach.`); }
    const ci = { ...session.connectionInfo };
    await t.ensureTunnel(session, ci); // refreshes the tunnel and its connect token

    // Best-effort: if Linkspan stalls (a flaky tunnel) once its sshd is known, proceed with that port.
    try { ci.sshPort = (await t.withLinkspan(session, ci, (baseUrl, headers) => ensureSshServer(baseUrl, headers, sessionPublicKey(session.id)))).bind_port; }
    catch (err) {
        if (ci.sshPort) { return ci; }
        throw err;
    }
    logger.info(`SSH server for session ${session.id} is on port ${ci.sshPort}, reached through ${t.label} ${t.tunnelRef(session)?.tunnelId}.`);
    return ci;
}

// True while this window's tunnel client holds a live connection — its keepAlive already watches the connection, so this is
// the authoritative liveness signal for a connected session.
export const isTunnelClientConnected = (sessionId: string): boolean => live.connected.has(sessionId);

export async function connectSessionToTunnel(t: Tunnels, session: SlurmSession, ci: ConnectionInfo, onDevTunnelLost: () => void): Promise<void> {
    logger.info(`Connecting session ${session.id} to its ${t.label}...`);

    const ref = t.tunnelRef(session);
    if (!ref) { throw new Error(`Session ${session.id} has no ${t.label} prepared.`); }
    const mgmtClient = t.management();
    const tunnel = await mgmtClient.getTunnel(ref, { includePorts: true, tokenScopes: [TunnelAccessScopes.Connect] });
    if (!tunnel) { throw new Error(`${t.label} ${ref.tunnelId} not found.`); }

    logger.info(`Fetched ${t.label} ${tunnel.tunnelId} with ports ${tunnel.ports?.map(p => p.portNumber).join(', ')}`);

    // Register before connecting so a re-entrant connect can't orphan the prior client and a failed connect stays disposable.
    await disposeTunnelClient(session.id);
    const client = t.relayClient(mgmtClient, ci);
    // Surface Dev Tunnel connection health: a stalled/reconnecting Dev Tunnel is otherwise invisible, and this tells contention from raw Dev Tunnel bandwidth.
    client.connectionStatusChanged?.((e) => {
        logger.info(`Session ${session.id}: Dev Tunnel ${e.previousStatus} → ${e.status}${e.disconnectError ? ` (${e.disconnectError.message})` : ''}`);
        if (e.status === ConnectionStatus.Connected) { live.connected.add(session.id); }
        else { live.connected.delete(session.id); }
    });
    client.keepAliveFailed?.((e) => {
        logger.warn(`Session ${session.id}: Dev Tunnel keep-alive missed ${e.count} consecutive probe(s)`);
        // A half-open Dev Tunnel stays "Connected", so the SDK's enableReconnect never fires; rebuild once misses cross the
        // bar. Fires once — the rebuild disposes this client, ending its events.
        if (e.count === RECONNECT_AFTER_MISSES) { onDevTunnelLost(); }
    });
    activeTunnelClients.set(session.id, client);

    await client.connect(tunnel, {
        enableRetry: true,
        enableReconnect: true,
        keepAliveIntervalInSeconds: 15, // probe the upstream WebSocket so a half-open Dev Tunnel is detected and reconnected fast (default 0 = off)
    });
    const localPort = await forwardedLocalPort(client, ci.sshPort);
    patch(session, { connectionInfo: { ...ci, localPort } });
    live.connected.add(session.id);
    logger.info(`${t.label} connected for session ${session.id}. SSH available at 127.0.0.1:${localPort}`);
}

// Frees the local port only. The remote sshd dies with the job; the tunnel outlives it and the next launch replaces it.
export async function disposeTunnelClient(sessionId: string): Promise<void> {
    live.connected.delete(sessionId);
    const client = activeTunnelClients.get(sessionId);
    if (!client) { return; }
    try {
        await client.dispose();
        logger.info(`Tunnel client disposed for session ${sessionId}`);
    }
    catch (err) {
        logger.error(`Error disposing tunnel client for session ${sessionId}:`, err);
    }
    if (activeTunnelClients.get(sessionId) === client) { activeTunnelClients.delete(sessionId); } // a connect may have registered a new one meanwhile
}

export async function disposeAllTunnelClients(): Promise<void> {
    await Promise.all([...activeTunnelClients.keys()].map(id => disposeTunnelClient(id)));
}

export async function disconnectSessionFromTunnel(t: Tunnels, session: SlurmSession): Promise<void> {
    await disposeTunnelClient(session.id);
    patch(session, { connectionInfo: undefined });
    logger.info(`Session ${session.id} disconnected from its ${t.label}.`);
}
