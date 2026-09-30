import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SlurmSession, ViewSession } from '@/models';
import { fmtTime, remainingMs, elapsedRunMs, elapsedLabel, dotColor, sessionActions } from './session';

test('fmtTime shows h+m above an hour, m+s below', () => {
    assert.equal(fmtTime(5_400_000), '1h 30m');
    assert.equal(fmtTime(45_000), '0m 45s');
    assert.equal(fmtTime(-10), '0m 0s'); // clamps negatives
});

test('elapsedLabel formats seconds-since, clamping a webview clock momentarily behind the timestamp to zero', () => {
    assert.equal(elapsedLabel(1_000, 6_000), '5s');
    assert.equal(elapsedLabel(1_000, 1_000), '0s');
    assert.equal(elapsedLabel(1_000, 126_000), '2m 5s'); // 125s
    assert.equal(elapsedLabel(1_000, 61_000), '1m 0s'); // exactly a minute
    assert.equal(elapsedLabel(5_000, 4_700), '0s'); // now 300ms behind submittedAt → never "-1s"
});

const hour = { cores: 2, memoryMb: 4096, wallMinutes: 60 };

test('remainingMs counts down from startedAt, else returns the full walltime', () => {
    assert.equal(remainingMs({ resources: hour, startedAt: 1_000 }, 1_000), 3_600_000);
    assert.equal(remainingMs({ resources: hour, startedAt: 1_000 }, 601_000), 3_000_000);
    assert.equal(remainingMs({ resources: hour, startedAt: undefined }, 999_999), 3_600_000);
});

test('elapsedRunMs is elapsed-since-start, capped at the wall limit, 0 before start', () => {
    assert.equal(elapsedRunMs({ resources: hour, startedAt: 1_000 }, 601_000), 600_000); // mid-run: 10 min in
    assert.equal(elapsedRunMs({ resources: hour, startedAt: 1_000 }, 99_999_999), 3_600_000); // past deadline → capped at the 1h limit
    assert.equal(elapsedRunMs({ resources: hour, startedAt: undefined }, 601_000), 0); // not started yet
    assert.equal(elapsedRunMs({ resources: { ...hour, wallMinutes: 0 }, startedAt: 1_000 }, 601_000), 600_000); // no limit → uncapped
    assert.equal(elapsedRunMs({ resources: hour, startedAt: 5_000 }, 4_000), 0); // clamps a clock momentarily behind startedAt
});

function sess(status: SlurmSession['status'], extra: Partial<ViewSession> = {}) {
    return { status, ...extra } as ViewSession;
}

test('dotColor: orange error, green live, grey otherwise', () => {
    assert.equal(dotColor('failed'), 'var(--vscode-charts-orange)');
    assert.equal(dotColor('unreachable'), 'var(--vscode-charts-orange)');
    assert.equal(dotColor('ready_to_connect'), 'var(--vscode-charts-green)');
    assert.equal(dotColor('connecting'), 'var(--vscode-charts-green)');
    assert.equal(dotColor('connected'), 'var(--vscode-charts-green)');
    for (const s of ['not_started', 'submitting', 'queued', 'preparing', 'stopping', 'stopped'] as const) {
        assert.equal(dotColor(s), 'var(--vscode-descriptionForeground)', `${s} should be grey`);
    }
});

test('sessionActions returns the right buttons per status', () => {
    assert.deepEqual(sessionActions(sess('not_started')).map(a => a.kind), ['start']);
    assert.deepEqual(sessionActions(sess('failed')).map(a => a.kind), ['start']);
    assert.deepEqual(sessionActions(sess('preparing')).map(a => a.kind), ['stop']);
    assert.deepEqual(sessionActions(sess('ready_to_connect')).map(a => a.kind), ['stop', 'connect']);
    assert.deepEqual(sessionActions(sess('unreachable')).map(a => a.kind), ['stop', 'connect']);
    assert.equal(sessionActions(sess('unreachable'))[1].label, 'Reconnect'); // Connect rebuilds the Dev Tunnel connection → off the SSH host
    assert.deepEqual(sessionActions(sess('stopped')), [{ kind: 'start', label: 'Start', icon: 'play' }]);
    assert.deepEqual(sessionActions(sess('stopping')).map(a => a.kind), []); // stop in flight: spinner only, no Stop button
});

test('connected session: Current when this window, else Switch/Connect by window liveness', () => {
    assert.deepEqual(sessionActions(sess('connected', { isCurrent: true })).map(a => a.kind), ['stop', 'current']);
    const switchBtn = sessionActions(sess('connected', { isCurrent: false, windowAlive: true }))[1];
    assert.equal(switchBtn.label, 'Switch');
    const connectBtn = sessionActions(sess('connected', { isCurrent: false, windowAlive: false }))[1];
    assert.equal(connectBtn.label, 'Connect');
    const openingBtn = sessionActions(sess('connected', { isCurrent: false, windowAlive: false, opening: true }))[1];
    assert.deepEqual([openingBtn.kind, openingBtn.label], ['opening', 'Opening…']);
    const connectingBtn = sessionActions(sess('connecting'))[1];
    assert.deepEqual([connectingBtn.kind, connectingBtn.label], ['opening', 'Connecting…']);
});
