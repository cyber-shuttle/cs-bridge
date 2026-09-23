import { useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import type { SlurmDiscovery, HostRuntime } from '@/models';
import { partitionsForTab, hasTab, cpuOptions, memoryOptions, gpuOptions, resolvePick, type ResourceTab } from '@/ui/logic/cluster';
import { Row, Stack, Text, Spinner, Button, SingleSelect } from '@/ui/components/base';
import { post } from '@/ui/platform/vscode';
import { gpuTypeOf } from '@/modules/slurmParse';

interface Props {
    alias: string;
    runtime: HostRuntime | undefined;
    validating?: boolean;
}

const WALL_OPTIONS: [string, string][] = [
    ['30', '30 min'], ['60', '1 hour'], ['120', '2 hours'],
    ['240', '4 hours'], ['480', '8 hours'], ['720', '12 hours'], ['1440', '24 hours'],
];

export function Select({ label, value, onChange, options, children }: { label: string; value: string; onChange: (v: string) => void; options?: string[][]; children?: ComponentChildren }) {
    return (
        <Stack gap={2}>
            <Text weight={600} size={12}>{label}</Text>
            <SingleSelect value={value} style={{ width: '100%', maxWidth: 'none' }} onChange={onChange}>
                {options ? options.map(([v, l]) => <option key={v} value={v}>{l}</option>) : children}
            </SingleSelect>
        </Stack>
    );
}

function HostFormFields({ alias, info, validating }: { alias: string; info: SlurmDiscovery; validating?: boolean }) {
    const tabs: ResourceTab[] = (['cpu', 'gpu'] as ResourceTab[]).filter(t => hasTab(info, t));
    const initialTab = tabs[0] ?? 'cpu';
    const initialParts = partitionsForTab(info, initialTab);
    const initialPart = initialParts[0];

    const [tab, setTab] = useState<ResourceTab>(initialTab);
    const [partName, setPartName] = useState(initialPart?.name ?? '');
    const [account, setAccount] = useState(info.accounts[0] ?? '');
    const [cpuPick, setCpu] = useState('');
    const [memoryPick, setMemory] = useState('');
    const [gpuCountPick, setGpuCount] = useState('');
    const [gpuTypePick, setGpuType] = useState('');
    const [wall, setWall] = useState(WALL_OPTIONS[0][0]);

    const parts = partitionsForTab(info, tab);
    const partition = parts.find(p => p.name === partName) ?? parts[0];
    const cpus = cpuOptions(partition).map(String);
    const mems = memoryOptions(partition);
    const gpuType = resolvePick(gpuTypePick, gpuOptions(partition, tab).types, '');
    const gpus = gpuOptions(partition, tab, gpuType);
    const gpuCounts = gpus.counts.map(String);

    const cpu = resolvePick(cpuPick, cpus, '2');
    const memory = resolvePick(memoryPick, mems, '8 GB');
    const gpuCount = resolvePick(gpuCountPick, gpuCounts, '0');

    const switchTab = (t: ResourceTab) => {
        setTab(t);
        setPartName(partitionsForTab(info, t)[0]?.name ?? '');
    };

    const submit = () => {
        const count = parseInt(gpuCount, 10) || 0;
        post({
            command: 'addSession',
            alias,
            partition: partName,
            account,
            resources: { cores: Number(cpu), memoryMb: parseInt(memory, 10) * 1024, wallMinutes: Number(wall), ...count && { gpuType: gpuTypeOf(gpuType), gpuCount: count } },
        });
    };

    return (
        <Stack gap={4}>
            {tabs.length > 1
                ? (
                        <Row gap={4}>
                            {tabs.map(t => (
                                <Button key={t} style={{ flex: 1 }} secondary={t !== tab || undefined} onClick={() => switchTab(t)}>{t.toUpperCase()}</Button>
                            ))}
                        </Row>
                    )
                : null}

            {/* '' → (no Slurm account): a cluster may expose no Slurm accounts to pick (buildSlurmScript then omits --account). */}
            <Select label="Slurm account" value={account} onChange={setAccount} options={[['', '(no Slurm account)'], ...info.accounts.map(a => [a, a])]} />
            <Select label="Partition" value={partName} onChange={setPartName}>
                {parts.map(p => (
                    <option key={p.name} value={p.name}>
                        {p.gres.length ? `${p.name} (${p.cpuCount} CPUs, ${p.gres[0].count} GPUs)` : `${p.name} (${p.cpuCount} CPUs)`}
                    </option>
                ))}
            </Select>
            <Select label="CPUs" value={cpu} onChange={setCpu} options={cpus.map(c => [c, c])} />
            <Select label="Memory" value={memory} onChange={setMemory} options={mems.map(m => [m, m])} />
            {tab === 'gpu' && gpus.counts.length
                ? (
                        <>
                            <Select label="GPUs" value={gpuCount} onChange={setGpuCount} options={gpuCounts.map(n => [n, n])} />
                            <Select label="GPU Type" value={gpuType} onChange={setGpuType} options={gpus.types.map(t => [t, t])} />
                        </>
                    )
                : null}
            <Select label="Walltime" value={wall} onChange={setWall} options={WALL_OPTIONS} />
            <Button onClick={submit} disabled={validating}>
                {validating ? <Row gap={4}><Spinner size={12} /> Validating…</Row> : 'Add'}
            </Button>
        </Stack>
    );
}

export function HostForm({ alias, runtime, validating }: Props) {
    switch (runtime?.phase) {
        case 'error':
            return (
                <Stack gap={6} pad="8px">
                    <Text color="var(--vscode-errorForeground)">{runtime.message}</Text>
                    <Button onClick={() => post({ command: 'refreshSlurmDiscovery', alias })}>Retry</Button>
                </Stack>
            );
        case 'ready':
            return <HostFormFields alias={alias} info={runtime.info} validating={validating} />;
        default:
            return <Row gap={6} pad="8px"><Spinner size={16} /> Fetching runtime details…</Row>;
    }
}
