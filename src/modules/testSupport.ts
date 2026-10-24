import assert from 'node:assert/strict';

export const must = <T>(value: T | null | undefined): T => { assert.ok(value !== null && value !== undefined); return value; };
