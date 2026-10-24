import assert from 'node:assert/strict';

export const must = <T>(value: T | undefined): T => { assert.ok(value !== undefined); return value; };
