// EC2 launch form and instance cards, laid out like SessionCard.
import { useState } from 'preact/hooks';
import { EC2_DEFAULTS, EC2_IMAGES, EC2_TYPES, type CloudInstance } from '@/models';
import { Row, Stack, Text, Card, Icon, ActionIcon, Button, Chip } from '@/ui/components/base';
import { Select } from '@/ui/components/HostForm';
import { Divided } from '@/ui/components/SessionCard';
import { post } from '@/ui/platform/vscode';

const pairs = (values: string[]) => values.map(v => [v, v]);

export function CloudFormCard({ regions }: { regions: string[] }) {
    const [image, setImage] = useState(EC2_IMAGES[0].ssmParameter);
    const [type, setType] = useState(EC2_DEFAULTS.type);
    const [region, setRegion] = useState(EC2_DEFAULTS.region);
    return (
        <Card>
            <Row gap={6}>
                <Icon name="cloud" />
                <Text weight={600}>Launch EC2 Instance</Text>
                <ActionIcon name="close" ariaLabel="Dismiss" onClick={() => post({ command: 'dismissCloudForm' })} />
            </Row>
            <Stack gap={4}>
                <Select label="Image" value={image} onChange={setImage} options={EC2_IMAGES.map(i => [i.ssmParameter, i.label])} />
                <Select label="Instance Type" value={type} onChange={setType} options={pairs(EC2_TYPES)} />
                <Select label="Region" value={region} onChange={setRegion} options={pairs(regions)} />
                <Button onClick={() => post({ command: 'launchCloudInstance', launch: { image, type, region } })}>Launch</Button>
            </Stack>
        </Card>
    );
}

// Any other state is a transition.
const STATE_ICON: Record<string, { name: string; color: string; spin?: boolean }> = {
    running: { name: 'circle-filled', color: 'green' },
    stopped: { name: 'primitive-square', color: 'orange' },
};
const TRANSITION = { name: 'loading', color: 'yellow', spin: true };

export function CloudInstanceCard({ instance }: { instance: CloudInstance }) {
    const icon = STATE_ICON[instance.state] ?? TRANSITION;
    const act = (command: string) => () => post({ command, instance });
    const running = instance.state === 'running';
    return (
        <Card>
            <Row gap={6} style={{ minHeight: '20px' }}>
                <Icon name={icon.name} spin={icon.spin} style={{ color: `var(--vscode-charts-${icon.color})`, flexShrink: 0, marginRight: '-3px' }} />
                <Text weight={600}>{instance.name}</Text>
                <Chip label="AWS" />
                <ActionIcon name="close" ariaLabel="Remove instance" size={14} onClick={act('removeCloudInstance')} />
            </Row>
            <Divided items={[instance.region, instance.type, instance.ip].filter(Boolean).map(t => <Text key={t} size={11}>{t}</Text>)} />
            <Row gap={6}>
                <Text muted size={12}>{instance.state}</Text>
                <Row gap={6} style={{ marginLeft: 'auto', zoom: 0.85 }}>
                    {running && instance.ip ? <Button icon="terminal" onClick={act('openCloudTerminal')}>Terminal</Button> : null}
                    {running && instance.ip ? <Button icon="remote" onClick={act('openCloudRemote')}>Remote</Button> : null}
                    {running ? <Button icon="stop" onClick={act('stopCloudInstance')}>Stop</Button> : null}
                    {instance.state === 'stopped' ? <Button icon="play" onClick={act('startCloudInstance')}>Start</Button> : null}
                </Row>
            </Row>
        </Card>
    );
}
