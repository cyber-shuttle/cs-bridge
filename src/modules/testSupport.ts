import assert from 'node:assert/strict';
import type { SessionResponse, SessionRun } from '../models';

export const must = <T>(value: T | null | undefined): T => { assert.ok(value !== null && value !== undefined); return value; };

export function planeResponse(over: Partial<SessionResponse> = {}, run: Partial<SessionRun> = {}): SessionResponse {
    const r: SessionRun = { processId: 'p1', controlPort: 21234, state: 'RUNNING', startedAt: 1790000060000, deadline: 1790003660000, endedAt: null, error: null, ...run };
    return { sessionId: 's1', createdAt: 1790000000123, slurmClusterConfigId: 'k1aaaaaaaa', deploymentId: 'd1', account: 'lab-alloc', partition: 'cpu',
        resources: { cores: 2, memoryMb: 4096, wallMinutes: 60 }, state: r.state, live: !['COMPLETED', 'FAILED', 'CANCELLED'].includes(r.state), runs: [r], ...over };
}
