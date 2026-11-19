// The pieces every chart is made of: the colours of the series, the legend
// and the tooltip.

import type { ReactNode } from 'react';

/**
 * The colour of each series, by its place in the chart. They are tokens in
 * `styles.css`, in a fixed order that is never cycled: a chart has at most
 * as many series as there are colours here.
 */
export const SERIES_COLORS = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
  'var(--chart-6)',
  'var(--chart-7)',
  'var(--chart-8)',
] as const;

export const seriesColor = (index: number): string =>
  SERIES_COLORS[index % SERIES_COLORS.length] ?? SERIES_COLORS[0];

/** Tokens the frame of a chart is drawn in. Text never wears a series colour. */
export const INK = 'var(--color-ink)';
export const INK_MUTED = 'var(--color-ink-muted)';
export const GRID = 'var(--color-line)';
export const SURFACE = 'var(--color-surface)';

export const LABEL_SIZE = 11;

export type KeyShape = 'box' | 'line' | 'dot';

/** The mark a series is drawn with, small, beside its name. */
export function SeriesKey({ color, shape }: { color: string; shape: KeyShape }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden className="shrink-0">
      {shape === 'box' && <rect x="1" y="2" width="10" height="8" rx="2" fill={color} />}
      {shape === 'line' && (
        <path d="M1 6h10" stroke={color} strokeWidth="2.5" strokeLinecap="round" />
      )}
      {shape === 'dot' && <circle cx="6" cy="6" r="4" fill={color} />}
    </svg>
  );
}

interface LegendProps {
  names: string[];
  shape: KeyShape;
}

/** Which colour is which series. A chart with one series has no need of it. */
export function Legend({ names, shape }: LegendProps) {
  if (names.length < 2) {
    return null;
  }
  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-1 pb-1 text-[12px] text-ink-muted"
      data-chart-legend
    >
      {names.map((name, index) => (
        <span key={index} className="flex min-w-0 items-center gap-1">
          <SeriesKey color={seriesColor(index)} shape={shape} />
          <span className="selectable max-w-[220px] truncate" title={name}>
            {name}
          </span>
        </span>
      ))}
    </div>
  );
}

export interface TooltipRow {
  name: string;
  value: string;
  color: string;
}

interface TooltipProps {
  /** Where the pointer is, in the chart's own box. */
  x: number;
  y: number;
  /** The width of that box, to keep the tooltip inside it. */
  width: number;
  title: string;
  rows: TooltipRow[];
  /** A line under the rows, for example a share of the whole. */
  footer?: ReactNode;
}

const TOOLTIP_WIDTH = 220;

/**
 * What is under the pointer. The value leads and the name follows, because
 * the reader has found the place and wants the number. It is drawn from
 * text nodes only, so a name from a result set stays a name.
 */
export function Tooltip({ x, y, width, title, rows, footer }: TooltipProps) {
  const left = x + 14 + TOOLTIP_WIDTH > width ? Math.max(0, x - 14 - TOOLTIP_WIDTH) : x + 14;
  return (
    <div
      role="status"
      className="pointer-events-none absolute z-10 rounded-md border border-line bg-surface px-2 py-1.5 text-[12px] shadow-md"
      style={{ left, top: Math.max(0, y - 12), width: TOOLTIP_WIDTH }}
    >
      <div className="truncate text-ink-muted">{title}</div>
      {rows.map((row, index) => (
        <div key={index} className="flex items-center gap-1.5">
          <SeriesKey color={row.color} shape="line" />
          <span className="font-semibold text-ink tabular-nums">{row.value}</span>
          <span className="min-w-0 truncate text-ink-muted">{row.name}</span>
        </div>
      ))}
      {footer && <div className="text-ink-muted">{footer}</div>}
    </div>
  );
}
