import type { SummaryState } from '../src/models';

export interface FakePanel {
    webview: { html: string; posted: { command: string; state: SummaryState }[] };
    dispose(): void;
    onDidDispose(listener: () => void): { dispose(): void };
    receive(message: unknown): void;
}
export const panels: FakePanel[];
export const quickPick: { minutes: number };
