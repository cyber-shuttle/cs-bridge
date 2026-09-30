import { SAMPLE_HISTORY_LEN, type GpuSample, type Resources, type UsageSample } from '@/models';
import { cpuCoreSeries } from '@/ui/logic/usage';
import { humanKib } from '@/modules/slurmParse';
import { Row, Stack, Text } from '@/ui/components/base';
import { Sparkline, type SparkLine } from '@/ui/components/Sparkline';

const CHART = { cpu: 'var(--vscode-charts-blue)', mem: 'var(--vscode-charts-purple)', gpu: 'var(--vscode-charts-green)', gpuMem: 'var(--vscode-charts-orange)' };
const PCT: [number, number] = [0, 100];
const pct = (unit: string) => (v: number) => `${Math.round(v)}% ${unit}`;
const gpuMemPct = (g?: GpuSample) => (g && g.memTotalMiB ? (g.memUsedMiB / g.memTotalMiB) * 100 : undefined);

type Graph = { label: string; text: string; lines: (SparkLine & { fmt: (v: number) => string })[] };

// CPU / memory / per-GPU series from a rolling live-sample window, in MEM, CPU, GPU order.
export function usageGraphs(history: UsageSample[], gpuCount: number, allocated?: Resources): Graph[] {
    function at<T>(f: (s: UsageSample) => T | undefined): T[] { return history.map(f).filter((v): v is T => v !== undefined); }
    const gpuN = Math.max(gpuCount > 0 ? 1 : 0, ...history.map(s => s.gpus?.length ?? 0));
    return [
        { label: 'MEM', text: allocated ? `MEM: ${allocated.memoryMb / 1024}G` : 'MEM', lines: [{ values: at(s => s.memBytes), color: CHART.mem, fmt: v => humanKib(v / 1024) }] },
        { label: 'CPU', text: allocated ? `CPU: ${allocated.cores}` : 'CPU', lines: [{ values: cpuCoreSeries(history), color: CHART.cpu, fmt: v => `${v.toFixed(1)} cores` }] },
        ...Array.from({ length: gpuN }, (_, i): Graph => ({
            label: gpuN > 1 ? `GPU${i}` : 'GPU',
            text: gpuN > 1 ? `GPU${i}` : allocated ? `GPU: ${gpuCount}` : 'GPU',
            lines: [
                { values: at(s => s.gpus?.[i]?.utilPct), color: CHART.gpu, domain: PCT, fmt: pct('util') },
                { values: at(s => gpuMemPct(s.gpus?.[i])), color: CHART.gpuMem, domain: PCT, fmt: pct('mem') },
            ],
        })),
    ];
}

export const graphTitle = (g: Graph) => `${g.label} — ${g.lines.map(l => l.fmt(l.values.at(-1)!)).join(', ')}`;

export function UsageGraphs({ history, gpuCount }: { history: UsageSample[]; gpuCount: number }) {
    const shown = usageGraphs(history, gpuCount).filter(g => g.lines[0].values.length >= 2);
    if (!shown.length) { return null; }
    return (
        <Row gap={8} wrap>
            {shown.map(g => (
                <Stack key={g.label} gap={1}>
                    <Text muted size={10}>{g.label}</Text>
                    <Sparkline lines={g.lines} slots={SAMPLE_HISTORY_LEN} title={graphTitle(g)} />
                </Stack>
            ))}
        </Row>
    );
}
