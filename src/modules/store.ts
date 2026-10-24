// Records live in extension storage through Files, a folder of JSON files. A JsonDir keeps a
// directory in memory, so reads are synchronous; writes, and reloads of other windows' writes that storage.ts's
// watcher reports, run in order behind them. A whole-record write wins over an earlier one; a patch lands its fields on
// whatever another window wrote last. schema.json versions the layout; the steps below 2 import ~/.cybershuttle.
import { parseJson } from './json';
import { getOrSet } from './util';

export interface Files {
    read(name: string): Promise<string | undefined>; // undefined when missing
    write(name: string, text: string): Promise<void>;
    remove(name: string): Promise<void>;
    list(dir: string): Promise<string[]>;
}

export class JsonDir<T extends object> {
    private readonly records = new Map<string, { value: T; text: string }>(); // text as last read or written
    private readonly unsaved = new Map<string, Promise<void>>(); // each record's last queued write, until it starts
    private readonly dirty = new Set<string>(); // records whose last write failed: memory is authoritative until one lands
    private readonly pending = new Map<string, Partial<T>>(); // fields patched since the record's last write began
    private readonly listeners = new Set<() => void>();
    private queue = Promise.resolve();

    constructor(
        private readonly files: Files,
        readonly dir: string,
        private readonly onError: (err: unknown) => void,
        private readonly merge: (cur: T | undefined, next: T) => T = (_, next) => next,
    ) { }

    async load(): Promise<void> {
        const names = (await this.files.list(this.dir)).filter(n => n.endsWith('.json'));
        await Promise.all(names.map(n => this.reload(n.slice(0, -'.json'.length))));
    }

    get(id: string): T | undefined { return this.records.get(id)?.value; }
    values(): T[] { return [...this.records.values()].map(r => r.value); }
    entries(): [string, T][] { return [...this.records].map(([id, r]) => [id, r.value]); }

    set(id: string, value: T): void {
        const text = JSON.stringify(value, null, 2);
        this.records.set(id, { value, text });
        this.pending.delete(id); // a whole-record write supersedes queued patches
        this.save(id, () => this.files.write(this.path(id), text));
        this.emit();
    }

    // A field write. The write carries every field patched since the last one began and lands on the record as
    // another window last wrote it: the fields that window changed since this one last read the file come in, unless
    // patched here since that read. A record deleted elsewhere stays deleted.
    patch(id: string, fields: Partial<T>): Promise<void> {
        const record = this.records.get(id);
        if (!record) { return this.queue; }
        Object.assign(record.value, fields);
        Object.assign(getOrSet(this.pending, id, () => ({})), fields);
        this.emit();
        return this.save(id, async () => {
            const queued = this.pending.get(id);
            this.pending.delete(id);
            const record = this.records.get(id);
            if (!queued || !record) { return; }
            await this.land(id, record, queued);
        });
    }

    private async land(id: string, record: { value: T; text: string }, queued: Partial<T>): Promise<void> {
        const text = this.dirty.has(id) ? record.text : await this.files.read(this.path(id));
        if (text === undefined) {
            this.records.delete(id);
            this.emit();
            return;
        }
        if (text !== record.text) {
            this.takeTheirs(record.value, parseJson<T>(text), parseJson<T>(record.text), { ...queued, ...this.pending.get(id) });
            this.emit();
        }
        record.text = JSON.stringify(record.value, null, 2);
        await this.files.write(this.path(id), record.text);
    }

    private takeTheirs(value: T, theirs: T, base: T, held: Partial<T>): void {
        for (const key of new Set([...Object.keys(theirs), ...Object.keys(base)])) {
            if (key in held) { continue; }
            const their = Reflect.get(theirs, key);
            if (JSON.stringify(their) === JSON.stringify(Reflect.get(base, key))) { continue; }
            if (their === undefined) { Reflect.deleteProperty(value, key); }
            else { Reflect.set(value, key, their); }
        }
    }

    delete(id: string): Promise<void> {
        if (!this.records.delete(id)) { return this.queue; }
        this.dirty.delete(id);
        this.emit();
        return this.save(id, () => this.files.remove(this.path(id)));
    }

    // Runs after this window's earlier writes land, so unchanged text is one of them; a record with a write still queued
    // waits for that write's event.
    reload(id: string): Promise<void> {
        return this.enqueue(async () => {
            const text = await this.files.read(this.path(id));
            const record = this.records.get(id);
            if (this.unsaved.has(id) || this.dirty.has(id) || text === record?.text) { return; }
            if (text === undefined) {
                this.records.delete(id);
            }
            else {
                this.records.set(id, { value: this.merge(record?.value, parseJson<T>(text)), text });
            }
            this.emit();
        });
    }

    onDidChange(listener: () => void): { dispose(): void } {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
    }

    private path(id: string) { return `${this.dir}/${id}.json`; }

    private save(id: string, op: () => Promise<void>): Promise<void> {
        const write: Promise<void> = this.enqueue(async () => {
            if (this.unsaved.get(id) === write) { this.unsaved.delete(id); }
            try { await op(); this.dirty.delete(id); }
            catch (err) { this.dirty.add(id); throw err; }
        });
        this.unsaved.set(id, write);
        return write;
    }

    private enqueue(op: () => Promise<void>): Promise<void> {
        return this.queue = this.queue.then(op).catch(this.onError);
    }

    private emit(): void { for (const listener of this.listeners) { listener(); } }
}

// A merge that keeps the object yet takes the record whole: a field the writer cleared is absent from its JSON.
export function replaceFields<T extends object>(cur: T, next: T): T {
    for (const key of Object.keys(cur)) { if (!(key in next)) { Reflect.deleteProperty(cur, key); } }
    return Object.assign(cur, next);
}

export type Steps = Record<number, () => Promise<void>>;

export const SCHEMA_VERSION = 3;

// steps[n] takes the store from version n to n + 1.
export async function migrate(files: Files, steps: Steps): Promise<void> {
    const schema = await files.read('schema.json');
    let version = schema ? parseJson<{ version: number }>(schema).version : 0;
    if (version > SCHEMA_VERSION) {
        throw new Error(`CS Bridge storage is at schema ${version}, newer than this CS Bridge reads (${SCHEMA_VERSION}); update CS Bridge.`);
    }
    for (; version < SCHEMA_VERSION; version++) {
        const step = steps[version];
        if (!step) { throw new Error(`CS Bridge has no migration from schema ${version}.`); }
        await step();
        await files.write('schema.json', JSON.stringify({ version: version + 1 }));
    }
}
