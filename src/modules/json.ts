// The one place text from a file, a secret or the wire becomes a typed value; T is the shape the writer documents.
export const parseJson = <T>(text: string, reviver?: (key: string, value: unknown) => unknown): T => JSON.parse(text, reviver);
