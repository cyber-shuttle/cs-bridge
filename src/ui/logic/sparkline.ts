// values → SVG polyline points (max at top; optional domain fixes the y-range). slots fixes the x-grid to a capacity
// ≥ values.length so a filling buffer grows in from the left then slides; omit it to spread values full-width.
export function sparklinePoints(values: number[], width: number, height: number, [min, max]: [number, number] = [Math.min(...values), Math.max(...values)], slots = values.length): string {
    const span = max - min;
    const denom = slots - 1;
    const stepX = denom > 0 ? width / denom : 0;
    const r = (n: number) => Math.round(n * 10) / 10;
    return values.map((v, i) => `${r(i * stepX)},${r(span === 0 ? height / 2 : height - ((v - min) / span) * height)}`).join(' ');
}
