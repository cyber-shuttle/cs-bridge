export const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

export function getOrSet<K, V>(map: Map<K, V>, key: K, make: () => V): V {
    let value = map.get(key);
    if (value === undefined) { map.set(key, value = make()); }
    return value;
}
