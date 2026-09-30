import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    includeIsEffective,
    parseHostsFromConfigText,
    addHostToConfigText,
    deleteHostFromConfigText,
    editHostInConfigText,
    mergeHostsByPriority,
    buildSshConfigBlock,
    csHostAlias,
    SSH_RESILIENCE_OPTIONS,
} from './sshHostsStore';

test('csHostAlias is <alias>-<last 6 chars of the session name>', () => {
    assert.equal(csHostAlias({ alias: 'delta', name: '1782444493119' }), 'delta-493119');
    assert.equal(csHostAlias({ alias: 'delta', name: 'abc' }), 'delta-abc'); // shorter than 6: whole name
});

test('parseHostsFromConfigText reads Host/HostName/User and skips wildcards', () => {
    const text = 'Host work\n  HostName work.example.com\n  User alice\n\nHost *\n  ServerAliveInterval 60\n';
    assert.deepEqual(parseHostsFromConfigText(text), [{ alias: 'work', hostname: 'work.example.com', user: 'alice' }]);
});

test('parseHostsFromConfigText captures extra directives', () => {
    const text = 'Host gpu\n  HostName gpu.example.com\n  User bob\n  Port 2222\n  ForwardAgent yes\n';
    assert.deepEqual(parseHostsFromConfigText(text), [
        { alias: 'gpu', hostname: 'gpu.example.com', user: 'bob', extraDirectives: ['Port 2222', 'ForwardAgent yes'] },
    ]);
});

test('parseHostsFromConfigText flattens multi-token directives instead of emitting [object Object]', () => {
    const text = 'Host bastioned\n  HostName internal.example.com\n  User carol\n  ProxyCommand ssh -W %h:%p bastion\n  SendEnv LANG LC_*\n';
    assert.deepEqual(parseHostsFromConfigText(text), [
        { alias: 'bastioned', hostname: 'internal.example.com', user: 'carol', extraDirectives: ['ProxyCommand ssh -W %h:%p bastion', 'SendEnv LANG LC_*'] },
    ]);
});

test('addHostToConfigText adds an entry that round-trips', () => {
    const text = addHostToConfigText('', { Host: 'h', HostName: 'h', User: 'a' });
    assert.deepEqual(parseHostsFromConfigText(text), [{ alias: 'h', hostname: 'h', user: 'a' }]);
});

test('addHostToConfigText replaces an existing alias instead of duplicating', () => {
    const t1 = addHostToConfigText('', { Host: 'h', HostName: 'h1', User: 'a' });
    const t2 = addHostToConfigText(t1, { Host: 'h', HostName: 'h2', User: 'b' });
    assert.deepEqual(parseHostsFromConfigText(t2), [{ alias: 'h', hostname: 'h2', user: 'b' }]);
});

test('addHostToConfigText prepends newest above existing', () => {
    const base = addHostToConfigText('', { Host: 'first', HostName: 'f' });
    const both = addHostToConfigText(base, { Host: 'second', HostName: 's' });
    assert.deepEqual(parseHostsFromConfigText(both).map(h => h.alias), ['second', 'first']);
});

test('deleteHostFromConfigText deletes the named entry', () => {
    const text = addHostToConfigText('', { Host: 'h', HostName: 'h' });
    assert.deepEqual(parseHostsFromConfigText(deleteHostFromConfigText(text, 'h')), []);
});

test('editHostInConfigText rewrites alias, hostname and user in place, keeping the rest of the block', () => {
    const text = '# lab\nHost d\n    HostName old\n    User a\n    ForwardAgent yes\n\nHost other\n    HostName o\n';
    assert.equal(editHostInConfigText(text, 'd', { Host: 'd2', HostName: 'new' }), '# lab\nHost d2\n    HostName new\n    ForwardAgent yes\n\nHost other\n    HostName o\n');
    assert.throws(() => editHostInConfigText(text, 'd', { Host: 'other', HostName: 'o' }), /already exists/);
});

test('buildSshConfigBlock emits the six SSH resilience options', () => {
    const block = buildSshConfigBlock('sess1', csHostAlias({ alias: 'delta', name: 'sess1-493119' }), '127.0.0.1', 50122, 'cs-ssh-user', '/keys/id_cshost-sess1');
    assert.equal(SSH_RESILIENCE_OPTIONS.length, 6);
    for (const [key, value] of SSH_RESILIENCE_OPTIONS) {
        assert.match(block, new RegExp(`^    ${key} ${value}$`, 'm'));
    }
    assert.match(block, /^# CS-Bridge auto-generated for session sess1$/m);
    assert.match(block, /^Host delta-493119$/m);
    assert.match(block, /^ {4}Port 50122$/m);
    assert.match(block, /^ {4}IdentityFile \/keys\/id_cshost-sess1$/m);
});

// deleteSshConfigEntry's removal regex only matches 4-space-indented directive lines.
test('buildSshConfigBlock indents every directive so deleteSshConfigEntry can remove it', () => {
    const block = buildSshConfigBlock('s', csHostAlias({ alias: 'delta', name: 'abc123' }), '127.0.0.1', 22, 'u', '/k');
    for (const line of block.split('\n')) {
        if (line === '' || line.startsWith('#') || line.startsWith('Host ')) { continue; }
        assert.match(line, /^ {4}\S/);
    }
});

test('mergeHostsByPriority keeps the first occurrence of each alias (user wins over system)', () => {
    const user = [{ alias: 'a', source: 'user' as const }, { alias: 'b', hostname: 'user-b', source: 'user' as const }];
    const system = [{ alias: 'b', hostname: 'system-b', source: 'system' as const }, { alias: 'c', source: 'system' as const }];
    const merged = mergeHostsByPriority(user, system);
    assert.deepEqual(merged.map(h => h.alias), ['a', 'b', 'c']);
    assert.equal(merged.find(h => h.alias === 'b')?.hostname, 'user-b');
    assert.equal(merged.find(h => h.alias === 'b')?.source, 'user');
});

test('includeIsEffective accepts only an uncommented Include above the first Host/Match block', () => {
    const line = 'Include ~/.cybershuttle/ssh_config';
    assert.equal(includeIsEffective('', line), false);
    assert.equal(includeIsEffective(`${line}\nHost foo\n    HostName x\n`, line), true);
    assert.equal(includeIsEffective(`  ${line}  \n`, line), true, 'surrounding whitespace is not significant');
    assert.equal(includeIsEffective(`# ${line}\n`, line), false, 'a commented Include does nothing');
    assert.equal(includeIsEffective(`Host *\n    ${line}\n`, line), false, 'scoped to a Host block, not global');
    assert.equal(includeIsEffective(`Match host bar\n    ${line}\n`, line), false, 'scoped to a Match block');
});
