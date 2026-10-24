// An EC2 instance as a session's backend: the monitor's poll and teardown, and the provider's start, stop, connect
// and remove, so an instance rides the Slurm session lifecycle. 'preparing' holds until the instance's port 22
// accepts a connection; connect only writes the per-session SSH host, since the instance is reached over plain SSH.
import * as net from 'net';
import { Ec2Session, Ec2Spec, SlurmJobStatus, SlurmSession, newSession } from '../models';
import { Logger } from '../logger';
import { addSession, getAllSessions, live, observe, patch, statusOf } from '../extensionStore';
import { AwsClient } from './aws';
import { isTerminal, observedEc2 } from './sessionMachine';
import { Backend, SessionMonitor } from './sessionSupport';
import { csHostAlias } from './sshHostsStore';
import { sleep } from './util';

const logger = Logger.getInstance();
const SSH_PORT = 22;

const portOpen = (host: string, port: number): Promise<boolean> => new Promise((resolve) => {
    const socket = net.connect({ host, port, timeout: 3_000 });
    const done = (open: boolean) => { socket.destroy(); resolve(open); };
    socket.once('connect', () => done(true)).once('timeout', () => done(false)).once('error', () => done(false));
});

// An EC2 record: the Slurm-only fields are blank, and no walltime means no deadline.
export const ec2Session = (ec2: Ec2Spec, fields: Partial<SlurmSession> = {}): Ec2Session =>
    ({ ...newSession({ alias: `aws-${ec2.region}`, account: '', partition: '', rootFolder: `/home/${ec2.user}`, resources: { cores: 0, memoryMb: 0, wallMinutes: 0 }, ...fields }), ec2 });

export class Ec2Backend implements Backend<Ec2Session> {
    readonly label = 'AWS';

    // The monitor is built with this backend, so it arrives lazily.
    constructor(private readonly aws: AwsClient, private readonly monitor: () => SessionMonitor) { }

    forget(): void { }

    // Every tagged instance without a record becomes one, so a VM launched from another machine is never lost.
    async adopt(): Promise<void> {
        const { ec2, regions } = this.aws.require();
        // A launch in flight elsewhere has tagged its instance with the record's alias before it records the id.
        const known = new Set(getAllSessions().flatMap(s => [s.jobId, csHostAlias(s)]));
        for (const region of regions) {
            const found = await ec2.list(region).catch((err) => { logger.error(`EC2 list of ${region} failed:`, err); return []; });
            for (const i of found.filter(i => !known.has(i.id) && !(i.name && known.has(i.name)) && i.state !== 'shutting-down')) {
                // Named by the instance id, so its last six characters alias the SSH host.
                const session = ec2Session({ region, type: i.type, image: '', user: i.user, ip: i.ip },
                    { name: i.id, jobId: i.id, desired: i.state === 'stopped' ? 'stopped' : 'running', observed: { state: observedEc2(i.state), at: Date.now() } });
                addSession(session);
                if (!isTerminal(statusOf(session))) { this.monitor().startMonitoring(session); }
                logger.info(`Adopted EC2 instance ${i.id} in ${region} as session ${session.name}`);
            }
        }
    }

    async start(session: Ec2Session): Promise<void> {
        const { ec2 } = this.aws.require();
        const spec = session.ec2;
        // An instance AWS no longer has, or is terminating, is replaced by a fresh launch.
        const existing = session.jobId ? await ec2.describe(spec.region, session.jobId) : undefined;
        const reusable = existing && existing.state !== 'terminated' && existing.state !== 'shutting-down';
        const jobId = reusable ? session.jobId : await ec2.launch(spec.image, spec.type, spec.region, csHostAlias(session));
        if (reusable) { await ec2.act('start', spec.region, jobId); }
        patch(session, { jobId, ec2: { ...spec, ip: undefined }, connectionInfo: undefined });
        observe(session, SlurmJobStatus.RUNNING);
        this.monitor().startMonitoring(session);
    }

    // EC2 refuses to stop a pending instance, so the stop is sent once the instance can take it and the task holds
    // until the instance has stopped. Signed out, the stop waits for the next sweep; refused, it leaves the instance running.
    async stop(session: Ec2Session): Promise<void> {
        const ec2 = this.aws.ec2;
        if (!ec2) { return; }
        const { region } = session.ec2;
        try {
            let sent = false;
            for (;;) {
                const instance = await ec2.describe(region, session.jobId);
                if (!instance || instance.state === 'stopped' || instance.state === 'terminated') { observe(session, instance ? observedEc2(instance.state) : observedEc2('terminated')); break; }
                if (!sent && instance.state !== 'pending') { await ec2.act('stop', region, session.jobId); sent = true; }
                await sleep(5_000);
            }
        }
        catch (err) { patch(session, { desired: 'running' }); throw err; }
        await this.monitor().endSession(session);
    }

    async connect(session: Ec2Session): Promise<boolean> {
        live.connected.add(session.id);
        return true;
    }

    async remove(session: Ec2Session): Promise<void> {
        const { ec2 } = this.aws.require();
        if (session.jobId && await ec2.describe(session.ec2.region, session.jobId)) { await ec2.act('terminate', session.ec2.region, session.jobId); }
    }

    async tick(session: Ec2Session): Promise<void> {
        const ec2 = this.aws.ec2;
        if (!ec2) { return; } // signed out, or activation has not restored the key yet: hold
        const spec = session.ec2;
        const instance = await ec2.describe(spec.region, session.jobId);
        if (!instance) { observe(session, observedEc2('terminated')); return; }
        const { state, ip } = instance;
        observe(session, observedEc2(state));
        if (ip !== spec.ip) { patch(session, { ec2: { ...spec, ip } }); } // a stopped instance comes back with a new public IP
        if (state === 'running' && !session.connectionInfo && ip && await portOpen(ip, SSH_PORT)) {
            patch(session, { connectionInfo: { sshPort: SSH_PORT, controlPort: 0 }, errorMessage: '' });
        }
    }

    async end(session: Ec2Session): Promise<void> {
        live.connected.delete(session.id);
        patch(session, { connectionInfo: undefined });
    }
}
