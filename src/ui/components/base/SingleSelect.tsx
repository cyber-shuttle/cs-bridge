import type { ComponentChildren, CSSProperties } from 'preact';

export function SingleSelect({ value, onChange, style, children }: { value: string; onChange: (value: string) => void; style?: CSSProperties; children?: ComponentChildren }) {
    return <select class="cs-select" value={value} style={style} onChange={e => onChange(e.currentTarget.value)}>{children}</select>;
}
