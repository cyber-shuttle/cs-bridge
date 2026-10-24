// EC2 calls behind AwsClient, free of vscode for unit tests. Each region gets one AWS-generated key pair, saved at
// keyPath(keyName(region, machine)), and one security group opening SSH. The key pair is this machine's: another machine
// sharing the account mints its own, so neither replaces the other's.
import * as fs from 'fs';
import {
    EC2Client, CreateKeyPairCommand, DeleteKeyPairCommand, DescribeVpcsCommand, CreateDefaultVpcCommand, DescribeSecurityGroupsCommand, CreateSecurityGroupCommand,
    AuthorizeSecurityGroupIngressCommand, RunInstancesCommand, StartInstancesCommand, StopInstancesCommand,
    TerminateInstancesCommand, DescribeRegionsCommand, paginateDescribeInstances,
    _InstanceType, Instance, InstanceStateName,
} from '@aws-sdk/client-ec2';
import { EC2_DEFAULTS, EC2_IMAGES } from '../models';
import { getOrSet } from './util';

// Marks CS Bridge instances, so every listed one has a login user.
const USER_TAG = 'CS-Bridge-User';
const SECURITY_GROUP = 'CS-Bridge SSH Access';
type Ids = { InstanceIds: string[] };
const ACTIONS = {
    start: (c: EC2Client, ids: Ids) => c.send(new StartInstancesCommand(ids)),
    stop: (c: EC2Client, ids: Ids) => c.send(new StopInstancesCommand(ids)),
    terminate: (c: EC2Client, ids: Ids) => c.send(new TerminateInstancesCommand(ids)),
};
type InstanceAction = keyof typeof ACTIONS;
interface Ec2Instance { id: string; name?: string; state: InstanceStateName; type: string; ip?: string; user: string }
const LIVE_FILTERS = [
    { Name: 'tag-key', Values: [USER_TAG] },
    { Name: 'instance-state-name', Values: ['pending', 'running', 'shutting-down', 'stopping', 'stopped'] },
];

const tag = (i: Instance, key: string) => i.Tags?.find(t => t.Key === key)?.Value;
// An answer the API documents as always present.
function expect<T>(value: T | undefined, what: string): T {
    if (value === undefined) { throw new Error(`${what} came back empty`); }
    return value;
}
export const keyName = (region: string, machine: string) => `cs-aws-generated-key-${region}-${machine}`;

export class Ec2 {
    private readonly prepared = new Map<string, Promise<string>>();

    constructor(
        private readonly client: (region: string) => EC2Client,
        private readonly keyPath: (name: string) => string,
        private readonly machine: string,
    ) { }

    // The regions enabled for the account; the first call with the credentials, so it also validates them.
    async regions(): Promise<string[]> {
        const { Regions } = await this.client(EC2_DEFAULTS.region).send(new DescribeRegionsCommand({}));
        return expect(Regions, 'DescribeRegions').flatMap(r => (r.RegionName ? [r.RegionName] : [])).sort();
    }

    // name becomes the Name tag, so the console shows the same label as the VS Code window.
    async launch(image: string, type: string, region: string, name: string): Promise<string> {
        const user = EC2_IMAGES.find(i => i.ssmParameter === image)?.user;
        if (!user) { throw new Error(`Unknown image ${image}`); }
        const group = await this.prepare(region);
        const { Instances } = await this.client(region).send(new RunInstancesCommand({
            ImageId: `resolve:ssm:${image}`, InstanceType: type as _InstanceType, KeyName: keyName(region, this.machine), SecurityGroupIds: [group], MinCount: 1, MaxCount: 1,
            TagSpecifications: [{ ResourceType: 'instance', Tags: [
                { Key: 'Name', Value: name },
                { Key: USER_TAG, Value: user },
            ] }],
        }));
        return expect(Instances?.[0]?.InstanceId, 'RunInstances instance id');
    }

    // Once per region, so concurrent first launches share one key pair; a failure is retried on the next launch.
    private prepare(region: string): Promise<string> {
        return getOrSet(this.prepared, region, () => this.ensureDefaultVpc(region)
            .then(() => Promise.all([this.ensureSecurityGroup(region), this.ensureKeyPair(region)])).then(([group]) => group)
            .catch((err) => { this.prepared.delete(region); throw err; }));
    }

    private async ensureKeyPair(region: string): Promise<void> {
        const KeyName = keyName(region, this.machine);
        if (fs.existsSync(this.keyPath(KeyName))) { return; }
        const client = this.client(region);
        await client.send(new DeleteKeyPairCommand({ KeyName })); // AWS keeps it after a local uninstall
        const { KeyMaterial } = await client.send(new CreateKeyPairCommand({ KeyName, KeyType: 'ed25519' }));
        fs.writeFileSync(this.keyPath(KeyName), expect(KeyMaterial, 'CreateKeyPair private key'), { mode: 0o600 });
    }

    // The security group and RunInstances land in the default VPC, which a region may lack ("No default VPC for this user").
    private async ensureDefaultVpc(region: string): Promise<void> {
        const client = this.client(region);
        const { Vpcs } = await client.send(new DescribeVpcsCommand({ Filters: [{ Name: 'is-default', Values: ['true'] }] }));
        if (!Vpcs?.length) { await client.send(new CreateDefaultVpcCommand({})); }
    }

    private async ensureSecurityGroup(region: string): Promise<string> {
        const client = this.client(region);
        const { SecurityGroups } = await client.send(new DescribeSecurityGroupsCommand({ Filters: [{ Name: 'group-name', Values: [SECURITY_GROUP] }] }));
        const existing = SecurityGroups?.[0]?.GroupId;
        if (existing) { return existing; }
        const GroupId = expect((await client.send(new CreateSecurityGroupCommand({ GroupName: SECURITY_GROUP, Description: 'CS Bridge SSH access' }))).GroupId, 'CreateSecurityGroup group id');
        await client.send(new AuthorizeSecurityGroupIngressCommand({ GroupId, IpPermissions: [{ IpProtocol: 'tcp', FromPort: 22, ToPort: 22, IpRanges: [{ CidrIp: '0.0.0.0/0' }] }] }));
        return GroupId;
    }

    async act(action: InstanceAction, region: string, id: string): Promise<void> {
        await ACTIONS[action](this.client(region), { InstanceIds: [id] });
    }

    // A terminated instance drops out of DescribeInstances within the hour.
    async describe(region: string, id: string): Promise<Ec2Instance | undefined> {
        return (await this.list(region, [{ Name: 'instance-id', Values: [id] }]))[0];
    }

    // An instance the API describes without an id, a state, a type or the login-user tag is not one CS Bridge can drive.
    async list(region: string, filters = LIVE_FILTERS): Promise<Ec2Instance[]> {
        const instances: Ec2Instance[] = [];
        for await (const page of paginateDescribeInstances({ client: this.client(region) }, { Filters: filters })) {
            instances.push(...expect(page.Reservations, 'DescribeInstances reservations').flatMap(r => expect(r.Instances, 'DescribeInstances instances')).flatMap((i) => {
                const id = i.InstanceId, state = i.State?.Name, type = i.InstanceType, user = tag(i, USER_TAG);
                return id && state && type && user ? [{ id, name: tag(i, 'Name'), state, type, ip: i.PublicIpAddress, user }] : [];
            }));
        }
        return instances;
    }
}
