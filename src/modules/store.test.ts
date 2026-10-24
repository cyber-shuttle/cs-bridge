import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JsonDir, replaceFields } from './store';
import { memoryFiles } from './memoryFiles';

interface Rec { n: number; m?: number; k?: number }

test('JsonDir skips its own writes and merges another window\'s in place', async () => {
    const files = memoryFiles();
    await files.write('recs/a.json', JSON.stringify({ n: 1 }));
    let changes = 0;
    const dir = new JsonDir<Rec>(files, 'recs', err => assert.fail(String(err)), (cur, next) => (cur ? Object.assign(cur, next) : next));
    await dir.load();
    dir.onDidChange(() => changes++);
    const a = dir.get('a')!;
    assert.deepEqual(a, { n: 1 });

    a.m = 7;
    dir.set('a', a);
    await dir.reload('a'); // this window's own write, read back once it lands
    assert.deepEqual(JSON.parse(files.texts.get('recs/a.json')!), { n: 1, m: 7 });
    assert.equal(changes, 1);

    await files.write('recs/a.json', JSON.stringify({ n: 2 })); // another window
    await dir.reload('a');
    assert.equal(dir.get('a'), a); // same object, as the monitor holds it
    assert.deepEqual(a, { n: 2, m: 7 }); // Object.assign here; extensionStore's merge drops cleared fields
    assert.equal(changes, 2);

    await files.write('recs/a.json', '{"n": 3'); // read mid-write
    await dir.reload('a');
    assert.equal(a.n, 2);

    await files.remove('recs/a.json');
    await dir.reload('a');
    assert.equal(dir.get('a'), undefined);
    assert.equal(changes, 3);
});

test('JsonDir.patch lands its fields on another window\'s newer record and tells listeners', async () => {
    const files = memoryFiles();
    await files.write('recs/a.json', JSON.stringify({ n: 1 }));
    const dir = new JsonDir<Rec>(files, 'recs', err => assert.fail(String(err)), (cur, next) => (cur ? replaceFields(cur, next) : next));
    await dir.load();
    let changes = 0;
    dir.onDidChange(() => changes++);
    await files.write('recs/a.json', JSON.stringify({ n: 2 })); // another window, not yet reloaded here
    dir.patch('a', { m: 7 });
    dir.patch('a', { k: 9 }); // queued while the first write reads the file
    await dir.reload('a');
    assert.deepEqual(JSON.parse(files.texts.get('recs/a.json')!), { n: 2, m: 7, k: 9 });
    assert.deepEqual(dir.get('a'), { n: 2, m: 7, k: 9 });
    assert.equal(changes, 3);

    await files.write('recs/a.json', '{"n": 3'); // another window mid-write
    dir.patch('a', { m: 8 });
    await dir.reload('a');
    assert.deepEqual(JSON.parse(files.texts.get('recs/a.json')!), { n: 2, m: 8, k: 9 });

    await files.write('recs/a.json', JSON.stringify({ n: 2, m: 99, k: 9 })); // another window's newer m
    await dir.patch('a', { k: 10 });
    assert.deepEqual(JSON.parse(files.texts.get('recs/a.json')!), { n: 2, m: 99, k: 10 }, 'a field written earlier is not put back');

    await files.remove('recs/a.json'); // another window deleted it
    await dir.patch('a', { k: 11 });
    assert.equal(files.texts.get('recs/a.json'), undefined);
    assert.equal(dir.get('a'), undefined);
});

test('replaceFields drops a field the other window cleared', () => {
    const cur: Rec = { n: 1, m: 7 };
    assert.equal(replaceFields(cur, { n: 2 }), cur);
    assert.deepEqual(cur, { n: 2 });
});

test('JsonDir keeps another window\'s write that lands just after its own', async () => {
    const files = memoryFiles();
    const write = files.write;
    files.write = async (name, text) => { await write(name, text); files.texts.set(name, JSON.stringify({ n: 2 })); };
    const dir = new JsonDir<Rec>(files, 'recs', err => assert.fail(String(err)));
    dir.set('a', { n: 1 });
    await dir.reload('a'); // another window's event, arriving mid-write
    assert.deepEqual(dir.get('a'), { n: 2 });
});

test('JsonDir keeps its own write made while a reload reads', async () => {
    const files = memoryFiles();
    await files.write('recs/a.json', JSON.stringify({ n: 1 }));
    const dir = new JsonDir<Rec>(files, 'recs', err => assert.fail(String(err)));
    await dir.load();
    const read = files.read;
    files.read = (name) => { dir.set('a', { n: 2 }); return read(name); };
    await dir.reload('a');
    assert.deepEqual(dir.get('a'), { n: 2 });
});

test('JsonDir.patch keeps a field patched while its write reads the file', async () => {
    const files = memoryFiles();
    await files.write('recs/a.json', JSON.stringify({ n: 1 }));
    const dir = new JsonDir<Rec>(files, 'recs', err => assert.fail(String(err)), (cur, next) => (cur ? replaceFields(cur, next) : next));
    await dir.load();
    const slow = files.read;
    files.read = async (name) => { await new Promise(res => setTimeout(res, 20)); return slow(name); };
    await files.write('recs/a.json', JSON.stringify({ n: 1, m: 9 })); // another window's m
    const first = dir.patch('a', { k: 1 });
    await new Promise(res => setTimeout(res, 5));
    dir.patch('a', { m: 5 }); // while the first write reads
    await first;
    await dir.reload('a');
    assert.deepEqual(dir.get('a'), { n: 1, m: 5, k: 1 });
    assert.deepEqual(JSON.parse(files.texts.get('recs/a.json')!), { n: 1, m: 5, k: 1 });
});
