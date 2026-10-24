import type { ComponentChildren } from 'preact';
import { Stack } from './Stack';

export function Card({ border = 'var(--vscode-panel-border)', children }: { border?: string; children?: ComponentChildren }) {
    return (
        <Stack gap={3} style={{ border: `1px solid ${border}`, borderRadius: '6px', padding: '5px 8px', marginBottom: '5px' }}>
            {children}
        </Stack>
    );
}
