declare module 'websocket' {
    import type { Server } from 'node:http';

    export const w3cwebsocket: typeof globalThis.WebSocket;

    interface Connection {
        sendBytes(data: Buffer): void;
        close(): void;
        on(event: 'message', listener: (message: { binaryData?: Buffer }) => void): void;
        on(event: 'close', listener: () => void): void;
    }

    export class server {
        constructor(options: { httpServer: Server });
        on(event: 'request', listener: (request: { requestedProtocols: string[]; accept(protocol: string, origin?: string): Connection }) => void): void;
        shutDown(): void;
    }
}
