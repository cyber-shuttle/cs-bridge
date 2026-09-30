import type { CSSProperties } from 'preact';
import { px } from '.';

export function Icon({ name, title, size, spin, style }: { name: string; title?: string; size?: number; spin?: boolean; style?: CSSProperties }) {
    return <span class={`codicon codicon-${name}${spin ? ' codicon-modifier-spin' : ''}`} title={title} style={{ fontSize: px(size), ...style }} />;
}
