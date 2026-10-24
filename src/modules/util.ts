export const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

export function getOrSet<K, V>(map: Map<K, V>, key: K, make: () => V): V {
    let value = map.get(key);
    if (value === undefined) { map.set(key, value = make()); }
    return value;
}

// The named groups of a match, in the order asked for, once every one of them has matched.
export function groups(match: RegExpMatchArray | null, a: string): [string] | undefined;
export function groups(match: RegExpMatchArray | null, a: string, b: string): [string, string] | undefined;
export function groups(match: RegExpMatchArray | null, a: string, b: string, c: string, d: string): [string, string, string, string] | undefined;
export function groups(match: RegExpMatchArray | null, ...keys: string[]): string[] | undefined {
    const values = keys.map(k => match?.groups?.[k]);
    return values.every((v): v is string => v !== undefined) ? values : undefined;
}
