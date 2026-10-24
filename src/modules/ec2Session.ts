// An EC2 instance as a session's backend: the monitor's poll and teardown, and the provider's start, stop, connect
// and remove, so an instance rides the Slurm session lifecycle. 'preparing' holds until the instance's port 22
// accepts a connection; connect only writes the per-session SSH host, since the instance is reached over plain SSH.
import * as net from 'net';
import { Ec2Spec, SlurmJobStatus, SlurmSession, newSession } from '../models';
import { Logger } from '../logger';
import { addSession, getAllSessions, live, observe, patch, statusOf } from '../extensionStore';
import { AwsClient } from './aws';
import { isTerminal, observedEc2 } from './sessionMachine';
import { Backend, SessionMonitor } from './sessionSupport';
import { csHostAlias } from './sshHostsStore';

const logger = Logger.getInstance();
const SSH_PORT = 22;

const portOpen = (host: string, port: number): Promise<boolean> => new Promise((resolve) => {
    const socket = net.connect({ host, port, timeout: 3_000 });
    const done = (open: boolean) => { socket.destroy(); resolve(open); };
    socket.once('connect', () => done(true)).once('timeout', () => done(false)).once('error', () => done(false));
});

// An EC2 record: the Slurm-only fields are blank, and no walltime means no deadline.
export const ec2Session = (ec2: Ec2Spec, fields: Partial<SlurmSession> = {}): SlurmSession =>
    newSession({ alias: `aws-${ec2.region}`, account: '', partition: '', rootFolder: `/home/${ec2.user}`, resources: { cores: 0, memoryMb: 0, wallMinutes: 0 }, ec2, ...fields });

export class Ec2Backend implements Backend {
    // The monitor is built with this backend, so it arrives lazily.
    constructor(private readonly aws: AwsClient, private readonly monitor: () => SessionMonitor) { }

    // Every tagged instance without a record becomes one, so a VM launched from another machine is never lost.
    async adopt(): Promise<void> {
        const ec2 = this.aws.requireEc2();
        // A launch in flight elsewhere has tagged its instance with the record's alias before it records the id.
        const known = new Set(getAllSessions().flatMap(s => [s.jobId, csHostAlias(s)]));
        for (const region of this.aws.regions ?? []) {
            const found = await ec2.list(region).catch((err) => { logger.error(`EC2 list of ${region} failed:`, err); return []; });
            for (const i of found.filter(i => !known.has(i.id) && !known.has(i.name) && i.state !== 'shutting-down')) {
                // Named by the instance id, so its last six characters alias the SSH host.
                const session = ec2Session({ region, type: i.type, image: '', user: i.user, ip: i.ip },
                    { name: i.id, jobId: i.id, desired: i.state === 'stopped' ? 'stopped' : 'running', observed: { state: observedEc2(i.state), at: Date.now() } });
                addSession(session);
                if (!isTerminal(statusOf(session))) { this.monitor().startMonitoring(session); }
                logger.info(`Adopted EC2 instance ${i.id} in ${region} as session ${session.name}`);
            }
        }
    }

    async start(session: SlurmSession): Promise<void> {
        const ec2 = this.aws.requireEc2();
        const spec = session.ec2!;
        const jobId = session.jobId || await ec2.launch(spec.image, spec.type, spec.region, csHostAlias(session));
        if (session.jobId) { await ec2.act('start', spec.region, jobId); }
        patch(session, { jobId, ec2: { ...spec, ip: '' }, connectionInfo: undefined });
        observe(session, SlurmJobStatus.RUNNING);
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
        live.connected.add(session.id);
        return true;
    }

    async remove(session: SlurmSession): Promise<void> {
        if (session.jobId) { await this.aws.requireEc2().act('terminate', session.ec2!.region, session.jobId); }
    }

    async tick(session: SlurmSession): Promise<void> {
        const ec2 = this.aws.ec2;
        if (!ec2) { return; } // signed out, or activation has not restored the key yet: hold
        const spec = session.ec2!;
        const { state, ip } = await ec2.describe(spec.region, session.jobId);
        observe(session, observedEc2(state));
        if (ip !== spec.ip) { patch(session, { ec2: { ...spec, ip } }); } // a stopped instance comes back with a new public IP
        if (state === 'running' && !session.connectionInfo && ip && await portOpen(ip, SSH_PORT)) {
            patch(session, { connectionInfo: { sshPort: SSH_PORT, controlPort: 0 }, errorMessage: '' });
        }
    }

    async end(session: SlurmSession): Promise<void> {
        live.connected.delete(session.id);
        patch(session, { connectionInfo: undefined });
    }
}
