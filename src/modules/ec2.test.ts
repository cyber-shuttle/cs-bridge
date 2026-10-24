import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { EC2Client } from '@aws-sdk/client-ec2';
import { Ec2 } from './ec2';

// A real EC2Client so paginators accept it; send answers by command name.
function fakeClient(answers: Record<string, (input: unknown) => unknown>) {
    const client = new EC2Client({ region: 'r', credentials: { accessKeyId: 'a', secretAccessKey: 's' } });
    client.send = (async ({ constructor: { name }, input }: { constructor: { name: string }; input: unknown }) => answers[name]?.(input) ?? {}) as never;
    return client;
}

test('list reads every page of tagged instances and takes the login user from the tag', async () => {
    const filters: unknown[] = [];
    const instance = (id: string, user: string) => ({
        InstanceId: id, InstanceType: 't3.medium', State: { Name: 'running' }, PublicIpAddress: '1.2.3.4',
        Tags: [{ Key: 'Name', Value: `CS-Bridge-${id}` }, { Key: 'CS-Bridge-User', Value: user }],
    });
    const client = fakeClient({
        DescribeInstancesCommand: input => filters.push((input as { Filters: unknown }).Filters) && (input as { NextToken?: string }).NextToken
            ? { Reservations: [{ Instances: [instance('i-2', 'ubuntu')] }] }
            : { Reservations: [{ Instances: [instance('i-1', 'ec2-user')] }], NextToken: 'p2' },
    });
    const listed = await new Ec2(() => client, () => '', 'm').list('r1');
    assert.deepEqual(listed.map(i => [i.id, i.user, i.ip]), [['i-1', 'ec2-user', '1.2.3.4'], ['i-2', 'ubuntu', '1.2.3.4']]);
    assert.deepEqual((filters[0] as unknown[])[0], { Name: 'tag-key', Values: ['CS-Bridge-User'] });
});

test('concurrent first launches in a region share one key pair and create the missing default VPC', async () => {
    let created = 0;
    let vpcs = 0;
    const client = fakeClient({
        CreateDefaultVpcCommand: () => ({ Vpc: { VpcId: `vpc-${++vpcs}` } }),
        DescribeSecurityGroupsCommand: () => ({ SecurityGroups: [{ GroupId: 'sg-1' }] }),
        RunInstancesCommand: () => ({ Instances: [{ InstanceId: 'i-new' }] }),
        CreateKeyPairCommand: () => ({ KeyMaterial: `key${++created}` }),
    });
    const dir = mkdtempSync(join(tmpdir(), 'ec2-'));
    const ec2 = new Ec2(() => client, name => join(dir, name), 'm');
    const image = '/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64';
    const spec = { image, type: 't3.micro', region: 'r1', user: 'ec2-user' };
    await Promise.all([ec2.launch(spec, 'a'), ec2.launch(spec, 'b')]);
    assert.equal(created, 1);
    assert.equal(vpcs, 1);
});

test('describe reads an instance gone from DescribeInstances as absent', async () => {
    const client = fakeClient({ DescribeInstancesCommand: () => ({ Reservations: [] }) });
    assert.equal(await new Ec2(() => client, () => '', 'm').describe('r1', 'i-9'), undefined);
});
