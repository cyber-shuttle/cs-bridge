// EC2 calls behind AwsClient, free of vscode for unit tests. Each region gets one AWS-generated key pair, saved at
// keyPath(keyName(region)), and one security group opening SSH.
import * as fs from 'fs';
import {
    EC2Client, CreateKeyPairCommand, DeleteKeyPairCommand, DescribeVpcsCommand, CreateDefaultVpcCommand, DescribeSecurityGroupsCommand, CreateSecurityGroupCommand,
    AuthorizeSecurityGroupIngressCommand, RunInstancesCommand, StartInstancesCommand, StopInstancesCommand,
    TerminateInstancesCommand, DescribeRegionsCommand, paginateDescribeInstances,
    _InstanceType, Instance,
} from '@aws-sdk/client-ec2';
import { EC2_DEFAULTS, EC2_IMAGES } from '../models';

// Marks CS Bridge instances, so every listed one has a login user.
const USER_TAG = 'CS-Bridge-User';
const SECURITY_GROUP = 'CS-Bridge SSH Access';
type Ids = { InstanceIds: string[] };
const ACTIONS = {
    start: (c: EC2Client, ids: Ids) => c.send(new StartInstancesCommand(ids)),
    stop: (c: EC2Client, ids: Ids) => c.send(new StopInstancesCommand(ids)),
    terminate: (c: EC2Client, ids: Ids) => c.send(new TerminateInstancesCommand(ids)),
};
export type InstanceAction = keyof typeof ACTIONS;
export interface Ec2Instance { id: string; name: string; state: string; type: string; ip: string; user: string }
const LIVE_FILTERS = [
    { Name: 'tag-key', Values: [USER_TAG] },
    { Name: 'instance-state-name', Values: ['pending', 'running', 'shutting-down', 'stopping', 'stopped'] },
];

const tag = (i: Instance, key: string) => i.Tags?.find(t => t.Key === key)?.Value ?? '';
export const keyName = (region: string) => `cs-aws-generated-key-${region}`;

export class Ec2 {
    private readonly prepared = new Map<string, Promise<string>>();

    constructor(
        private readonly client: (region: string) => EC2Client,
        private readonly keyPath: (name: string) => string,
    ) { }

    // The regions enabled for the account; the first call with the credentials, so it also validates them.
    async regions(): Promise<string[]> {
        const { Regions } = await this.client(EC2_DEFAULTS.region).send(new DescribeRegionsCommand({}));
        return (Regions ?? []).flatMap(r => r.RegionName ?? []).sort();
    }

    // name becomes the Name tag, so the console shows the same label as the VS Code window.
    async launch(image: string, type: string, region: string, name: string): Promise<string> {
        const user = EC2_IMAGES.find(i => i.ssmParameter === image)?.user;
        if (!user) { throw new Error(`Unknown image ${image}`); }
        const group = await this.prepare(region);
        const { Instances } = await this.client(region).send(new RunInstancesCommand({
            ImageId: `resolve:ssm:${image}`, InstanceType: type as _InstanceType, KeyName: keyName(region), SecurityGroupIds: [group], MinCount: 1, MaxCount: 1,
            TagSpecifications: [{ ResourceType: 'instance', Tags: [
                { Key: 'Name', Value: name },
                { Key: USER_TAG, Value: user },
            ] }],
        }));
        const id = Instances?.[0]?.InstanceId;
        if (!id) { throw new Error('RunInstances returned no instance id'); }
        return id;
    }

    // Once per region, so concurrent first launches share one key pair; a failure is retried on the next launch.
    private prepare(region: string): Promise<string> {
        if (!this.prepared.has(region)) {
            this.prepared.set(region, this.ensureDefaultVpc(region).then(() => Promise.all([this.ensureSecurityGroup(region), this.ensureKeyPair(region)])).then(([group]) => group).catch((err) => {
                this.prepared.delete(region);
                throw err;
            }));
        }
        return this.prepared.get(region)!;
    }

    private async ensureKeyPair(region: string): Promise<void> {
        const KeyName = keyName(region);
        if (fs.existsSync(this.keyPath(KeyName))) { return; }
        const client = this.client(region);
        await client.send(new DeleteKeyPairCommand({ KeyName })); // AWS keeps it after a local uninstall
        const { KeyMaterial } = await client.send(new CreateKeyPairCommand({ KeyName, KeyType: 'ed25519' }));
        fs.writeFileSync(this.keyPath(KeyName), KeyMaterial ?? '', { mode: 0o600 });
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
        const { GroupId } = await client.send(new CreateSecurityGroupCommand({ GroupName: SECURITY_GROUP, Description: 'CS Bridge SSH access' }));
        if (!GroupId) { throw new Error('CreateSecurityGroup returned no group id'); }
        await client.send(new AuthorizeSecurityGroupIngressCommand({ GroupId, IpPermissions: [{ IpProtocol: 'tcp', FromPort: 22, ToPort: 22, IpRanges: [{ CidrIp: '0.0.0.0/0' }] }] }));
        return GroupId;
    }

    act(action: InstanceAction, region: string, id: string): Promise<unknown> {
        return ACTIONS[action](this.client(region), { InstanceIds: [id] });
    }

    // A terminated instance drops out of DescribeInstances within the hour; absent reads as terminated.
    async describe(region: string, id: string): Promise<Ec2Instance> {
        const found = await this.list(region, [{ Name: 'instance-id', Values: [id] }]);
        return found[0] ?? { id, name: '', state: 'terminated', type: '', ip: '', user: '' };
    }

    async list(region: string, filters = LIVE_FILTERS): Promise<Ec2Instance[]> {
        const instances: Ec2Instance[] = [];
        for await (const page of paginateDescribeInstances({ client: this.client(region) }, { Filters: filters })) {
            instances.push(...(page.Reservations ?? []).flatMap(r => r.Instances ?? []).map(i => ({
                id: i.InstanceId ?? '', name: tag(i, 'Name'), state: i.State?.Name ?? '', type: i.InstanceType ?? '',
                ip: i.PublicIpAddress ?? '', user: tag(i, USER_TAG),
            })));
        }
        return instances;
    }
}
