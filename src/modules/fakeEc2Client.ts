import { EC2Client } from '@aws-sdk/client-ec2';

// A real EC2Client so paginators accept it; send answers by command name. For tests.
export function fakeClient(answers: Record<string, (input: unknown) => unknown>): EC2Client {
    const client = new EC2Client({ region: 'r', credentials: { accessKeyId: 'a', secretAccessKey: 's' } });
    client.send = (async ({ constructor: { name }, input }: { constructor: { name: string }; input: unknown }) => answers[name]?.(input) ?? {}) as never;
    return client;
}
