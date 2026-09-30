import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeStatusTransition, isTerminal, isDeletable, isStoppable, isReachable, unreachableStatus, isWallTimeExpired } from './sessionMachine';
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

test('unreachableStatus downgrades only monitorable-offline statuses; never a reachable one', () => {
    for (const s of ['submitting', 'queued', 'preparing', 'unreachable'] as const) {
        assert.equal(unreachableStatus(s), 'unreachable', `${s} should become unreachable`);
    }
    // Never downgrade a reachable session for a monitoring-plane blip.
    for (const s of ['ready_to_connect', 'connecting', 'connected'] as const) {
        assert.equal(unreachableStatus(s), undefined, `${s} must not downgrade`);
    }
    // Terminal / not-yet-launched states are left alone.
    for (const s of ['stopped', 'failed', 'not_started', 'stopping'] as const) {
        assert.equal(unreachableStatus(s), undefined, `${s} must not downgrade`);
    }
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

test('unreachable status climbs back to preparing on a successful RUNNING poll', () => {
    assert.deepEqual(computeStatusTransition('unreachable', SlurmJobStatus.RUNNING), { next: 'preparing' });
    assert.deepEqual(computeStatusTransition('unreachable', SlurmJobStatus.QUEUED), { next: 'queued' });
});

test('RUNNING promotes a non-connect-phase session to preparing', () => {
    assert.deepEqual(computeStatusTransition('queued', SlurmJobStatus.RUNNING), { next: 'preparing' });
    assert.deepEqual(computeStatusTransition('submitting', SlurmJobStatus.RUNNING), { next: 'preparing' });
});

test('RUNNING does NOT pull a connect-phase session back to preparing', () => {
    for (const s of ['preparing', 'ready_to_connect', 'connected', 'connecting'] as const) {
        assert.deepEqual(computeStatusTransition(s, SlurmJobStatus.RUNNING), {}, `should not transition from ${s}`);
    }
});

test('terminal Slurm states stop monitoring with the right status', () => {
    // COMPLETED collapses into 'stopped', same as walltime/cancellation — the job is gone but the session can be started again.
    assert.deepEqual(computeStatusTransition('preparing', SlurmJobStatus.COMPLETED), { next: 'stopped', stopMonitoring: true });
    assert.deepEqual(computeStatusTransition('preparing', SlurmJobStatus.CANCELLED), { next: 'stopped', stopMonitoring: true });
    assert.deepEqual(computeStatusTransition('connected', SlurmJobStatus.TIMEOUT), { next: 'stopped', stopMonitoring: true });
});

test('failure states stop monitoring and carry an error message', () => {
    for (const s of [SlurmJobStatus.FAILED, SlurmJobStatus.OUT_OF_MEMORY]) {
        const t = computeStatusTransition('preparing', s);
        assert.equal(t.next, 'failed');
        assert.equal(t.stopMonitoring, true);
        assert.match(t.error ?? '', new RegExp(`Job ended with status: ${s}`));
    }
});

test('QUEUED maps to queued without stopping monitoring', () => {
    assert.deepEqual(computeStatusTransition('submitting', SlurmJobStatus.QUEUED), { next: 'queued' });
});

test('UNKNOWN holds (never terminalizes) — a transient/unrecognized sacct state is not job death', () => {
    assert.deepEqual(computeStatusTransition('preparing', SlurmJobStatus.UNKNOWN), {});
    assert.deepEqual(computeStatusTransition('connected', SlurmJobStatus.UNKNOWN), {});
});

test('a stopping session is never resurrected: RUNNING/QUEUED hold, only a terminal state finishes it', () => {
    assert.deepEqual(computeStatusTransition('stopping', SlurmJobStatus.RUNNING), {});
    assert.deepEqual(computeStatusTransition('stopping', SlurmJobStatus.QUEUED), {});
    assert.deepEqual(computeStatusTransition('stopping', SlurmJobStatus.UNKNOWN), {});
    assert.deepEqual(computeStatusTransition('stopping', SlurmJobStatus.CANCELLED), { next: 'stopped', stopMonitoring: true });
    assert.deepEqual(computeStatusTransition('stopping', SlurmJobStatus.COMPLETED), { next: 'stopped', stopMonitoring: true });
});
