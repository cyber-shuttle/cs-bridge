import { render } from 'preact';
import { useWebviewState } from '@/ui/platform/vscode';
import { Stack, Row, Text, Card, Icon, Spinner } from '@/ui/components/base';
import { fmtTime, wallMs, elapsedRunMs } from '@/ui/logic/session';
import { StatsView, MetricRow as Field } from '@/ui/components/StatsView';
import { UsageGraphs } from '@/ui/components/UsageGraphs';
import { isTerminal, isWallTimeExpired } from '@/modules/sessionMachine';
import type { SlurmSession, SummaryState } from '@/models';

const STATUS_LABEL: Partial<Record<SlurmSession['status'], string>> = {
    stopped: 'Stopped', failed: 'Failed',
};

// The record may not be terminal yet at summary time: the walltime path tears down at the deadline,
// ~30s before any sidebar marks it 'stopped' (and a reload demotes 'connected' → 'ready_to_connect').
// So derive the ended-state label rather than trusting the raw status.
function finalStateLabel(s: SlurmSession): string {
    if (isTerminal(s.status)) { return STATUS_LABEL[s.status] ?? s.status; }
    if (isWallTimeExpired(s, Date.now())) { return 'Walltime reached'; }
    return 'Ended';
}

function Root() {
    const state = useWebviewState<SummaryState>();
    const s = state?.session;
    if (!s) { return <Stack pad="12px"><Text muted>Loading summary…</Text></Stack>; }
    const loadingMsg = s.status === 'stopping' ? 'Stopping session and preparing summary…'
        : !state?.stats ? 'Fetching Slurm accounting…'
                : null;
    if (loadingMsg) {
        return <Stack gap={12} pad="48px" style={{ alignItems: 'center' }}><Spinner size={28} /><Text muted>{loadingMsg}</Text></Stack>;
    }

    const { cores, memoryMb, gpuType, gpuCount = 0 } = s.resources;
    const usedMs = elapsedRunMs(s, Date.now());
    const limitMs = wallMs(s);

    return (
        <Stack gap={10} pad="14px 16px" style={{ maxWidth: '640px', margin: '0 auto' }}>
            <Row gap={8} wrap>
                <Icon name="server-environment" />
                <Text size={16} weight={600}>{s.name}</Text>
                <Text muted>· {s.alias}</Text>
                <Text muted>· {finalStateLabel(s)}</Text>
            </Row>

            <Card>
                <Text weight={600} style={{ marginBottom: '4px' }}>Resources</Text>
                <Field label="CPUs" value={String(cores)} />
                <Field label="Memory" value={`${memoryMb / 1024} GB`} />
                <Field label="GPUs" value={gpuCount ? `${gpuCount} × ${gpuType}` : 'None'} />
                <Field label="Partition" value={s.partition} />
                <Field label="Slurm account" value={s.account} />
                <Field label="Job ID" value={s.jobId} />
            </Card>

            <Card>
                <Text weight={600} style={{ marginBottom: '4px' }}>Walltime</Text>
                <Field label="Used" value={fmtTime(usedMs)} />
                <Field label="Limit" value={limitMs > 0 ? fmtTime(limitMs) : 'No limit'} />
            </Card>

            {state?.samples?.length ? (
                <Card>
                    <Row gap={6} style={{ marginBottom: '4px' }}>
                        <Icon name="pulse" />
                        <Text weight={600}>Live resource history</Text>
                    </Row>
                    <UsageGraphs history={state.samples} gpuCount={gpuCount} />
                </Card>
            ) : null}

            <Card>
                <Row gap={6} style={{ marginBottom: '4px' }}>
                    <Icon name="graph" />
                    <Text weight={600}>Slurm accounting</Text>
                </Row>
                <StatsView stats={state?.stats} />
            </Card>
        </Stack>
    );
}

render(<Root />, document.getElementById('root')!);
