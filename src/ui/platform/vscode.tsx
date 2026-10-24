import { render, type ComponentType } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { WebviewMessage } from '@/models';

declare function acquireVsCodeApi(): {
    postMessage(message: unknown): void;
    getState(): unknown;
    setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();

export const post = (msg: WebviewMessage) => vscode.postMessage(msg);

export function mount(Root: ComponentType): void {
    const root = document.getElementById('root');
    if (!root) { throw new Error('The webview shell has no #root.'); }
    render(<Root />, root);
}

// Posts `ready` once on mount, then re-renders on each `state` message the extension pushes.
export function useWebviewState<T>(): T | null {
    const [state, setState] = useState<T | null>(null);
    useEffect(() => {
        const onMsg = (e: MessageEvent) => {
            const msg = e.data as { command: 'state'; state: T };
            if (msg.command === 'state') { setState(msg.state); }
        };
        window.addEventListener('message', onMsg);
        post({ command: 'ready' });
        return () => window.removeEventListener('message', onMsg);
    }, []);
    return state;
}
