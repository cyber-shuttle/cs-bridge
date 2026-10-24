export const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

export function getOrSet<K, V>(map: Map<K, V>, key: K, make: () => V): V {
    let value = map.get(key);
    if (value === undefined) { map.set(key, value = make()); }
    return value;
}

// The named groups of a match, once every one of them has matched.
export function groups<K extends string>(match: RegExpMatchArray | null, ...keys: K[]): Record<K, string> | undefined {
    const found = match?.groups;
    return found && keys.every(k => found[k] !== undefined) ? (found as Record<K, string>) : undefined;
}
