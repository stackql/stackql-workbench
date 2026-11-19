import { useMemo, useState } from 'react';
import { formatValue, type PieModel } from '../../../lib/chart';
import { formatShare, layoutPie } from '../../../lib/chartLayout';
import { INK, INK_MUTED, SURFACE, SeriesKey, seriesColor } from './parts';

interface PieProps {
  model: PieModel;
  title: string;
}

/**
 * One whole split into a few parts, as a ring. Every part is named beside
 * it with its amount and its share, so nothing has to be read off an angle
 * or found by hovering.
 */
export function Pie({ model, title }: PieProps) {
  const layout = useMemo(() => layoutPie(model), [model]);
  const [active, setActive] = useState<number | null>(null);
  const centre = layout.size / 2;

  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-1">
      <svg
        width={layout.size}
        height={layout.size}
        viewBox={`0 0 ${layout.size} ${layout.size}`}
        role="img"
        aria-label={`${title}. ${layout.slices
          .map((slice) => `${slice.name}: ${formatValue(slice.value)}, ${formatShare(slice.share)}`)
          .join('. ')}.`}
        className="shrink-0"
        data-chart="pie"
      >
        {layout.slices.map((slice) => (
          <path
            key={slice.index}
            d={slice.path}
            fill={seriesColor(slice.index)}
            // Parts are kept apart by a gap in the surface colour.
            stroke={SURFACE}
            strokeWidth={2}
            opacity={active === null || active === slice.index ? 1 : 0.45}
            data-series={slice.index}
            onPointerEnter={() => {
              setActive(slice.index);
            }}
            onPointerLeave={() => {
              setActive(null);
            }}
          />
        ))}
        <text
          x={centre}
          y={centre - 2}
          textAnchor="middle"
          fill={INK}
          fontSize={18}
          fontWeight={600}
        >
          {formatValue(model.total)}
        </text>
        <text x={centre} y={centre + 15} textAnchor="middle" fill={INK_MUTED} fontSize={11}>
          total
        </text>
      </svg>

      <div className="grid max-w-[420px] min-w-0 flex-1 grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-x-3 gap-y-0.5 text-[12px]">
        {layout.slices.map((slice) => (
          <div
            key={slice.index}
            className={`col-span-4 grid grid-cols-subgrid items-center rounded px-1 ${
              active === slice.index ? 'bg-surface-sunken' : ''
            }`}
            onPointerEnter={() => {
              setActive(slice.index);
            }}
            onPointerLeave={() => {
              setActive(null);
            }}
          >
            <SeriesKey color={seriesColor(slice.index)} shape="box" />
            <span className="selectable truncate" title={slice.name}>
              {slice.name}
            </span>
            <span className="selectable text-right font-semibold tabular-nums">
              {formatValue(slice.value)}
            </span>
            <span className="text-right text-ink-muted tabular-nums">
              {formatShare(slice.share)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
