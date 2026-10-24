import { sparklinePoints } from '@/ui/logic/sparkline';
import { SAMPLE_HISTORY_LEN } from '@/models';

export interface SparkLine { values: number[]; color: string; domain?: [number, number] }

// Native SVG (no chart dep); 1px inset so the stroke isn't clipped.
export function Sparkline({ lines, title }: { lines: SparkLine[]; title: string }) {
    return (
        <svg width={44} height={14} viewBox="0 0 44 14" style={{ display: 'block' }}>
            <title>{title}</title>
            {lines.map((l, i) => (
                <polyline
                    key={i}
                    points={sparklinePoints(l.values, 42, 12, l.domain, SAMPLE_HISTORY_LEN)}
                    transform="translate(1,1)"
                    fill="none"
                    stroke={l.color}
                    stroke-width="1"
                    stroke-linejoin="round"
                    stroke-linecap="round"
                />
            ))}
        </svg>
    );
}
