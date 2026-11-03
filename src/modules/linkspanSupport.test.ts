import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSample } from './linkspanSupport';

test('parseSample drops null values', () => {
    assert.deepEqual(parseSample('{"memBytes":null,"cpuUsageUsec":5,"gpus":[{"index":0,"utilPct":null,"memUsedMiB":1}]}'),
        { cpuUsageUsec: 5, gpus: [{ index: 0, memUsedMiB: 1 }] });
    assert.throws(() => parseSample('null'));
});
