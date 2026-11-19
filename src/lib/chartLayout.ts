// Where the marks of a chart go, in pixels. Pure functions: a model and a
// width in, positions and paths out. The components draw what this returns
// and work nothing out themselves.
//
// The marks follow a few fixed rules. A bar is at most 24 pixels thick, is
// square where it meets the baseline and rounded at its other end, and
// bars that touch are kept apart by a gap in the surface colour, never by
// an outline. Every chart has one value axis.

import {
  clip,
  formatTick,
  niceTicks,
  timeTicks,
  valueRange,
  type CartesianModel,
  type PieModel,
} from './chart';

/** The width of one character of an axis label, near enough to place labels by. */
export const CHAR_WIDTH = 6.2;
/** The height of a chart whose bars stand up, or that is drawn with lines. */
export const CHART_HEIGHT = 260;

const MAX_BAR = 24;
const BAR_GAP = 2;
const BAR_RADIUS = 4;
/** The most characters of a name under a position, and the fewest worth showing. */
const MAX_LABEL = 16;
const MIN_LABEL = 7;

export interface Frame {
  width: number;
  height: number;
  /** The plot area, inside the room left for the axes. */
  left: number;
  top: number;
  plotWidth: number;
  plotHeight: number;
}

export interface AxisTick {
  /** Where the tick is along its axis, in pixels. */
  at: number;
  label: string;
}

export interface BarMark {
  series: number;
  index: number;
  value: number;
  path: string;
}

export interface PointMark {
  index: number;
  x: number;
  y: number;
  value: number;
}

export interface LineMark {
  series: number;
  /** The line itself. Empty for a scatter chart. */
  path: string;
  /** The wash under the line, for an area chart. */
  area: string | null;
  points: PointMark[];
}

export interface CartesianLayout {
  frame: Frame;
  /** The bars lie down, so the value axis runs across. */
  horizontal: boolean;
  valueTicks: AxisTick[];
  bandTicks: AxisTick[];
  /** Where the value zero is, or the end of the axis nearest to it. */
  zero: number;
  /** The middle of each position along the band axis. */
  centres: number[];
  /** The room each position has along the band axis. Zero on a continuous axis. */
  band: number;
  bars: BarMark[];
  lines: LineMark[];
}

type Side = 'top' | 'bottom' | 'left' | 'right';

const n = (value: number) => Number(value.toFixed(2));

/** A bar as a path, with the end that is away from the baseline rounded. */
export function barPath(x: number, y: number, width: number, height: number, round: Side): string {
  const w = Math.max(0, width);
  const h = Math.max(0, height);
  const across = round === 'top' || round === 'bottom' ? w : h;
  const along = round === 'top' || round === 'bottom' ? h : w;
  const r = Math.max(0, Math.min(BAR_RADIUS, across / 2, along));
  const [x0, y0, x1, y1] = [n(x), n(y), n(x + w), n(y + h)];
  switch (round) {
    case 'top':
      return `M${x0},${y1}L${x0},${n(y + r)}Q${x0},${y0} ${n(x + r)},${y0}L${n(x + w - r)},${y0}Q${x1},${y0} ${x1},${n(y + r)}L${x1},${y1}Z`;
    case 'bottom':
      return `M${x0},${y0}L${x0},${n(y + h - r)}Q${x0},${y1} ${n(x + r)},${y1}L${n(x + w - r)},${y1}Q${x1},${y1} ${x1},${n(y + h - r)}L${x1},${y0}Z`;
    case 'right':
      return `M${x0},${y0}L${n(x + w - r)},${y0}Q${x1},${y0} ${x1},${n(y + r)}L${x1},${n(y + h - r)}Q${x1},${y1} ${n(x + w - r)},${y1}L${x0},${y1}Z`;
    case 'left':
      return `M${x1},${y0}L${n(x + r)},${y0}Q${x0},${y0} ${x0},${n(y + r)}L${x0},${n(y + h - r)}Q${x0},${y1} ${n(x + r)},${y1}L${x1},${y1}Z`;
  }
}

/** A bar with no free end: a segment inside a stack. */
function rectPath(x: number, y: number, width: number, height: number): string {
  const [x0, y0] = [n(x), n(y)];
  const [x1, y1] = [n(x + Math.max(0, width)), n(y + Math.max(0, height))];
  return `M${x0},${y0}L${x1},${y0}L${x1},${y1}L${x0},${y1}Z`;
}

