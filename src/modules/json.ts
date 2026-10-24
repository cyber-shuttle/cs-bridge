// The one place text from a file, a secret or the wire becomes a typed value; T is the shape the writer documents.
export const parseJson = <T>(text: string): T => JSON.parse(text);
