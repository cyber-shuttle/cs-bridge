import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JsonDir } from './store';
import { memoryFiles } from './memoryFiles';

interface Rec { n: number; live?: string }

test('JsonDir writes the persisted part, skips its own writes and merges another window\'s in place', async () => {
    const files = memoryFiles();
    await files.write('recs/a.json', JSON.stringify({ n: 1 }));
    let changes = 0;
    const dir = new JsonDir<Rec>(files, 'recs', err => assert.fail(String(err)),
        (cur, next) => (cur ? Object.assign(cur, next, { live: cur.live }) : next), ({ live: _, ...rest }) => rest);
    await dir.load();
    dir.onDidChange(() => changes++);
    const a = dir.get('a')!;
    assert.deepEqual(a, { n: 1 });

    a.live = 'port';
    dir.set('a', a);
    await dir.reload('a'); // this window's own write, read back once it lands
    assert.deepEqual(JSON.parse(files.texts.get('recs/a.json')!), { n: 1 }); // live stays in memory
    assert.equal(changes, 1);

    await files.write('recs/a.json', JSON.stringify({ n: 2 })); // another window
    await dir.reload('a');
    assert.equal(dir.get('a'), a); // same object, as the monitor holds it
    assert.deepEqual(a, { n: 2, live: 'port' });
    assert.equal(changes, 2);

    await files.write('recs/a.json', '{"n": 3'); // read mid-write
    await dir.reload('a');
    assert.equal(a.n, 2);

    await files.remove('recs/a.json');
    await dir.reload('a');
    assert.equal(dir.get('a'), undefined);
    assert.equal(changes, 3);
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