interface ValueAxis {
  ticks: number[];
  min: number;
  max: number;
  labels: string[];
}

function valueAxis(model: CartesianModel, target: number): ValueAxis {
  const [low, high] = valueRange(model);
  const ticks = niceTicks(low, high, target);
  return {
    ticks,
    min: ticks[0] ?? 0,
    max: ticks[ticks.length - 1] ?? 1,
    labels: ticks.map((tick) => formatTick(tick, ticks)),
  };
}

const longest = (labels: string[], cap: number) =>
  Math.min(
    cap,
    labels.reduce((most, label) => Math.max(most, label.length), 1),
  );

/**
 * The bars of one position. `along` turns a value into a place on the
 * value axis, and `place` turns a bar's box, given along the band axis and
 * the value axis, into a path.
 */
function barsAt(
  model: CartesianModel,
  index: number,
  start: number,
  thickness: number,
  along: (value: number) => number,
  place: (
    band: number,
    thick: number,
    from: number,
    to: number,
    value: number,
    outer: boolean,
  ) => string,
): BarMark[] {
  const marks: BarMark[] = [];
  if (model.stacked) {
    let up = 0;
    let down = 0;
    // The last segment on each side of zero is the one with the free end.
    let lastUp = -1;
    let lastDown = -1;
    model.series.forEach((entry, series) => {
      const value = entry.values[index] ?? 0;
      if (value > 0) {
        lastUp = series;
      } else if (value < 0) {
        lastDown = series;
      }
    });
    model.series.forEach((entry, series) => {
      const value = entry.values[index];
      if (value === null || value === undefined || value === 0) {
        return;
      }
      const base = value > 0 ? up : down;
      if (value > 0) {
        up += value;
      } else {
        down += value;
      }
      let from = along(base);
      const to = along(base + value);
      // A gap in the surface colour between one segment and the next.
      if (base !== 0 && Math.abs(to - from) > BAR_GAP + 1) {
        from += Math.sign(to - from) * BAR_GAP;
      }
      const outer = series === (value > 0 ? lastUp : lastDown);
      marks.push({ series, index, value, path: place(start, thickness, from, to, value, outer) });
    });
    return marks;
  }
  model.series.forEach((entry, series) => {
    const value = entry.values[index];
    if (value === null || value === undefined) {
      return;
    }
    const at = start + series * (thickness + BAR_GAP);
    marks.push({
      series,
      index,
      value,
      path: place(at, thickness, along(0), along(value), value, true),
    });
  });
  return marks;
}

