import { test } from 'node:test';
import assert from 'node:assert/strict';
import { persistableConnectionInfo, SessionConnectionInfo } from './models';

test('persistableConnectionInfo keeps the ports and drops secrets/volatile fields', () => {
    const full: SessionConnectionInfo = { sshPort: 40393, controlPort: 38157, localPort: 51000, connectToken: 'tok' };
    assert.deepEqual(persistableConnectionInfo(full), { sshPort: 40393, controlPort: 38157 });
});

test('persistableConnectionInfo returns undefined only when there is nothing to reattach to', () => {
    assert.equal(persistableConnectionInfo(undefined), undefined);
    assert.equal(persistableConnectionInfo({ sshPort: 0, controlPort: 0 }), undefined);
    const preparing = { sshPort: 0, controlPort: 25000 }; // no sshd yet, but a reload must keep the port
    assert.deepEqual(persistableConnectionInfo(preparing), preparing);
});
