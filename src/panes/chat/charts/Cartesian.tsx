import { useMemo, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { formatValue, type CartesianModel } from '../../../lib/chart';
import {
  CHAR_WIDTH,
  layoutCartesian,
  nearestPoint,
  nearestPosition,
  type CartesianLayout,
} from '../../../lib/chartLayout';
import { useWidth } from '../../../ui/useWidth';
import {
  GRID,
  INK_MUTED,
  LABEL_SIZE,
  Legend,
  SURFACE,
  Tooltip,
  seriesColor,
  type TooltipRow,
} from './parts';

interface CartesianProps {
  model: CartesianModel;
  title: string;
  xLabel: string | null;
  yLabel: string | null;
}

/** What the pointer, or the keyboard, is on. */
interface Focus {
  index: number;
  /** One series only, for a chart of loose points. */
  series: number | null;
  /** Where to put the tooltip, in the chart's own box. */
  x: number;
  y: number;
}

/** Markers on every point of a line only while there are few enough to tell apart. */
const MARKER_LIMIT = 30;

const KEY_SHAPE = { bar: 'box', area: 'box', line: 'line', scatter: 'dot' } as const;

const TEXT = {
  fill: INK_MUTED,
  fontSize: LABEL_SIZE,
  style: { fontVariantNumeric: 'tabular-nums' as const },
};

/** A chart with axes: bars, lines, areas or loose points. */
export function Cartesian({ model, title, xLabel, yLabel }: CartesianProps) {
  const [box, width] = useWidth<HTMLDivElement>();
  const [focus, setFocus] = useState<Focus | null>(null);
  const layout = useMemo(
    () => layoutCartesian(model, width, { x: xLabel !== null, y: yLabel !== null }),
    [model, width, xLabel, yLabel],
  );
  const { frame } = layout;
  const right = frame.left + frame.plotWidth;
  const bottom = frame.top + frame.plotHeight;
  const scatter = model.type === 'scatter';

  const focusAt = (index: number, series: number | null): Focus => {
    const along = layout.centres[index] ?? 0;
    const point =
      series === null
        ? undefined
        : layout.lines[series]?.points.find((candidate) => candidate.index === index);
    return layout.horizontal
      ? { index, series, x: layout.zero, y: along }
      : { index, series, x: point?.x ?? along, y: point?.y ?? frame.top + 24 };
  };

  const onPointer = (event: PointerEvent<SVGRectElement>) => {
    const bounds = box.current?.getBoundingClientRect();
    if (!bounds) {
      return;
    }
    const x = event.clientX - bounds.left;
    const y = event.clientY - bounds.top;
    if (scatter) {
      const hit = nearestPoint(layout, x, y);
      setFocus(hit ? { index: hit.point.index, series: hit.series, x, y } : null);
      return;
    }
    const index = nearestPosition(layout, layout.horizontal ? y : x);
    setFocus(index === null ? null : { index, series: null, x, y });
  };

  // The same reading from the keyboard as from the pointer.
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const count = model.labels.length;
    const step =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? -1
          : 0;
    if (event.key === 'Escape') {
      setFocus(null);
    } else if (step !== 0 && count > 0) {
      event.preventDefault();
      const next = focus === null ? 0 : Math.min(count - 1, Math.max(0, focus.index + step));
      const series = scatter
        ? model.series.findIndex(
            (entry) => entry.values[next] !== null && entry.values[next] !== undefined,
          )
        : -1;
      setFocus(focusAt(next, series >= 0 ? series : null));
    }
  };

  const rows: TooltipRow[] =
    focus === null
      ? []
      : model.series.flatMap((entry, series) => {
          const value = entry.values[focus.index];
          if (value === null || value === undefined) {
            return [];
          }
          if (focus.series !== null && focus.series !== series) {
            return [];
          }
          return [{ name: entry.name, value: formatValue(value), color: seriesColor(series) }];
        });

  return (
    <div>
      <Legend names={model.series.map((entry) => entry.name)} shape={KEY_SHAPE[model.type]} />
      <div
        ref={box}
        className="relative"
        role="group"
        tabIndex={0}
        aria-label={`${title}. Use the arrow keys to read the values.`}
        onKeyDown={onKey}
        onBlur={() => {
          setFocus(null);
        }}
      >
        <svg
          width={frame.width}
          height={frame.height}
          viewBox={`0 0 ${frame.width} ${frame.height}`}
          role="img"
          aria-label={summary(model, title)}
          className="block max-w-full"
          data-chart={model.type}
        >
          <Axes layout={layout} xLabel={xLabel} yLabel={yLabel} />

          {/* The position under the pointer, washed behind its bars. */}
          {focus !== null && layout.band > 0 && (
            <rect
              x={
                layout.horizontal
                  ? frame.left
                  : (layout.centres[focus.index] ?? 0) - layout.band / 2
              }
              y={
                layout.horizontal ? (layout.centres[focus.index] ?? 0) - layout.band / 2 : frame.top
              }
              width={layout.horizontal ? frame.plotWidth : layout.band}
              height={layout.horizontal ? layout.band : frame.plotHeight}
              fill={INK_MUTED}
              opacity={0.1}
            />
          )}

          {layout.bars.map((bar) => (
            <path
              key={`${bar.series}-${bar.index}`}
              d={bar.path}
              fill={seriesColor(bar.series)}
              data-series={bar.series}
            />
          ))}

          {layout.lines.map((line) => (
            <g key={line.series} data-series={line.series}>
              {line.area !== null && (
                <path d={line.area} fill={seriesColor(line.series)} opacity={0.1} />
              )}
              {line.path !== '' && (
                <path
                  d={line.path}
                  fill="none"
                  stroke={seriesColor(line.series)}
                  strokeWidth={2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              )}
              {(scatter || line.points.length <= MARKER_LIMIT) &&
                line.points.map((point) => (
                  <circle
                    key={point.index}
                    cx={point.x}
                    cy={point.y}
                    r={scatter ? 4 : 3.5}
                    fill={seriesColor(line.series)}
                    stroke={SURFACE}
                    strokeWidth={2}
                  />
                ))}
            </g>
          ))}

          {/* A hairline finds the place, and the points on it stand out. */}
          {focus !== null && layout.band === 0 && !scatter && (
            <line
              x1={layout.centres[focus.index] ?? 0}
              x2={layout.centres[focus.index] ?? 0}
              y1={frame.top}
              y2={bottom}
              stroke={INK_MUTED}
              strokeWidth={1}
            />
          )}
          {focus !== null &&
            layout.lines.flatMap((line) =>
              focus.series !== null && focus.series !== line.series
                ? []
                : line.points
                    .filter((point) => point.index === focus.index)
                    .map((point) => (
                      <circle
                        key={`${line.series}-${point.index}`}
                        cx={point.x}
                        cy={point.y}
                        r={5}
                        fill={seriesColor(line.series)}
                        stroke={SURFACE}
                        strokeWidth={2}
                      />
                    )),
            )}

          {/* The whole plot answers the pointer, so nothing small has to be hit. */}
          <rect
            x={frame.left}
            y={frame.top}
            width={Math.max(0, right - frame.left)}
            height={frame.plotHeight}
            fill="transparent"
            onPointerMove={onPointer}
            onPointerLeave={() => {
              setFocus(null);
            }}
          />
        </svg>

        {focus !== null && rows.length > 0 && (
          <Tooltip
            x={focus.x}
            y={focus.y}
            width={frame.width}
            title={model.labels[focus.index] ?? ''}
            rows={rows}
          />
        )}
      </div>
    </div>
  );
}

/** What the chart is, in words, for a reader who cannot see it. */
function summary(model: CartesianModel, title: string): string {
  const kind = { bar: 'Bar', line: 'Line', area: 'Area', scatter: 'Scatter' }[model.type];
  const names = model.series.map((entry) => entry.name).join(', ');
  return `${title}. ${kind} chart of ${names} over ${model.labels.length} points. The same values are in the table view.`;
}

function Axes({
  layout,
  xLabel,
  yLabel,
}: {
  layout: CartesianLayout;
  xLabel: string | null;
  yLabel: string | null;
}) {
  const { frame } = layout;
  const right = frame.left + frame.plotWidth;
  const bottom = frame.top + frame.plotHeight;
  // The axis along the bottom, and the one up the side.
  const across = layout.horizontal ? layout.valueTicks : layout.bandTicks;
  const up = layout.horizontal ? layout.bandTicks : layout.valueTicks;
  // What each is called follows the data, not the direction: x names the
  // categories and y the values, whichever way the bars run.
  const acrossTitle = layout.horizontal ? yLabel : xLabel;
  const upTitle = layout.horizontal ? xLabel : yLabel;

  return (
    <g>
      {/* Hairlines at the round values, solid and quiet. */}
      {layout.valueTicks.map((tick, index) =>
        layout.horizontal ? (
          <line key={index} x1={tick.at} x2={tick.at} y1={frame.top} y2={bottom} stroke={GRID} />
        ) : (
          <line key={index} x1={frame.left} x2={right} y1={tick.at} y2={tick.at} stroke={GRID} />
        ),
      )}
      {up.map((tick, index) => (
        <text
          key={index}
          x={frame.left - 8}
          y={tick.at}
          textAnchor="end"
          dominantBaseline="middle"
          {...TEXT}
        >
          {tick.label}
        </text>
      ))}
      {across.map((tick, index) => {
        // A label at an end of the axis is kept inside the frame.
        const half = (tick.label.length * CHAR_WIDTH) / 2;
        const anchor =
          tick.at + half > frame.width - 2 ? 'end' : tick.at - half < 2 ? 'start' : 'middle';
        const x = anchor === 'end' ? frame.width - 2 : anchor === 'start' ? 2 : tick.at;
        return (
          <text key={index} x={x} y={bottom + 15} textAnchor={anchor} {...TEXT}>
            {tick.label}
          </text>
        );
      })}
      {acrossTitle !== null && (
        <text
          x={frame.left + frame.plotWidth / 2}
          y={frame.height - 4}
          textAnchor="middle"
          {...TEXT}
        >
          {acrossTitle}
        </text>
      )}
      {upTitle !== null && (
        <text
          transform={`translate(11 ${frame.top + frame.plotHeight / 2}) rotate(-90)`}
          textAnchor="middle"
          {...TEXT}
        >
          {upTitle}
        </text>
      )}
    </g>
  );
}
