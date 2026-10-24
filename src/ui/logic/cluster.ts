import { nonEmpty, type NonEmpty, type SlurmDiscovery, type SlurmPartitionInfo } from '@/models';

type ResourceTab = 'cpu' | 'gpu';
export const tabOf = (p: SlurmPartitionInfo): ResourceTab => p.gres.length ? 'gpu' : 'cpu';

export const tabGroups = (info: SlurmDiscovery): { tab: ResourceTab; parts: NonEmpty<SlurmPartitionInfo> }[] =>
    (['cpu', 'gpu'] as const).flatMap((tab) => {
        const parts = info.partitions.filter(p => tabOf(p) === tab);
        return nonEmpty(parts) ? [{ tab, parts }] : [];
    });

const range = (from: number, to: number): NonEmpty<number> => [from, ...Array.from({ length: Math.max(0, to - from) }, (_, i) => from + 1 + i)];

// 2-CPU floor: a 1-CPU compute node is impractical for the VS Code server.
export const cpuOptions = (p: SlurmPartitionInfo): NonEmpty<number> => range(2, p.cpuCount);

// 4 GB floor: 2 GB OOM-kills the VS Code remote server/extension host (observed on Delta: the 2 GB cgroup OOMs the ptyHost).
// Unknown (0) memory takes the first six steps.
const MEM_STEPS = [4, 8, 16, 32, 64, 128, 256, 512, 1024];
export function memoryOptions(p: SlurmPartitionInfo): NonEmpty<number> {
    const maxGb = Math.floor(p.memoryMb / 1024);
    const fit = maxGb > 0 ? MEM_STEPS.filter(g => g <= maxGb) : MEM_STEPS.slice(0, 6);
    return nonEmpty(fit) ? fit : [4];
}

// The GPU choices of a partition that has any: its types, the chosen one, and 1..n for it.
export function gpuOptions(p: SlurmPartitionInfo, pick?: string): { types: NonEmpty<string>; type: string; counts: NonEmpty<number> } | undefined {
    if (!nonEmpty(p.gres)) { return undefined; }
    const gres = resolvePick(pick, p.gres, g => g.name);
    const [first, ...rest] = p.gres;
    return { types: [first.name, ...rest.map(g => g.name)], type: gres.name, counts: range(1, gres.count) };
}

// A pick the options still offer, else the first: switching partition needs no field reset by hand.
export function resolvePick<T>(pick: T | undefined, options: NonEmpty<T>): T;
export function resolvePick<T, K>(pick: K | undefined, options: NonEmpty<T>, key: (o: T) => K): T;
export function resolvePick<T>(pick: unknown, options: NonEmpty<T>, key: (o: T) => unknown = o => o): T {
    return options.find(o => key(o) === pick) ?? options[0];
}
