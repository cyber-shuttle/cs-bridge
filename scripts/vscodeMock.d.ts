export interface FakePanel {
    webview: { html: string; posted: { command: string; state: unknown }[] };
    dispose(): void;
    receive(message: unknown): void;
}
export const panels: FakePanel[];
