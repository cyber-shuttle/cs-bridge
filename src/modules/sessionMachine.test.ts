import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveStatus, observedEc2, isTerminal, isDeletable, isStoppable, isReachable, isWallTimeExpired } from './sessionMachine';
import { SlurmJobStatus } from '../models';

test('status-category predicates classify each status correctly', () => {
    assert.deepEqual((['stopped', 'failed'] as const).map(isTerminal), [true, true]);
    assert.equal(isTerminal('queued'), false);

    assert.equal(isDeletable('not_started'), true); // terminal + not_started
    assert.equal(isDeletable('stopped'), true);
    assert.equal(isDeletable('queued'), false);

    assert.equal(isStoppable('connected'), true); // can stop a live session
    assert.equal(isStoppable('queued'), true);
    assert.equal(isStoppable('stopped'), false); // already terminal
    assert.equal(isStoppable('not_started'), false); // nothing to stop yet
    assert.equal(isStoppable('stopping'), false); // a stop is already in flight

    assert.deepEqual((['ready_to_connect', 'connecting', 'connected'] as const).map(isReachable), [true, true, true]);
    assert.equal(isReachable('preparing'), false);

    // 'unreachable' is a recoverable, non-terminal, stoppable state — not reachable, not deletable.
    assert.equal(isTerminal('unreachable'), false);
    assert.equal(isStoppable('unreachable'), true);
    assert.equal(isReachable('unreachable'), false);
    assert.equal(isDeletable('unreachable'), false); // must Stop, not Delete
});

test('isWallTimeExpired: a started session past startedAt+walltime is expired; otherwise not', () => {
    // Slurm kills a job at its --time limit, so a passed deadline is authoritative even when sacct is unreachable.
    const wall = { cores: 2, memoryMb: 4096, wallMinutes: 30 }; // 1_800_000 ms
    assert.equal(isWallTimeExpired({ resources: wall, startedAt: 1_000 }, 1_000 + 1_800_000 + 1), true);
    assert.equal(isWallTimeExpired({ resources: wall, startedAt: 1_000 }, 1_000 + 1_800_000), true); // exactly at the deadline
    assert.equal(isWallTimeExpired({ resources: wall, startedAt: 1_000 }, 1_000 + 1_799_000), false); // a second short
    // Not yet running (no startedAt anchor): never expired — a pending/queued job has no deadline to enforce.
    assert.equal(isWallTimeExpired({ resources: wall, startedAt: undefined }, 9_999_999_999), false);
    // Zero walltime: nothing to expire against.
    assert.equal(isWallTimeExpired({ resources: { ...wall, wallMinutes: 0 }, startedAt: 1_000 }, 9_999_999_999), false);
});

const idle = { launching: false, connecting: false, connected: false, unreachable: false };
const facts = (over: Partial<Parameters<typeof deriveStatus>[0]> = {}) => ({
    desired: 'running' as const, jobId: '42', resources: { cores: 1, memoryMb: 1, wallMinutes: 60 }, ...over,
});
const reading = (state: SlurmJobStatus) => ({ observed: { state, at: 0 } });
const running = reading(SlurmJobStatus.RUNNING);
const ssh = { connectionInfo: { sshPort: 2222, controlPort: 20000 } };
const now = 1_000_000;

test('deriveStatus reaches every status from its facts', () => {
    assert.equal(deriveStatus(facts({ jobId: '' }), idle, now), 'not_started');
    assert.equal(deriveStatus(facts({ jobId: '' }), { ...idle, launching: true }, now), 'submitting');
    assert.equal(deriveStatus(facts(), idle, now), 'queued');
    assert.equal(deriveStatus(facts(reading(SlurmJobStatus.QUEUED)), idle, now), 'queued');
    assert.equal(deriveStatus(facts(running), idle, now), 'preparing');
    assert.equal(deriveStatus(facts({ ...running, ...ssh }), idle, now), 'ready_to_connect');
    assert.equal(deriveStatus(facts({ ...running, ...ssh }), { ...idle, connecting: true }, now), 'connecting');
    assert.equal(deriveStatus(facts({ ...running, ...ssh }), { ...idle, connected: true }, now), 'connected');
    assert.equal(deriveStatus(facts({ ...running, desired: 'stopped' }), idle, now), 'stopping');
    assert.equal(deriveStatus(facts({ ...reading(SlurmJobStatus.CANCELLED), desired: 'stopped' }), idle, now), 'stopped');
    assert.equal(deriveStatus(facts(reading(SlurmJobStatus.COMPLETED)), idle, now), 'stopped');
    assert.equal(deriveStatus(facts(reading(SlurmJobStatus.TIMEOUT)), idle, now), 'stopped');
    assert.equal(deriveStatus(facts(reading(SlurmJobStatus.OUT_OF_MEMORY)), idle, now), 'failed');
    assert.equal(deriveStatus(facts({ failure: 'sbatch refused' }), idle, now), 'failed');
    assert.equal(deriveStatus(facts(), { ...idle, unreachable: true }, now), 'unreachable');
});

test('deriveStatus: the races the stored status had to guard are impossible by construction', () => {
    // Walltime passed: the job is dead whatever sacct last said and whatever connection this window still holds.
    assert.equal(deriveStatus(facts({ ...running, ...ssh, startedAt: now - 61 * 60_000 }), { ...idle, connected: true }, now), 'stopped');
    // A stop in flight stays a stop while the reading still says RUNNING, and across a reload (no live connection).
    assert.equal(deriveStatus(facts({ ...running, ...ssh, desired: 'stopped' }), idle, now), 'stopping');
    // A reload drops the connection, so connected demotes to ready_to_connect on its own.
    assert.equal(deriveStatus(facts({ ...running, ...ssh }), idle, now), 'ready_to_connect');
    // Once the sshd is up a failed poll is a tunnel blip, never an unreachable session.
    assert.equal(deriveStatus(facts({ ...running, ...ssh }), { ...idle, unreachable: true }, now), 'ready_to_connect');
    // A failure verdict outranks everything, including a later RUNNING reading.
    assert.equal(deriveStatus(facts({ ...running, ...ssh, failure: 'scancel failed' }), { ...idle, connected: true }, now), 'failed');
});

test('observedEc2 maps instance states onto the Slurm vocabulary', () => {
    assert.deepEqual((['pending', 'running', 'stopping', 'stopped', 'terminated'] as const).map(observedEc2),
        [SlurmJobStatus.RUNNING, SlurmJobStatus.RUNNING, SlurmJobStatus.RUNNING, SlurmJobStatus.CANCELLED, SlurmJobStatus.FAILED]);
});
