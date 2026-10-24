import { createContext } from 'preact';
import { useContext } from 'preact/hooks';
import type { CSSProperties, VNode } from 'preact';
import { SAMPLE_HISTORY_LEN, type SessionsMessage, type ViewSession } from '@/models';
import { cardModel, type SessionAction } from '@/ui/logic/session';
import { isReachable } from '@/modules/sessionMachine';
import { Row, Stack, Text, Card, Icon, ActionIcon, Button, Spinner, Chip } from '@/ui/components/base';
import { Sparkline } from '@/ui/components/Sparkline';
import { usageGraphs, graphTitle, drawable } from '@/ui/components/UsageGraphs';
import { post } from '@/ui/platform/vscode';

interface Props {
    session: ViewSession;
    remote?: boolean;
}

// 1s clock owned by the Sessions root, fed through this context so the status text re-renders each tick.
export const NowContext = createContext(Date.now());

const COMMAND_FOR: Record<SessionAction['kind'], Extract<SessionsMessage, { sessionId: string }>['command'] | null> = {
    start: 'prepareLaunchSession',
    stop: 'stopSessionExecution',
    switch: 'connectTunnel',
    connect: 'connectTunnel',
    current: null,
    opening: null,
};

const statusStyle: CSSProperties = { color: 'var(--vscode-descriptionForeground)', fontSize: '12px', flexWrap: 'wrap', minWidth: 0 };

const sepStyle: CSSProperties = { width: '1px', alignSelf: 'stretch', background: 'var(--vscode-descriptionForeground)', opacity: 0.45 };

// Lay items in a row divided by vertical separators, one before the first and after the last too.
export function Divided({ items }: { items: VNode[] }) {
    return (
        <Row gap={8} wrap style={{ alignItems: 'stretch' }}>
            {items.flatMap((c, i) => [<div key={`sep${i}`} style={sepStyle} />, c]).concat(<div key="sepEnd" style={sepStyle} />)}
        </Row>
    );
}

// Raw resource text (e.g. "MEM: 2G", "CPU: 1", "GPU: 1") above each live sparkline when reachable; a plain row
// otherwise. Columns bracketed by vertical separators.
function ResourceStats({ session }: { session: ViewSession }) {
    const graphs = usageGraphs(session.samples ?? [], session.resources.gpuCount ?? 0, session.resources);
    if (!isReachable(session.status)) {
        return <Divided items={graphs.map(g => <Text key={g.label} size={11}>{g.text}</Text>)} />;
    }
    return (
        <Divided items={graphs.map(g => (
            <Stack key={g.label} gap={1} style={{ minWidth: '44px', alignItems: 'flex-start' }}>
                <Text size={11}>{g.text}</Text>
                {drawable(g)
                    ? <Sparkline lines={g.lines} slots={SAMPLE_HISTORY_LEN} title={graphTitle(g)} />
                    : <div style={{ height: '14px' }} />}
            </Stack>
        ))}
        />
    );
}

export function SessionCard({ session, remote }: Props) {
    const m = cardModel(session, useContext(NowContext), remote);

    const act = (a: SessionAction) => {
        const command = remote ? 'stopRemoteSession' : COMMAND_FOR[a.kind];
        if (command) { post({ command, sessionId: session.id }); }
    };

    // The theme's validation colors hold in light and dark alike; softened, since the dark info blue overpowers at full strength.
    const edge = `color-mix(in srgb, var(--vscode-inputValidation-${m.theme}Border) 25%, var(--vscode-panel-border))`;
    const tint = `color-mix(in srgb, var(--vscode-inputValidation-${m.theme}Background) 70%, var(--vscode-sideBar-background))`;
    return (
        <Card border={edge}>
            {/* Fixed height keeps the gap to the detail row constant whether or not the delete button shows. Negative
                margins run the header tint out to the card's edge. */}
            <Row gap={5} style={{ minHeight: '20px', margin: '-5px -8px 0', padding: '1px 8px', letterSpacing: '-0.2px', borderRadius: '5px 5px 0 0', background: tint, borderBottom: `1px solid ${edge}` }}>
                <Icon name={m.icon.name} spin={m.icon.spin} style={{ color: m.color, flexShrink: 0, marginRight: '-3px' }} />
                <Text weight={600}>{session.alias}</Text>
                {m.chips.map(c => <Chip key={c} label={c} />)}
                {m.canDelete
                    ? (
                            <Row gap={4} style={{ marginLeft: 'auto' }}>
                                <ActionIcon name="close" ariaLabel="Delete session" size={14} onClick={() => post({ command: 'deleteSession', sessionId: session.id })} />
                            </Row>
                        )
                    : null}
            </Row>
            <Stack gap={6}>
                {m.details ? <Divided items={m.details.map(t => <Text key={t} size={11}>{t}</Text>)} /> : <ResourceStats session={session} />}
                <Row gap={6}>
                    <Chip label={m.kind} background={tint} />
                    {m.walltime ? <Chip label={m.walltime} /> : null}
                    <Row style={statusStyle}><Text title={m.status.title}>{m.status.text}</Text></Row>
                    {m.actions.length ? (
                        <Row gap={6} style={{ marginLeft: 'auto', flexShrink: 0, zoom: 0.85 }}>
                            {m.actions.map(a => a.kind === 'opening'
                                ? <Button key={a.kind} disabled><Row gap={4}><Spinner size={11} /> {a.label}</Row></Button>
                                : <Button key={a.kind} icon={a.icon} disabled={a.kind === 'current' || undefined} onClick={() => act(a)}>{a.label}</Button>)}
                        </Row>
                    ) : null}
                </Row>
            </Stack>
        </Card>
    );
}
