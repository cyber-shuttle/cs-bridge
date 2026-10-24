import { useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import type { SlurmDiscovery, HostRuntime } from '@/models';
import { partitionsForTab, hasTab, cpuOptions, memoryOptions, gpuOptions, resolvePick, type ResourceTab } from '@/ui/logic/cluster';
import { Row, Stack, Text, Spinner, Button, SingleSelect } from '@/ui/components/base';
import { post } from '@/ui/platform/vscode';
import { NO_ACCOUNT, gpuTypeOf } from '@/modules/slurmParse';

interface Props {
    alias: string;
    runtime: HostRuntime | undefined;
    validating?: boolean;
}

type Options = readonly (readonly [value: string, label: string])[];
const pairs = (values: string[]): Options => values.map(v => [v, v] as const);

const DEFAULT_WALL = '30';
const WALL_OPTIONS: Options = [
    [DEFAULT_WALL, '30 min'], ['60', '1 hour'], ['120', '2 hours'],
    ['240', '4 hours'], ['480', '8 hours'], ['720', '12 hours'], ['1440', '24 hours'],
];

function Select({ label, value, onChange, options, children }: { label: string; value: string; onChange: (v: string) => void; options?: Options; children?: ComponentChildren }) {
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
    const tabs = (['cpu', 'gpu'] as const).filter(t => hasTab(info, t));
    const initialTab = tabs[0] ?? 'cpu';

    const [tab, setTab] = useState<ResourceTab>(initialTab);
    const [partName, setPartName] = useState(partitionsForTab(info, initialTab)[0]?.name);
    const [account, setAccount] = useState(info.accounts[0] ?? NO_ACCOUNT);
    const [cpuPick, setCpu] = useState('');
    const [memoryPick, setMemory] = useState('');
    const [gpuCountPick, setGpuCount] = useState('');
    const [gpuTypePick, setGpuType] = useState('');
    const [wall, setWall] = useState(DEFAULT_WALL);

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
        setPartName(partitionsForTab(info, t)[0]?.name);
    };

    const submit = () => {
        if (!partition) { return; }
        const count = parseInt(gpuCount, 10) || 0;
        post({
            command: 'addSession',
            alias,
            partition: partition.name,
            account,
            rootFolder: info.homeDir,
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

            <Select label="Slurm account" value={account} onChange={setAccount} options={[[NO_ACCOUNT, '(no Slurm account)'], ...pairs(info.accounts)]} />
            <Select label="Partition" value={partition ? partition.name : NO_ACCOUNT} onChange={setPartName}>
                {parts.map(p => (
                    <option key={p.name} value={p.name}>
                        {p.name} ({p.cpuCount} CPUs{p.gres[0] ? `, ${p.gres[0].count} GPUs` : ''})
                    </option>
                ))}
            </Select>
            <Select label="CPUs" value={cpu} onChange={setCpu} options={pairs(cpus)} />
            <Select label="Memory" value={memory} onChange={setMemory} options={pairs(mems)} />
            {tab === 'gpu' && gpus.counts.length
                ? (
                        <>
                            <Select label="GPUs" value={gpuCount} onChange={setGpuCount} options={pairs(gpuCounts)} />
                            <Select label="GPU Type" value={gpuType} onChange={setGpuType} options={pairs(gpus.types)} />
                        </>
                    )
                : null}
            <Select label="Walltime" value={wall} onChange={setWall} options={WALL_OPTIONS} />
            <Button onClick={submit} disabled={validating || !partition}>
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
