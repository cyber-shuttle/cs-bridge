import { useState } from 'preact/hooks';
import type { SlurmDiscovery, SlurmPartitionInfo, HostRuntime, NonEmpty } from '@/models';
import { tabGroups, tabOf, cpuOptions, memoryOptions, gpuOptions, resolvePick } from '@/ui/logic/cluster';
import { Row, Stack, Text, Spinner, Button, SingleSelect } from '@/ui/components/base';
import { post } from '@/ui/platform/vscode';
import { NO_ACCOUNT, gpuTypeOf } from '@/modules/slurmParse';

interface Props {
    alias: string;
    runtime: HostRuntime | undefined;
    validating: boolean;
}

const WALL_MINUTES: NonEmpty<number> = [30, 60, 120, 240, 480, 720, 1440];
const wallLabel = (m: number) => (m < 60 ? `${m} min` : m === 60 ? '1 hour' : `${m / 60} hours`);
const partitionLabel = (p: SlurmPartitionInfo) => `${p.name} (${p.cpuCount} CPUs${p.gres[0] ? `, ${p.gres[0].count} GPUs` : ''})`;

// Options are keyed by `id` because the state the form derives from is re-sent on every render.
function Choice<T>({ label, value, options, onChange, show = String, id = String }: { label: string; value: T; options: readonly T[]; onChange: (o: T) => void; show?: (o: T) => string; id?: (o: T) => string }) {
    return (
        <Stack gap={2}>
            <Text weight={600} size={12}>{label}</Text>
            <SingleSelect value={id(value)} style={{ width: '100%', maxWidth: 'none' }} onChange={(v) => { const o = options.find(o => id(o) === v); if (o !== undefined) { onChange(o); } }}>
                {options.map(o => <option key={id(o)} value={id(o)}>{show(o)}</option>)}
            </SingleSelect>
        </Stack>
    );
}

function HostFormFields({ alias, info, validating }: { alias: string; info: SlurmDiscovery; validating: boolean }) {
    const groups = tabGroups(info);
    const accounts: NonEmpty<string> = [NO_ACCOUNT, ...info.accounts];
    const [partName, setPartName] = useState(info.partitions[0].name);
    const [account, setAccount] = useState(info.accounts[0] ?? NO_ACCOUNT);
    const [cpuPick, setCpu] = useState<number>();
    const [memPick, setMem] = useState<number>();
    const [gpuCountPick, setGpuCount] = useState<number>();
    const [gpuTypePick, setGpuType] = useState<string>();
    const [wall, setWall] = useState(WALL_MINUTES[0]);

    const partition = resolvePick(partName, info.partitions, p => p.name);
    const tab = tabOf(partition);
    const cpu = resolvePick(cpuPick, cpuOptions(partition));
    const memGb = resolvePick(memPick, memoryOptions(partition));
    const gpu = gpuOptions(partition, gpuTypePick);
    const gpuCount = gpu ? resolvePick(gpuCountPick, gpu.counts) : 0;

    const submit = () => post({
        command: 'addSession', alias, partition: partition.name, account, rootFolder: info.homeDir,
        resources: { cores: cpu, memoryMb: memGb * 1024, wallMinutes: wall, ...gpu && { gpuType: gpuTypeOf(gpu.type), gpuCount } },
    });

    return (
        <Stack gap={4}>
            {groups.length > 1 && (
                <Row gap={4}>
                    {groups.map(g => (
                        <Button key={g.tab} style={{ flex: 1 }} secondary={g.tab !== tab || undefined} onClick={() => setPartName(g.parts[0].name)}>{g.tab.toUpperCase()}</Button>
                    ))}
                </Row>
            )}
            <Choice label="Slurm account" value={account} options={accounts} onChange={setAccount} show={a => (a === NO_ACCOUNT ? '(no Slurm account)' : a)} />
            <Choice label="Partition" value={partition} options={info.partitions.filter(p => tabOf(p) === tab)} id={p => p.name} show={partitionLabel} onChange={p => setPartName(p.name)} />
            <Choice label="CPUs" value={cpu} options={cpuOptions(partition)} onChange={setCpu} />
            <Choice label="Memory" value={memGb} options={memoryOptions(partition)} onChange={setMem} show={gb => `${gb} GB`} />
            {gpu && (
                <>
                    <Choice label="GPUs" value={gpuCount} options={gpu.counts} onChange={setGpuCount} />
                    <Choice label="GPU Type" value={gpu.type} options={gpu.types} onChange={setGpuType} />
                </>
            )}
            <Choice label="Walltime" value={wall} options={WALL_MINUTES} onChange={setWall} show={wallLabel} />
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
