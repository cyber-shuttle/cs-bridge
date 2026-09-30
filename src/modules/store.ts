// Records live in extension storage through Files: a folder on desktop, IndexedDB in the browser. A JsonDir keeps a
// directory in memory, so reads are synchronous; writes, and reloads of other windows' writes that storage.ts's
// watcher reports, run in order behind them, and the last write to a record wins. schema.json versions the layout;
// desktop's steps below 2 import ~/.cybershuttle.

export interface Files {
    read(name: string): Promise<string | undefined>; // undefined when missing
    write(name: string, text: string): Promise<void>;
    remove(name: string): Promise<void>;
    list(dir: string): Promise<string[]>;
}

export class JsonDir<T> {
    private readonly items = new Map<string, T>();
    private readonly texts = new Map<string, string>(); // each record's text as last read or written
    private readonly unsaved = new Map<string, number>(); // this window's queued writes per record
    private readonly listeners = new Set<() => void>();
    private queue = Promise.resolve();

    constructor(
        private readonly files: Files,
        readonly dir: string,
        private readonly onError: (err: unknown) => void,
        private readonly merge: (cur: T | undefined, next: T) => T = (_, next) => next,
        private readonly persist: (value: T) => unknown = value => value, // the part of a record that is written
    ) { }

    async load(): Promise<void> {
        const names = (await this.files.list(this.dir)).filter(n => n.endsWith('.json'));
        await Promise.all(names.map(n => this.reload(n.slice(0, -'.json'.length))));
    }

    get(id: string): T | undefined { return this.items.get(id); }
    values(): T[] { return [...this.items.values()]; }
    entries(): [string, T][] { return [...this.items.entries()]; }

    set(id: string, value: T): void {
        const text = JSON.stringify(this.persist(value), null, 2);
        this.items.set(id, value);
        this.texts.set(id, text);
        this.save(id, () => this.files.write(this.path(id), text));
        this.emit();
    }

    delete(id: string): Promise<void> {
        if (!this.items.delete(id)) { return this.queue; }
        this.texts.delete(id);
        this.emit();
        return this.save(id, () => this.files.remove(this.path(id)));
    }

    // Runs after this window's earlier writes land, so unchanged text is one of them; a record with a write still queued
    // waits for that write's event, and text that does not parse is another window's write in progress.
    reload(id: string): Promise<void> {
        return this.enqueue(async () => {
            const text = await this.files.read(this.path(id));
            if (this.unsaved.get(id) || text === this.texts.get(id)) { return; }
            if (text === undefined) {
                this.texts.delete(id);
                this.items.delete(id);
            }
            else {
                let next: T;
                try { next = JSON.parse(text) as T; }
                catch { return; }
                this.texts.set(id, text);
                this.items.set(id, this.merge(this.items.get(id), next));
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
        this.unsaved.set(id, (this.unsaved.get(id) ?? 0) + 1);
        return this.enqueue(() => { this.unsaved.set(id, this.unsaved.get(id)! - 1); return op(); });
    }

    private enqueue(op: () => Promise<void>): Promise<void> {
        return this.queue = this.queue.then(op).catch(this.onError);
    }

    private emit(): void { for (const listener of this.listeners) { listener(); } }
}

export type Steps = Record<number, () => Promise<void>>;

export const SCHEMA_VERSION = 2;

// steps[n] takes the store from version n to n + 1.
export async function migrate(files: Files, steps: Steps): Promise<void> {
    let version = (JSON.parse(await files.read('schema.json') ?? '{}') as { version?: number }).version ?? 0;
    if (version > SCHEMA_VERSION) {
        throw new Error(`CS Bridge storage is at schema ${version}, newer than this CS Bridge reads (${SCHEMA_VERSION}); update CS Bridge.`);
    }
    for (; version < SCHEMA_VERSION; version++) {
        await steps[version]?.();
        await files.write('schema.json', JSON.stringify({ version: version + 1 }));
    }
}
