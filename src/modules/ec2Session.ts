// An EC2 instance as a session's backend: the monitor's poll and teardown, and the provider's start, stop, connect
// and remove, so an instance rides the Slurm session lifecycle. 'preparing' holds until the instance's port 22
// accepts a connection; connect only writes the per-session SSH host, since the instance is reached over plain SSH.
import * as net from 'net';
import { uuidv7 } from 'uuidv7';
import { Ec2Spec, SlurmSession } from '../models';
import { Logger } from '../logger';
import { addSession, getAllSessions, setStatus, updateSession } from '../extensionStore';
import { AwsClient } from './aws';
import { keyName } from './ec2';
import { computeEc2Transition, isTerminal, StatusTransition } from './sessionMachine';
import { Backend, SessionMonitor } from './sessionSupport';
import { deleteSshConfigEntry, sshKeyPath, writeSshConfigEntry } from './sshSupport';
import { csHostAlias } from './sshHostsStore';

const logger = Logger.getInstance();
const SSH_PORT = 22;

const portOpen = (host: string, port: number): Promise<boolean> => new Promise((resolve) => {
    const socket = net.connect({ host, port, timeout: 3_000 });
    const done = (open: boolean) => { socket.destroy(); resolve(open); };
    socket.once('connect', () => done(true)).once('timeout', () => done(false)).once('error', () => done(false));
});

export class Ec2Backend implements Backend {
    // The monitor is built with this backend, so it arrives lazily.
    constructor(private readonly aws: AwsClient, private readonly monitor: () => SessionMonitor) { }

    newSession(ec2: Ec2Spec): SlurmSession {
        const now = Date.now();
        return {
            id: uuidv7(), name: `${now}`, status: 'not_started', alias: `aws-${ec2.region}`, account: '', partition: '', rootFolder: `/home/${ec2.user}`,
            resources: { cores: 0, memoryMb: 0, wallMinutes: 0 }, jobId: '', submittedAt: now, errorMessage: '', transport: 'devtunnel', ec2,
        };
    }

    // Every tagged instance without a record becomes one, so a VM launched from another machine is never lost.
    async adopt(): Promise<void> {
        const ec2 = this.aws.requireEc2();
        // A launch in flight elsewhere has tagged its instance with the record's alias before it records the id.
        const known = new Set(getAllSessions().flatMap(s => [s.jobId, csHostAlias(s)]));
        for (const region of this.aws.regions ?? []) {
            const found = await ec2.list(region).catch((err) => { logger.error(`EC2 list of ${region} failed:`, err); return []; });
            for (const [n, i] of found.filter(i => !known.has(i.id) && !known.has(i.name) && i.state !== 'shutting-down').entries()) {
                const session = this.newSession({ region, type: i.type, image: '', user: i.user, ip: i.ip });
                // One millisecond can adopt several records, and the name's last six characters alias the SSH host.
                Object.assign(session, { name: `${session.name}${n}`, jobId: i.id, status: computeEc2Transition('not_started', i.state).next ?? 'failed' });
                addSession(session);
                if (!isTerminal(session.status)) { this.monitor().startMonitoring(session); }
                logger.info(`Adopted EC2 instance ${i.id} in ${region} as session ${session.name}`);
            }
        }
    }

    async start(session: SlurmSession): Promise<void> {
        const ec2 = this.aws.requireEc2();
        const spec = session.ec2!;
        if (session.jobId) { await ec2.act('start', spec.region, session.jobId); }
        else { session.jobId = await ec2.launch(spec.image, spec.type, spec.region, csHostAlias(session)); }
        spec.ip = '';
        session.connectionInfo = undefined;
        setStatus(session, 'preparing');
        this.monitor().startMonitoring(session);
    }

    // EC2 refuses to stop a pending instance. 'stopping' then holds until the poll sees the instance stopped.
    async stop(session: SlurmSession): Promise<void> {
        const ec2 = this.aws.requireEc2();
        const { region } = session.ec2!;
        while ((await ec2.describe(region, session.jobId)).state === 'pending') { await new Promise(res => setTimeout(res, 5_000)); }
        await ec2.act('stop', region, session.jobId);
        this.monitor().startMonitoring(session);
    }

    async connect(session: SlurmSession): Promise<boolean> {
        setStatus(session, 'connecting');
        await this.writeHost(session);
        setStatus(session, 'connected');
        return true;
    }

    async remove(session: SlurmSession): Promise<void> {
        if (session.jobId) { await this.aws.requireEc2().act('terminate', session.ec2!.region, session.jobId); }
    }

    async tick(session: SlurmSession): Promise<StatusTransition> {
        const ec2 = this.aws.ec2;
        if (!ec2) { return {}; } // signed out, or activation has not restored the key yet: hold
        const spec = session.ec2!;
        const { state, ip } = await ec2.describe(spec.region, session.jobId);
        if (ip !== spec.ip) {
            spec.ip = ip; // a stopped instance comes back with a new public IP
            updateSession(session);
            if (session.status === 'connected') { await this.writeHost(session); }
        }
        if (session.status === 'preparing' && state === 'running' && ip && await portOpen(ip, SSH_PORT)) {
            session.connectionInfo = { sshPort: SSH_PORT, controlPort: 0 };
            return { next: 'ready_to_connect', error: '' };
        }
        return computeEc2Transition(session.status, state);
    }

    async end(session: SlurmSession): Promise<void> {
        session.connectionInfo = undefined;
        updateSession(session);
        await deleteSshConfigEntry(session.id, csHostAlias(session), false); // the key is the region's
    }

    private writeHost(session: SlurmSession): Promise<string> {
        const { region, ip, user } = session.ec2!;
        return writeSshConfigEntry(session.id, csHostAlias(session), ip, SSH_PORT, user, sshKeyPath(keyName(region)));
    }
}
