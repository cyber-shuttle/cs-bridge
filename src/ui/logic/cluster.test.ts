import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SlurmDiscovery, SlurmPartitionInfo } from '@/models';
import { tabGroups, cpuOptions, memoryOptions, gpuOptions, resolvePick } from './cluster';

const cpuPart: SlurmPartitionInfo = { name: 'cpu', cpuCount: 3, memoryMb: 8192, gres: [] };
const gpuPart: SlurmPartitionInfo = { name: 'gpu', cpuCount: 16, memoryMb: 0, gres: [{ name: 'a100', count: 2 }] };
const info: SlurmDiscovery = { alias: 'h', accounts: ['acct'], partitions: [cpuPart, gpuPart], homeDir: '/home/u' };

test('tabGroups splits by presence of gres and omits an empty tab', () => {
    assert.deepEqual(tabGroups(info), [{ tab: 'cpu', parts: [cpuPart] }, { tab: 'gpu', parts: [gpuPart] }]);
    assert.deepEqual(tabGroups({ ...info, partitions: [cpuPart] }), [{ tab: 'cpu', parts: [cpuPart] }]);
});

test('cpuOptions lists 2..cpuCount (2-CPU floor)', () => {
    assert.deepEqual(cpuOptions(cpuPart), [2, 3]); // cpuCount 3
    assert.deepEqual(cpuOptions({ ...cpuPart, cpuCount: 1 }), [2]);
});

test('memoryOptions caps GB steps at the partition memory, falls back when unknown', () => {
    assert.deepEqual(memoryOptions(cpuPart), [4, 8]); // 8192 MB → 8 GB; 4 GB floor (2 GB OOMs the VS Code server)
    assert.deepEqual(memoryOptions(gpuPart), [4, 8, 16, 32, 64, 128]); // 0 → fallback
    assert.deepEqual(memoryOptions({ ...cpuPart, memoryMb: 2048 }), [4]);
});

test('gpuOptions caps the count at what the chosen type offers', () => {
    const mixed: SlurmPartitionInfo = { name: 'mix', cpuCount: 16, memoryMb: 0, gres: [{ name: 'gpu:a100', count: 4 }, { name: 'gpu:v100', count: 2 }] };
    assert.deepEqual(gpuOptions(mixed, 'gpu:v100'), { types: ['gpu:a100', 'gpu:v100'], type: 'gpu:v100', counts: [1, 2] });
    assert.deepEqual(gpuOptions(mixed)?.counts, [1, 2, 3, 4]);
    assert.equal(gpuOptions(cpuPart), undefined);
});

test('resolvePick keeps a pick the options still offer and falls back otherwise', () => {
    assert.equal(resolvePick(16, [8, 16, 32]), 16);
    assert.equal(resolvePick(128, [8, 16, 32]), 8, 'a pick the partition dropped falls back');
    assert.equal(resolvePick(undefined, [8, 16]), 8, 'no pick yet takes the first option');
    assert.equal(resolvePick('gpu', [cpuPart, gpuPart], p => p.name), gpuPart);
});
