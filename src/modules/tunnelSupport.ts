import { SlurmSession } from '../models';
import * as vscode from 'vscode';
import { Logger } from '../logger';
import { updateSession } from '../extensionStore';
import { TunnelManagementHttpClient, ManagementApiVersions } from '@microsoft/dev-tunnels-management';
import { TunnelRelayTunnelClient, TunnelConnectionOptions } from '@microsoft/dev-tunnels-connections';
import { Tunnel, TunnelAccessScopes } from '@microsoft/dev-tunnels-contracts';
import { ForwardRelayClient, forwardedLocalPort } from './linkTunnel';
import type { Tunnels } from './transport';

const DEV_TUNNELS_APP_ID = '46da2f7e-b5ef-422a-88d4-2a7f9de6a0b2';
const DEV_TUNNELS_SCOPE = `${DEV_TUNNELS_APP_ID}/.default`;

const logger = Logger.getInstance();

function buildTunnelManagementClient(): TunnelManagementHttpClient {
    return new TunnelManagementHttpClient(
        { name: 'csbridge-vscode', version: '1.0' },
        ManagementApiVersions.Version20230927preview,
        async () => `Bearer ${await getDevTunnelAuthToken()}`,
    );
}

const devTunnelRef = ({ devtunnel }: SlurmSession): Tunnel | undefined => devtunnel && { tunnelId: devtunnel.id, clusterId: devtunnel.cluster };

// Makes the Dev Tunnel carry the control port, the only port it needs, and returns the host token: we keep the Entra
// bearer local and register the port ourselves, so the node only ever holds a token scoped to hosting this Dev Tunnel.
export async function ensureDevTunnel(session: SlurmSession): Promise<string> {
    const mgmt = buildTunnelManagementClient();
    const ci = session.connectionInfo ??= { sshPort: 0, controlPort: 0 };
    const opts = { includePorts: true, tokenScopes: [TunnelAccessScopes.Host, TunnelAccessScopes.Connect] };
    const ref = devTunnelRef(session);
    const tunnel = (ref && await mgmt.getTunnel(ref, opts)) ?? await mgmt.createTunnel(ref ?? {}, opts);

    session.devtunnel = { id: tunnel.tunnelId!, cluster: tunnel.clusterId! };
    ci.connectToken = tunnel.accessTokens?.[TunnelAccessScopes.Connect] ?? ci.connectToken;
    updateSession(session);

    // Nothing reaches the job on a port the Dev Tunnel does not carry, and a failure here is the session's failure.
    if (ci.controlPort && !tunnel.ports?.some(p => p.portNumber === ci.controlPort)) {
        await mgmt.createTunnelPort(tunnel, { portNumber: ci.controlPort, protocol: 'auto' }, { tokenScopes: [TunnelAccessScopes.Host] });
    }
    const hostToken = tunnel.accessTokens?.[TunnelAccessScopes.Host];
    if (!hostToken) { throw new Error('Dev Tunnel did not return a host token.'); }
    return hostToken;
}

// The SDK forwards only Linkspan's control port; the sshd rides its /api/v1/forward, bridged as for link.
class DevTunnelRelayClient extends ForwardRelayClient {
    get connectionStatusChanged() { return this.sdk.connectionStatusChanged; }
    get keepAliveFailed() { return this.sdk.keepAliveFailed; }

    constructor(private readonly sdk: TunnelRelayTunnelClient, private readonly controlPort: number) {
        super();
        sdk.connectionStatusChanged((e) => { this.connectionStatus = e.status; });
    }

    async connect(tunnel: Tunnel, options?: TunnelConnectionOptions) {
        await this.sdk.connect(tunnel, options);
        this.forwardUrl = `ws://127.0.0.1:${await forwardedLocalPort(this.sdk, this.controlPort)}/api/v1/forward/`;
    }

    async dispose() {
        await super.dispose();
        await this.sdk.dispose();
    }
}

export const devTunnels = {
    label: 'Microsoft DevTunnel',
    management: buildTunnelManagementClient,
    relayClient: (management: TunnelManagementHttpClient, session: SlurmSession) => new DevTunnelRelayClient(new TunnelRelayTunnelClient(management), session.connectionInfo?.controlPort ?? 0),
    tunnelRef: devTunnelRef,
    ensureTunnel: ensureDevTunnel,
    withLinkspan: ({ devtunnel, connectionInfo: ci }, call) => call(`https://${devtunnel?.id}-${ci?.controlPort}.${devtunnel?.cluster}.devtunnels.ms/api/v1`,
        { 'X-Tunnel-Authorization': `tunnel ${ci?.connectToken}` }),
    deleteTunnel: deleteDevTunnel,
} satisfies Tunnels;

export async function deleteDevTunnel(session: SlurmSession): Promise<void> {
    const ref = devTunnelRef(session);
    if (!ref) { return; }
    try {
        await buildTunnelManagementClient().deleteTunnel(ref);
    }
    catch (err) {
        logger.warn(`Failed to delete Dev Tunnel ${ref.tunnelId}:`, err);
    }
    session.devtunnel = undefined;
    updateSession(session);
}

function getMicrosoftSession(options: vscode.AuthenticationGetSessionOptions & { createIfNone: true }): Thenable<vscode.AuthenticationSession>;
function getMicrosoftSession(options: vscode.AuthenticationGetSessionOptions): Thenable<vscode.AuthenticationSession | undefined>;
function getMicrosoftSession(options: vscode.AuthenticationGetSessionOptions) {
    return vscode.authentication.getSession('microsoft', [DEV_TUNNELS_SCOPE], options);
}

async function getDevTunnelAuthToken(): Promise<string> {
    try {
        const session = await getMicrosoftSession({ createIfNone: true });
        return session?.accessToken || '';
    }
    catch (err) {
        logger.error('Failed to get Dev Tunnels auth token:', err);
        throw new Error('Dev Tunnels authentication is required. Please sign in to your Microsoft account.', { cause: err });
    }
}

export async function switchDevTunnelAccount(): Promise<void> {
    const session = await getMicrosoftSession({ clearSessionPreference: true, createIfNone: true });
    logger.info(`Dev Tunnels: switched to ${session.account.label}`);
}

export async function getMicrosoftAccountLabel(): Promise<string | null> {
    try {
        return (await getMicrosoftSession({ silent: true }))?.account.label ?? null;
    }
    catch {
        return null;
    }
}
