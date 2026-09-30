import type { SlurmDiscovery, SlurmPartitionInfo } from '@/models';

export type ResourceTab = 'cpu' | 'gpu';

interface GpuOptions {
    counts: number[];
    types: string[];
}

const hasGres = (p: SlurmPartitionInfo): boolean => !!p.gres && p.gres.length > 0;

export function partitionsForTab(info: SlurmDiscovery, tab: ResourceTab): SlurmPartitionInfo[] {
    return info.partitions.filter(p => (tab === 'gpu' ? hasGres(p) : !hasGres(p)));
}

export function hasTab(info: SlurmDiscovery, tab: ResourceTab): boolean {
    return partitionsForTab(info, tab).length > 0;
}

export function cpuOptions(partition: SlurmPartitionInfo | undefined): number[] {
    const max = Math.max(0, partition?.cpuCount ?? 0);
    // 2-CPU floor: a 1-CPU compute node is impractical for the VS Code server.
    return Array.from({ length: Math.max(0, max - 1) }, (_, i) => i + 2);
}

// 4 GB floor: 2 GB OOM-kills the VS Code remote server/extension host (observed on Delta: the 2 GB cgroup OOMs the ptyHost).
const MEM_STEPS = [4, 8, 16, 32, 64, 128, 256, 512, 1024];
const MEM_FALLBACK = [4, 8, 16, 32, 64, 128];

// Unknown (0) memory falls back to a fixed list of GB steps.
export function memoryOptions(partition: SlurmPartitionInfo | undefined): string[] {
    const maxGb = Math.floor((partition?.memoryMb ?? 0) / 1024);
    const valid = maxGb <= 0 ? MEM_FALLBACK : MEM_STEPS.filter(g => g <= maxGb);
    return (valid.length ? valid : [4]).map(g => `${g} GB`);
}

export function gpuOptions(partition: SlurmPartitionInfo | undefined, tab: ResourceTab, type = ''): GpuOptions {
    if (tab !== 'gpu' || !partition || !hasGres(partition)) { return { counts: [], types: [] }; }
    const max = (partition.gres.find(g => g.name === type) ?? partition.gres[0]).count;
    return {
        counts: Array.from({ length: max }, (_, i) => i + 1),
        types: partition.gres.map(g => g.name),
    };
}

// A field whose choices come from the selected partition keeps the user's pick only while that
// partition still offers it; otherwise the partition's own first option wins.
export function resolvePick(pick: string, options: string[], fallback: string): string {
    return options.includes(pick) ? pick : (options[0] ?? fallback);
}
