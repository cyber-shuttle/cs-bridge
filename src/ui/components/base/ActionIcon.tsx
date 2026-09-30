import { px } from '.';

export function ActionIcon({ name, title, ariaLabel, size, onClick }: { name: string; title?: string; ariaLabel?: string; size?: number; onClick?: (e: Event) => void }) {
    return <button class={`cs-action codicon codicon-${name}`} title={title} aria-label={ariaLabel} style={{ marginLeft: 'auto', fontSize: px(size) }} onClick={onClick} />;
}
