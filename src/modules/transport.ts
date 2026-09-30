// How a session's run reaches its Linkspan: an in-process Dev Tunnel (the default) or cs-plane's link WebSocket.
// A Transport is its tunnel clients plus the launch and the run's release. transportFor reads the record's `transport`,
// and nothing outside this module branches on it. Delete removes both transports' tunnels, since a record keeps whatever
// either one's earlier runs left behind.
import { SlurmSession } from '../models';
import { Logger, errMsg } from '../logger';
import { Plane } from '../plane';
import { updateSession } from '../extensionStore';
import type { TunnelRequestOptions } from '@microsoft/dev-tunnels-management';
import { ConnectionStatus, type TunnelConnectionOptions, type TunnelRelayTunnelClient } from '@microsoft/dev-tunnels-connections';
import { Tunnel, TunnelAccessScopes } from '@microsoft/dev-tunnels-contracts';
import { LinkspanLaunch, devTunnelLaunch, linkLaunch } from './slurmParse';
import { deleteDevTunnel, devTunnels, ensureDevTunnel, getMicrosoftAccountLabel } from './tunnelSupport';
import { LinkManagementClient, LinkRelayClient, forwardedLocalPort } from './linkTunnel';
import { sessionPublicKey, deleteSshConfigEntry } from './sshSupport';
import { csHostAlias } from './sshHostsStore';
import { ensureSshServer } from './linkspanSupport';

const logger = Logger.getInstance();
// Consecutive 15s keep-alive misses (~1 min of dead Dev Tunnel) before we rebuild a half-open Dev Tunnel the SDK won't self-heal.
const RECONNECT_AFTER_MISSES = 4;

// A transport's management and relay clients, as this module's session-level steps use them: the Dev Tunnels SDK's
// (devTunnels) or linkTunnel's mirror of them over cs-plane.
interface TunnelManagement {
    getTunnel(tunnel: Tunnel, options?: TunnelRequestOptions): Promise<Tunnel | null>;
}

export interface TunnelRelayClient {
    readonly connectionStatus: string;
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
    relayClient(management: TunnelManagement, session: SlurmSession): TunnelRelayClient;
    tunnelRef(session: SlurmSession): Tunnel | undefined; // the run's tunnel, once prepared
    ensureTunnel(session: SlurmSession): Promise<unknown>;
    withLinkspan<T>(session: SlurmSession, call: (baseUrl: string, headers: Record<string, string>) => Promise<T>): Promise<T>;
    deleteTunnel(session: SlurmSession): Promise<void>;
}

export interface Transport extends Tunnels {
    readonly description: string;
    signedIn(): Promise<boolean>; // without prompting
    prepare(session: SlurmSession): Promise<LinkspanLaunch>; // before sbatch: reserve the run's tunnel
    release(session: SlurmSession): Promise<void>; // end the run's remote hold and its tokens
}

