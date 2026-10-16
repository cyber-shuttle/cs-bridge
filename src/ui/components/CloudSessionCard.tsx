import { Row, Stack, Text, Card, ActionIcon, Button, Chip } from '@/ui/components/base';
import { post } from '@/ui/platform/vscode';
import { CloudInstanceInfo } from '@/models';
import type { CSSProperties, VNode } from 'preact';

const statusStyle: CSSProperties = { color: 'var(--vscode-descriptionForeground)', fontSize: '12px', flexWrap: 'wrap', minWidth: 0 };


// We will to integrate this to existing styling later
const YELLOW = ["pending", "shutting-down", "stopping"]
const ORANGE = ["stopped"]
const GREEN = ["running"]


const STATUS_ICON: Record<string, { name: string; spin?: boolean }> = {
    "pending": { name: 'loading', spin: true },
    "running": { name: 'circle-filled' },
    "failed": { name: 'primitive-square' },
    "stopped": { name: 'primitive-square' },
    "stopping": { name: 'loading', spin: true },
};
function getStateColor(state: string) {
    if (ORANGE.includes(state)) { return 'var(--vscode-charts-orange)'; }
    if (YELLOW.includes(state)) { return 'var(--vscode-charts-yellow)'; }
    if (GREEN.includes(state)) { return 'var(--vscode-charts-green)'; }
    return 'var(--vscode-descriptionForeground)';
}
const sepStyle: CSSProperties = { width: '1px', alignSelf: 'stretch', background: 'var(--vscode-descriptionForeground)', opacity: 0.45 };

function Divided({ items }: { items: VNode[] }) {
    return (
        <Row gap={8} wrap style={{ alignItems: 'stretch' }}>
            {items.flatMap((c, i) => [<div key={`sep${i}`} style={sepStyle} />, c]).concat(<div key="sepEnd" style={sepStyle} />)}
        </Row>
    );
}

export function CloudSessionCard({ instance: instance }: { instance: CloudInstanceInfo }) {
    const stateColor = getStateColor(instance.state)
    const stateInfo = STATUS_ICON[instance.state]
    const fields: (keyof CloudInstanceInfo)[] = ["region", "instanceType", "publicIp"];

    const instanceInfo = fields.map(field => {
        return {
            label: field,
            text: instance[field]
        }
    })


    return (
        <Card>
            <Row gap={6} style={{ minHeight: '20px' }}>
                <vscode-icon name={stateInfo.name} spin={stateInfo.spin || undefined} style={{ color: stateColor, flexShrink: 0, marginRight: '-3px' }}></vscode-icon>
                <Text weight={600}>{instance.name}</Text>
                <Chip label={instance.vendor ?? ""} />
                <Row gap={4} style={{ marginLeft: 'auto' }}>
                    {instance.state !== "terminated" && <ActionIcon name="close" ariaLabel="Remove Instance" size={14} onClick={() => post({ command: 'removeCloudInstance', instanceId: instance.instanceID, instanceName: instance.name, region: instance.region })} />}
                </Row>
            </Row>

            <Divided items={instanceInfo.map(g => <Text key={g.label} size={11}>{g.text}</Text>)} />
            <div style={{ borderTop: '1px solid var(--vscode-panel-border)', marginBottom: '3px' }} />
            <Stack gap={6}>
                <Row gap={6}>
                    <Row style={statusStyle}>{instance.state}</Row>
                    <Row gap={6} style={{ marginLeft: 'auto', flexShrink: 0, zoom: 0.85 }}>
                        {instance.state === "running" && <Button icon="terminal" onClick={() => post({ command: 'sshIntoCloudInstance', instanceIp: instance.publicIp, region: instance.region })}>Terminal</Button>}
                        {instance.state === "running" && <Button icon="remote" onClick={() => post({ command: 'startRemoteForloudInstance', instanceName: instance.name, instanceIp: instance.publicIp, instanceId: instance.instanceID, region: instance.region })}>Remote</Button>}
                        {instance.state === "running" && <Button icon="stop" onClick={() => post({ command: 'stopCloudInstance', instanceId: instance.instanceID, region: instance.region })}>Stop</Button>}
                        {instance.state === "stopped" && <Button icon="play" onClick={() => post({ command: 'restartCloudInstance', instanceId: instance.instanceID, region: instance.region })}>Start</Button>}
                    </Row>
                </Row>
            </Stack>
        </Card>
    );
}
