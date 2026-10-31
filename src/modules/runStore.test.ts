import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Run } from '../models';
import { mergeRun } from './runStore';
import { must } from './testSupport';

const run = (jobId: string, endedAt: number, over: Partial<Run> = {}): Run =>
    ({ sessionId: 's', alias: 'delta', jobId, account: '', partition: '', endedAt, finalState: 'stopped', wallMinutes: 30, samples: [], ...over });

test('mergeRun skips a run already recorded (same alias+jobId)', () => {
    assert.equal(mergeRun([run('1', 100)], run('1', 100)), null);
});

test('mergeRun inserts newest-first and caps at 10', () => {
    const existing = Array.from({ length: 10 }, (_, i) => run(`old${i}`, i + 1));
    const merged = must(mergeRun(existing, run('new', 999)));
    assert.equal(merged.length, 10);
    assert.equal(merged[0]?.jobId, 'new');
    assert.ok(!merged.some(r => r.jobId === 'old0')); // oldest dropped
});

test('mergeRun treats same jobId on a different SSH host as distinct', () => {
    assert.equal(must(mergeRun([run('1', 100, { alias: 'delta' })], run('1', 200, { alias: 'anvil' }))).length, 2);
});
