import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { SessionsState, HostRuntime } from '@/models';
import { post, useWebviewState } from '@/ui/platform/vscode';
import { SessionCard, NowContext } from '@/ui/components/SessionCard';
import { HostForm } from '@/ui/components/HostForm';
import { Row, Stack, Text, Card, Icon, ActionIcon, Button } from '@/ui/components/base';
import { CloudSessionCard } from '../components/CloudSessionCard';
import { CloudForm } from '../components/CloudForm';

function ConfigCard({ icon, muted, alias, runtime, onDismiss, validating }: {
    icon: string; muted?: boolean; alias: string; runtime: HostRuntime | undefined;
    onDismiss: () => void; validating?: boolean;
}) {
    return (
        <Card>
            <Row gap={6}>
                <Icon name={icon} style={muted ? { color: 'var(--vscode-descriptionForeground)' } : undefined} />
                <Text weight={600}>{alias}</Text>
                <Row gap={4} style={{ marginLeft: 'auto' }}>
                    <ActionIcon name="refresh" title="Refresh Slurm details" ariaLabel="Refresh Slurm details" onClick={() => post({ command: 'refreshSlurmDiscovery', alias })} />
                    <ActionIcon name="close" ariaLabel="Dismiss" onClick={onDismiss} />
                </Row>
            </Row>
            <HostForm alias={alias} runtime={runtime} validating={validating} />
        </Card>
    );
}

function CloudConfigCard({ state, icon, muted, onDismiss }: { state: SessionsState, icon: string, muted?: boolean, onDismiss: () => void }) {

    const options = state.cloudFormOptions
    const formState = state.cloudForm

    return (
        <Card>
            <Row gap={6}>
                <Icon name={icon} style={muted ? { color: 'var(--vscode-descriptionForeground)' } : undefined} />
                <Text weight={600}>Instance Options</Text>
                <Row gap={4} style={{ marginLeft: 'auto' }}>
                    <ActionIcon name="close" ariaLabel="Dismiss" onClick={onDismiss} />
                </Row>
            </Row>

            {formState === "loading" && <Row gap={6} pad="8px"><Spinner size={16} />Fetching Form Options</Row>}
            {formState !== "loading" && <CloudForm options={options} vendors={[["AWS", "AWS"]]} />}
        </Card>
    );
}

function gpuInitial(gpuClass: string): Partial<HostFormInitial> {
    const gpu = parseGpuClass(gpuClass);
    return gpu ? { tab: 'gpu', gpuType: gpu.gpuType, gpuCount: gpu.gpuCount } : { tab: 'cpu' };
}

function editInitial(session: ViewSession): HostFormInitial {
    return {
        ...gpuInitial(session.gpuClass),
        partName: session.queue,
        allocation: session.allocation,
        cpu: String(session.cpus),
        memory: session.memory,
        wall: session.wallTime,
    };
}

function ScriptPreviewOverlay({ state }: { state: SessionsState }) {
    const s = state.previewSession;
    if (!s) { return null; }
    return (
        <Stack gap={8} pad="12px" style={{ position: 'fixed', inset: 0, background: 'var(--vscode-editor-background)', zIndex: 10 }}>
            <Text weight={600}>Slurm Job Script Preview</Text>
            <Text muted>SSH host: {s.alias}</Text>
            <Text block style={{ flex: 1, overflow: 'auto', whiteSpace: 'pre', fontFamily: 'var(--vscode-editor-font-family)', fontSize: '12px', background: 'var(--vscode-textCodeBlock-background)', padding: '8px', borderRadius: '4px' }}>{s.jobScript ?? ''}</Text>
            <Row gap={8} justify="flex-end">
                <Button secondary onClick={() => post({ command: 'dismissPreview' })}>Close</Button>
                <Button onClick={() => post({ command: 'launchSession', sessionId: s.id })}>Submit Job</Button>
            </Row>
        </Stack>
    );
}

function AlertOverlay({ alert }: { alert: NonNullable<SessionsState['alert']> }) {
    return (
        <Row style={{ position: 'fixed', inset: 0, background: 'rgba(0, 0, 0, 0.4)', zIndex: 20, justifyContent: 'center' }}>
            <Stack gap={8} pad="12px" style={{ flex: 1, margin: '12px', maxHeight: '85%', background: 'var(--vscode-editorWidget-background)', border: '1px solid var(--vscode-editorWidget-border)', borderRadius: '4px' }}>
                <Row gap={6}>
                    <Icon name="error" style={{ color: 'var(--vscode-errorForeground)' }} />
                    <Text weight={600}>{alert.title}</Text>
                </Row>
                <Text block style={{ overflow: 'auto', whiteSpace: 'pre-wrap', fontFamily: 'var(--vscode-editor-font-family)', fontSize: '12px', background: 'var(--vscode-textCodeBlock-background)', padding: '8px', borderRadius: '4px' }}>{alert.message}</Text>
                <Row gap={8} justify="flex-end">
                    <Button onClick={() => post({ command: 'dismissAlert' })}>Dismiss</Button>
                </Row>
            </Stack>
        </Row>
    );
}

function SessionsView({ state }: { state: SessionsState }) {
    if (state.isRemote) {
        const session = state.sessions[0];
        return session
            ? <SessionCard key={session.id} session={session} remote />
            : <Text muted style={{ margin: '2px 0' }}>No active session.</Text>;
    }
    return (
        <>
            {state.draftAlias ? <ConfigCard key={state.draftAlias} icon="circle-outline" muted alias={state.draftAlias} runtime={state.hostRuntime[state.draftAlias]} onDismiss={() => post({ command: 'dismissDraftSession' })} validating={state.validating} /> : null}
            {state.sessions.map(s => <SessionCard key={s.id} session={s} />)}
            {
                !state.sessions.length && !state.draftAlias && !state.cloudSessions.length && !state.cloudForm
                    ? <Text muted block style={{ margin: '4px', textAlign: 'center' }}>No sessions yet. Click on + to create one.</Text>
                    : null
            }
            <ScriptPreviewOverlay state={state} />
            {state.cloudForm && <CloudConfigCard state={state} icon="circle-outline" muted onDismiss={() => post({ command: 'dismissCloudForm' })} />}
            {state.cloudSessions.map(s => <CloudSessionCard key={s.instanceID} instance={s} />)}
            {state.alert ? <AlertOverlay alert={state.alert} /> : null}
        </>
    );
}

function Root() {
    const state = useWebviewState<SessionsState>();
    const [now, setNow] = useState(Date.now());
    useEffect(() => {
        const id = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(id);
    }, []);

    useEffect(() => {
        if (state?.isCloud) {
            post({ command: 'pollCloudStatus' });
        }
    }, [state?.isCloud]);
    return state
        ? <NowContext.Provider value={now}><Stack pad="8px"><SessionsView state={state} /></Stack></NowContext.Provider>
        : null;
}

render(<Root />, document.getElementById('root')!);
