import type { SummaryState } from '../src/models';

export interface FakePanel {
    webview: { html: string; posted: { command: string; state: SummaryState }[] };
    dispose(): void;
    receive(message: unknown): void;
}
export const panels: FakePanel[];