const devTunnel = {
    ...devTunnels,
    description: 'Stable, relayed by Microsoft\'s network',
    signedIn: async () => await getMicrosoftAccountLabel() !== null,
    async prepare(session) {
        // Fresh launch: drop the prior run's Dev Tunnel so its ports don't accumulate toward Microsoft's PortsPerTunnel (10) cap.
        await deleteDevTunnel(session);
        try { return devTunnelLaunch(session, await ensureDevTunnel(session)); }
        catch (err) { throw new Error(`Failed to create Dev Tunnel: ${errMsg(err)}`); }
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

    withLinkspan: Tunnels['withLinkspan'] = async (session, call) => {
        const client = this.relayClient();
        try {
            await client.connect(await this.management().getTunnel({ tunnelId: session.planeId }));
            await client.waitForForwardedPort(session.connectionInfo?.controlPort ?? 0);
            return await call(`http://127.0.0.1:${client.forwardedPorts[0].localPort}/api/v1`, {});
        }
        finally { await client.dispose(); }
    };

    signedIn = () => this.plane.signedIn();

    async prepare(session: SlurmSession) {
        try {
            const { tunnelId, port, link } = await this.management().attachTunnel(session);
            session.planeId = tunnelId;
            session.connectionInfo!.controlPort = port;
            return linkLaunch(link.url, link.token);
        }
        catch (err) { throw new Error(`Failed to attach the cs-plane session: ${errMsg(err)}`); }
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
// Linkspan restart changed.
export async function ensureRemoteSession(t: Tunnels, session: SlurmSession): Promise<void> {
    await t.ensureTunnel(session); // refreshes the tunnel and its connect token
    const ci = session.connectionInfo ??= { sshPort: 0, controlPort: 0 };

    // Best-effort: if Linkspan stalls (a flaky tunnel) once its sshd is known, proceed with that port.
    try { ci.sshPort = (await t.withLinkspan(session, (baseUrl, headers) => ensureSshServer(baseUrl, headers, sessionPublicKey(session.id)))).bind_port; }
    catch (err) {
        if (ci.sshPort) { return; }
        throw err;
    }

    updateSession(session);
    logger.info(`SSH server for session ${session.id} is on port ${ci.sshPort}, reached through ${t.label} ${t.tunnelRef(session)?.tunnelId}.`);
}

export function hasTunnelClient(sessionId: string): boolean {
    return activeTunnelClients.has(sessionId);
}

// True while this window's tunnel client holds a live connection — its keepAlive already watches the connection, so this is
// the authoritative liveness signal for a connected session.
export function isTunnelClientConnected(sessionId: string): boolean {
    return activeTunnelClients.get(sessionId)?.connectionStatus === ConnectionStatus.Connected;
}

export async function connectSessionToTunnel(t: Tunnels, session: SlurmSession, onDevTunnelLost: () => void): Promise<number> {
    logger.info(`Connecting session ${session.id} to its ${t.label}...`);

    if (!session.connectionInfo) {
        throw new Error(`Session ${session.id} does not have connection info.`);
    }

    const { sshPort } = session.connectionInfo;
    const ref = t.tunnelRef(session);
    const mgmtClient = t.management();

    const tunnel = ref && await mgmtClient.getTunnel(
        ref,
        {
            includePorts: true,
            tokenScopes: [TunnelAccessScopes.Connect],
        },
    );

    if (!tunnel) {
        throw new Error(`${t.label} ${ref?.tunnelId ?? ''} not found.`);
    }

    logger.info(`Fetched ${t.label} ${tunnel.tunnelId}: ${tunnel.endpoints?.length ?? 0} endpoints, ${tunnel.ports?.length ?? 0} ports`);

    // Register before connecting so a re-entrant connect can't orphan the prior client and a failed connect stays disposable.
    await disposeTunnelClient(session.id);
    const client = t.relayClient(mgmtClient, session);
    // Surface Dev Tunnel connection health: a stalled/reconnecting Dev Tunnel is otherwise invisible, and this tells contention from raw Dev Tunnel bandwidth.
    client.connectionStatusChanged?.(e => logger.info(`Session ${session.id}: Dev Tunnel ${e.previousStatus} → ${e.status}${e.disconnectError ? ` (${e.disconnectError.message})` : ''}`));
    client.keepAliveFailed?.((e) => {
        logger.warn(`Session ${session.id}: Dev Tunnel keep-alive missed ${e.count} consecutive probe(s)`);
        // A half-open Dev Tunnel stays "Connected", so the SDK's enableReconnect never fires; rebuild once misses cross the
        // bar. Fires once — the rebuild disposes this client, ending its events.
        if (e.count === RECONNECT_AFTER_MISSES) { onDevTunnelLost(); }
    });
    activeTunnelClients.set(session.id, client);

    let localPort: number;
    try {
        await client.connect(tunnel, {
            enableRetry: true,
            enableReconnect: true,
            keepAliveIntervalInSeconds: 15, // probe the upstream WebSocket so a half-open Dev Tunnel is detected and reconnected fast (default 0 = off)
        });
        localPort = await forwardedLocalPort(client, sshPort);
    }
    catch (err) {
        await disposeTunnelClient(session.id);
        throw err;
    }

    session.connectionInfo!.localPort = localPort;
    logger.info(`${t.label} connected for session ${session.id}. SSH available at 127.0.0.1:${localPort}`);
    return localPort;
}

// Frees the local port only. Never deletes the remote sshd or tunnel (job-scoped, reaped by Linkspan) — that would break reattach.
export async function disposeTunnelClient(sessionId: string): Promise<void> {
    const client = activeTunnelClients.get(sessionId);
    if (!client) { return; }
    try {
        await client.dispose();
        logger.info(`Tunnel client disposed for session ${sessionId}`);
    }
    catch (err) {
        logger.error(`Error disposing tunnel client for session ${sessionId}:`, err);
    }
    activeTunnelClients.delete(sessionId);
}

export async function disposeAllTunnelClients(): Promise<void> {
    await Promise.all([...activeTunnelClients.keys()].map(id => disposeTunnelClient(id)));
}

export async function disconnectSessionFromTunnel(t: Tunnels, session: SlurmSession): Promise<void> {
    await disposeTunnelClient(session.id);
    await deleteSshConfigEntry(session.id, csHostAlias(session));
    session.connectionInfo = undefined;
    updateSession(session);
    logger.info(`Session ${session.id} disconnected from its ${t.label}.`);
}