function layoutVertical(model: CartesianModel, width: number, titled: Titled): CartesianLayout {
  const count = model.labels.length;
  const axis = valueAxis(model, 5);
  const left = Math.ceil(longest(axis.labels, 12) * CHAR_WIDTH) + 12 + (titled.y ? 18 : 0);
  const top = 10;
  const bottom = 24 + (titled.x ? 18 : 0);
  const plotWidth = Math.max(60, width - left - 14);
  const plotHeight = CHART_HEIGHT - top - bottom;
  const span = axis.max - axis.min || 1;
  const clamp = (value: number) => Math.min(Math.max(value, axis.min), axis.max);
  const y = (value: number) => top + plotHeight - ((clamp(value) - axis.min) / span) * plotHeight;
  const frame: Frame = { width, height: CHART_HEIGHT, left, top, plotWidth, plotHeight };

  let centres: number[];
  let bandTicks: AxisTick[];
  let band = plotWidth / Math.max(1, count);
  if (model.positions) {
    const positions = model.positions;
    const first = positions[0] ?? 0;
    const last = positions[positions.length - 1] ?? first;
    const pad = 10;
    const x = (position: number) =>
      last === first
        ? left + plotWidth / 2
        : left + pad + ((position - first) / (last - first)) * (plotWidth - 2 * pad);
    centres = positions.map(x);
    band = 0;
    if (model.xKind === 'time') {
      bandTicks = timeTicks(first, last, Math.max(2, Math.floor(plotWidth / 90))).map((tick) => ({
        at: x(tick.value),
        label: tick.label,
      }));
    } else {
      const ticks = niceTicks(first, last, Math.max(2, Math.floor(plotWidth / 80))).filter(
        (tick) => tick >= first && tick <= last,
      );
      bandTicks = ticks.map((tick) => ({ at: x(tick), label: formatTick(tick, ticks) }));
    }
    if (bandTicks.length === 0) {
      // Too short a span for a round tick: name the ends.
      const ends = count > 1 ? [0, count - 1] : [0];
      bandTicks = ends.map((index) => ({
        at: centres[index] ?? left,
        label: clip(model.labels[index] ?? '', 16),
      }));
    }
  } else {
    centres = model.labels.map((_, index) => left + band * (index + 0.5));
    // Every position is named when its name fits under it, cut short if it
    // has to be, as long as enough of it is left to tell the names apart.
    // Otherwise every few are named, and the rest are read from the tooltip
    // or the table.
    const widest = longest(model.labels, MAX_LABEL);
    const fits = Math.floor((band - 8) / CHAR_WIDTH);
    if (fits >= Math.min(widest, MIN_LABEL)) {
      bandTicks = model.labels.map((label, index) => ({
        at: centres[index] ?? left,
        label: clip(label, Math.min(MAX_LABEL, fits)),
      }));
    } else {
      const every = Math.max(1, Math.ceil((widest * CHAR_WIDTH + 12) / band));
      bandTicks = model.labels.flatMap((label, index) =>
        index % every === 0 ? [{ at: centres[index] ?? left, label: clip(label, MAX_LABEL) }] : [],
      );
    }
  }

  const bars: BarMark[] = [];
  const lines: LineMark[] = [];
  if (model.type === 'bar') {
    const groups = model.stacked ? 1 : model.series.length;
    const thickness = Math.max(
      1,
      Math.min(MAX_BAR, (band * 0.72 - (groups - 1) * BAR_GAP) / groups),
    );
    const groupWidth = groups * thickness + (groups - 1) * BAR_GAP;
    for (let index = 0; index < count; index += 1) {
      const start = (centres[index] ?? left) - groupWidth / 2;
      bars.push(
        ...barsAt(model, index, start, thickness, y, (at, thick, from, to, value, outer) => {
          // At least a pixel, so that a small value is still a mark.
          const height = Math.max(1, Math.abs(to - from));
          const topEdge = value >= 0 ? from - height : from;
          return outer
            ? barPath(at, topEdge, thick, height, value >= 0 ? 'top' : 'bottom')
            : rectPath(at, topEdge, thick, height);
        }),
      );
    }
  } else {
    const zero = y(0);
    model.series.forEach((entry, series) => {
      const points: PointMark[] = [];
      let path = '';
      let area = '';
      let run: PointMark[] = [];
      const endRun = () => {
        const [start] = run;
        const end = run[run.length - 1];
        if (start && end && model.type === 'area') {
          area += `M${n(start.x)},${n(zero)}${run.map((p) => `L${n(p.x)},${n(p.y)}`).join('')}L${n(end.x)},${n(zero)}Z`;
        }
        run = [];
      };
      entry.values.forEach((value, index) => {
        if (value === null) {
          endRun();
          return;
        }
        const point = { index, x: centres[index] ?? left, y: y(value), value };
        path += `${run.length === 0 ? 'M' : 'L'}${n(point.x)},${n(point.y)}`;
        run.push(point);
        points.push(point);
      });
      endRun();
      lines.push({
        series,
        path: model.type === 'scatter' ? '' : path,
        area: model.type === 'area' ? area : null,
        points,
      });
    });
  }

  return {
    frame,
    horizontal: false,
    valueTicks: axis.ticks.map((tick, index) => ({ at: y(tick), label: axis.labels[index] ?? '' })),
    bandTicks,
    zero: y(0),
    centres,
    band,
    bars,
    lines,
  };
}

