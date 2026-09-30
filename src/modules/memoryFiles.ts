import { Files } from './store';

// Files in memory, for tests.
export function memoryFiles(): Files & { texts: Map<string, string> } {
    const texts = new Map<string, string>();
    return {
        texts,
        read: async name => texts.get(name),
        write: async (name, text) => { texts.set(name, text); },
        remove: async (name) => { texts.delete(name); },
        list: async dir => [...texts.keys()].filter(n => n.startsWith(`${dir}/`)).map(n => n.slice(dir.length + 1)),
    };
}
