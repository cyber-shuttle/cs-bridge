import * as vscode from 'vscode';

export const errMsg = (e: unknown): string => e instanceof Error ? e.message : String(e);

// Below Trace level the channel prints an Error as its message alone, so errors go in as their stacks.
const withStacks = (args: unknown[]) => args.map(a => a instanceof Error ? a.stack ?? a.message : a);

export class Logger {
    private static instance: Logger | undefined;
    private readonly channel = vscode.window.createOutputChannel('CS Bridge', { log: true });

    static getInstance(): Logger {
        return Logger.instance ??= new Logger();
    }

    info(message: string, ...args: unknown[]): void { this.channel.info(message, ...withStacks(args)); }
    warn(message: string, ...args: unknown[]): void { this.channel.warn(message, ...withStacks(args)); }
    error(message: string, ...args: unknown[]): void { this.channel.error(message, ...withStacks(args)); }

    dispose(): void {
        this.channel.dispose();
        Logger.instance = undefined;
    }
}