function layoutHorizontal(model: CartesianModel, width: number, titled: Titled): CartesianLayout {
  const count = model.labels.length;
  const groups = model.stacked ? 1 : model.series.length;
  const thickness = groups === 1 ? 16 : 10;
  const groupHeight = groups * thickness + (groups - 1) * BAR_GAP;
  const band = Math.max(24, groupHeight + 10);
  const left = Math.ceil(longest(model.labels, 28) * CHAR_WIDTH) + 12 + (titled.x ? 18 : 0);
  const top = 6;
  const bottom = 24 + (titled.y ? 18 : 0);
  const plotWidth = Math.max(60, width - left - 22);
  const plotHeight = count * band;
  const axis = valueAxis(model, Math.max(2, Math.floor(plotWidth / 90)));
  const span = axis.max - axis.min || 1;
  const clamp = (value: number) => Math.min(Math.max(value, axis.min), axis.max);
  const x = (value: number) => left + ((clamp(value) - axis.min) / span) * plotWidth;
  const centres = model.labels.map((_, index) => top + band * (index + 0.5));

  const bars: BarMark[] = [];
  for (let index = 0; index < count; index += 1) {
    const start = (centres[index] ?? top) - groupHeight / 2;
    bars.push(
      ...barsAt(model, index, start, thickness, x, (at, thick, from, to, value, outer) => {
        const length = Math.max(1, Math.abs(to - from));
        const leftEdge = value >= 0 ? from : from - length;
        return outer
          ? barPath(leftEdge, at, length, thick, value >= 0 ? 'right' : 'left')
          : rectPath(leftEdge, at, length, thick);
      }),
    );
  }

  return {
    frame: { width, height: top + plotHeight + bottom, left, top, plotWidth, plotHeight },
    horizontal: true,
    valueTicks: axis.ticks.map((tick, index) => ({ at: x(tick), label: axis.labels[index] ?? '' })),
    bandTicks: model.labels.map((label, index) => ({
      at: centres[index] ?? top,
      label: clip(label, 28),
    })),
    zero: x(0),
    centres,
    band,
    bars,
    lines: [],
  };
}

interface Titled {
  /** The axis along the bottom has a title. */
  x: boolean;
  /** The axis up the side has a title. */
  y: boolean;
}

/** Lays out a chart with axes at the width it will be drawn at. */
export function layoutCartesian(
  model: CartesianModel,
  width: number,
  titled: Titled,
): CartesianLayout {
  return model.horizontal
    ? layoutHorizontal(model, width, titled)
    : layoutVertical(model, width, titled);
}

/** The position nearest to a place along the band axis. */
export function nearestPosition(layout: CartesianLayout, at: number): number | null {
  let best: number | null = null;
  let distance = Infinity;
  layout.centres.forEach((centre, index) => {
    const away = Math.abs(centre - at);
    if (away < distance) {
      distance = away;
      best = index;
    }
  });
  return best;
}

/** The point nearest to a place in the plot, for a chart of loose points. */
export function nearestPoint(
  layout: CartesianLayout,
  x: number,
  y: number,
): { series: number; point: PointMark } | null {
  let best: { series: number; point: PointMark } | null = null;
  let distance = Infinity;
  for (const line of layout.lines) {
    for (const point of line.points) {
      const away = (point.x - x) ** 2 + (point.y - y) ** 2;
      if (away < distance) {
        distance = away;
        best = { series: line.series, point };
      }
    }
  }
  return best;
}

export interface SliceMark {
  index: number;
  name: string;
  value: number;
  /** The share of the whole, from 0 to 1. */
  share: number;
  path: string;
}

export interface PieLayout {
  size: number;
  slices: SliceMark[];
}

/**
 * A ring cut into parts, starting at the top and going clockwise. A part
 * that is the whole ring is drawn as two halves, since an arc cannot end
 * where it starts.
 */
export function layoutPie(model: PieModel, size = 180): PieLayout {
  const centre = size / 2;
  const outer = size / 2 - 2;
  const inner = outer * 0.6;
  const point = (radius: number, turn: number) => {
    const angle = turn * 2 * Math.PI - Math.PI / 2;
    return `${n(centre + radius * Math.cos(angle))},${n(centre + radius * Math.sin(angle))}`;
  };
  const arc = (from: number, to: number) => {
    const large = to - from > 0.5 ? 1 : 0;
    return (
      `M${point(outer, from)}A${outer},${outer} 0 ${large} 1 ${point(outer, to)}` +
      `L${point(inner, to)}A${inner},${inner} 0 ${large} 0 ${point(inner, from)}Z`
    );
  };
  let turned = 0;
  const slices = model.slices.map((slice, index) => {
    const share = model.total > 0 ? slice.value / model.total : 0;
    const from = turned;
    turned += share;
    const path = share >= 0.9999 ? `${arc(0, 0.5)}${arc(0.5, 1)}` : arc(from, Math.min(1, turned));
    return { index, name: slice.name, value: slice.value, share, path };
  });
  return { size, slices };
}

/** A share as a percentage, for example 24% or 2.4%. */
export function formatShare(share: number): string {
  const percent = share * 100;
  return `${percent >= 10 || percent === 0 ? percent.toFixed(0) : percent.toFixed(1)}%`;
}
