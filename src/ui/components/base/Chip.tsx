import type { CSSProperties } from 'preact';

type ChipData = { label: string; background?: string };

const chipStyle: CSSProperties = { padding: '1px 6px', borderRadius: '4px', background: 'var(--vscode-keybindingLabel-background)', color: 'var(--vscode-keybindingLabel-foreground)', border: '1px solid var(--vscode-keybindingLabel-border)', fontSize: '11px', whiteSpace: 'nowrap' };

export function Chip({ label, background }: ChipData) {
    return <span style={background ? { ...chipStyle, background, borderColor: background } : chipStyle}>{label}</span>;
}
