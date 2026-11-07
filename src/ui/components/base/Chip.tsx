import type { CSSProperties } from 'preact';
import { Icon } from './Icon';

type ChipData = { label: string; background?: string; icon?: string };

const chipStyle: CSSProperties = { padding: '1px 6px', borderRadius: '4px', background: 'var(--vscode-keybindingLabel-background)', color: 'var(--vscode-keybindingLabel-foreground)', border: '1px solid var(--vscode-keybindingLabel-border)', fontSize: '11px', whiteSpace: 'nowrap' };

export function Chip({ label, background, icon }: ChipData) {
    return <span style={background ? { ...chipStyle, background, borderColor: background } : chipStyle}>{icon ? <Icon name={icon} size={11} style={{ verticalAlign: '-2px', marginRight: '3px' }} /> : null}{label}</span>;
}
