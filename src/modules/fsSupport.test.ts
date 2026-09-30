import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { lockedUpdateTextFile } from './fsSupport';

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fss-')), 'store.json');

test('lockedUpdateTextFile: missing → undefined, RMW appends, null skips (no file created), atomic', () => {
    const f = tmpFile();
    lockedUpdateTextFile(f, cur => (cur === undefined ? null : cur + 'x')); // missing → null → no write
    assert.equal(fs.existsSync(f), false);
    lockedUpdateTextFile(f, cur => (cur ?? '') + 'a');
    lockedUpdateTextFile(f, cur => (cur ?? '') + 'b');
    assert.equal(fs.readFileSync(f, 'utf-8'), 'ab'); // transform saw the prior text
    assert.equal(fs.existsSync(`${f}.tmp`), false);
});
