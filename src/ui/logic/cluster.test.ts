import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SlurmDiscovery, SlurmPartitionInfo } from '@/models';
import { partitionsForTab, hasTab, cpuOptions, memoryOptions, gpuOptions, resolvePick } from './cluster';

const cpuPart: SlurmPartitionInfo = { name: 'cpu', cpuCount: 3, memoryMb: 8192, gres: [] };
const gpuPart: SlurmPartitionInfo = { name: 'gpu', cpuCount: 16, memoryMb: 0, gres: [{ name: 'a100', count: 2 }] };
const info: SlurmDiscovery = { alias: 'h', accounts: ['acct'], partitions: [cpuPart, gpuPart] };

test('partitionsForTab splits by presence of gres', () => {
    assert.deepEqual(partitionsForTab(info, 'cpu'), [cpuPart]);
    assert.deepEqual(partitionsForTab(info, 'gpu'), [gpuPart]);
    assert.equal(hasTab(info, 'gpu'), true);
    assert.equal(hasTab({ ...info, partitions: [cpuPart] }, 'gpu'), false);
});

test('cpuOptions lists 2..cpuCount (2-CPU floor)', () => {
    assert.deepEqual(cpuOptions(cpuPart), [2, 3]); // cpuCount 3
    assert.deepEqual(cpuOptions(undefined), []);
});

test('memoryOptions caps GB steps at the partition memory, falls back when unknown', () => {
    assert.deepEqual(memoryOptions(cpuPart), ['4 GB', '8 GB']); // 8192 MB → 8 GB; 4 GB floor (2 GB OOMs the VS Code server)
    assert.deepEqual(memoryOptions(gpuPart), ['4 GB', '8 GB', '16 GB', '32 GB', '64 GB', '128 GB']); // 0 → fallback
});

test('gpuOptions caps the count at what the chosen type offers', () => {
    const mixed: SlurmPartitionInfo = { name: 'mix', cpuCount: 16, memoryMb: 0, gres: [{ name: 'gpu:a100', count: 4 }, { name: 'gpu:v100', count: 2 }] };
    assert.deepEqual(gpuOptions(mixed, 'gpu', 'gpu:v100').counts, [1, 2]);
    assert.deepEqual(gpuOptions(mixed, 'gpu').counts, [1, 2, 3, 4]);
});

test('gpuOptions only yields counts/types on the gpu tab', () => {
    assert.deepEqual(gpuOptions(gpuPart, 'gpu'), { counts: [1, 2], types: ['a100'] });
    assert.deepEqual(gpuOptions(gpuPart, 'cpu'), { counts: [], types: [] });
    assert.deepEqual(gpuOptions(cpuPart, 'gpu'), { counts: [], types: [] });
});

// Switching partition used to require every dependent field to be reset by hand; deriving the value
// means a pick the new partition cannot honour simply falls back to its first option.
test('resolvePick keeps a pick the options still offer and falls back otherwise', () => {
    assert.equal(resolvePick('16', ['8', '16', '32'], '1'), '16');
    assert.equal(resolvePick('128', ['8', '16', '32'], '1'), '8', 'a pick the partition dropped falls back');
    assert.equal(resolvePick('', ['8', '16'], '1'), '8', 'no pick yet takes the first option');
    assert.equal(resolvePick('16', [], '1'), '1', 'a partition offering nothing uses the fallback');
});
