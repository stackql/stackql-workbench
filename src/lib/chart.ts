// The chart block: what a model writes to ask for a chart, and what is
// worked out from it before anything is drawn. Pure functions.
//
// A model puts a fenced block with the language `chart` in its answer. The
// block holds one JSON object that names a chart type and the columns to
// draw. The rows come from a result set already in the conversation, or
// from the block itself. Nothing in a block is ever run or turned into
// markup: it is read as data, checked, and drawn by this app's own code.
//
// The format is described for a model in `src-tauri/src/agent/guidance.rs`
// and for people in `docs/charts.md`. Keep the three in step.

import type { Row } from '../host/types';
import { cellNumber } from './sortRows';

export type ChartType = 'bar' | 'line' | 'area' | 'pie' | 'scatter' | 'table';

const TYPES: Record<string, ChartType> = {
  bar: 'bar',
  column: 'bar',
  line: 'line',
  area: 'area',
  pie: 'pie',
  donut: 'pie',
  doughnut: 'pie',
  scatter: 'scatter',
  table: 'table',
};

export interface ChartData {
  columns: string[];
  rows: Row[];
}

export interface ChartSpec {
  type: ChartType;
  title: string | null;
  /** The column along the horizontal axis, or the one that names the slices. */
  x: string | null;
  /** The columns that hold the numbers. */
  y: string[];
  /** A column whose values name the series, for rows that carry one. */
  series: string | null;
  /** For a table: the columns to show, in order. Null shows them all. */
  columns: string[] | null;
  stacked: boolean;
  horizontal: boolean;
  xLabel: string | null;
  yLabel: string | null;
  /** Rows given in the block itself. */
  data: ChartData | null;
}

export type Outcome<T> = { ok: true; value: T } | { ok: false; error: string };

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

/** Rows a block may carry, and points a chart will draw. */
export const MAX_INLINE_ROWS = 5000;
/** A chart never has more series than the palette has colours. */
export const MAX_SERIES = 8;
const MAX_BARS = 200;
const MAX_ROWS_OF_BARS = 25;
const MAX_POINTS = 2000;

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function names(value: unknown): string[] | null {
  if (typeof value === 'string') {
    return value.trim() === '' ? null : [value.trim()];
  }
  if (Array.isArray(value)) {
    const list = value.flatMap((entry) =>
      typeof entry === 'string' && entry.trim() ? [entry.trim()] : [],
    );
    return list.length === value.length && list.length > 0 ? list : null;
  }
  return null;
}

/** One value of a block's own data, as the text a result set would hold. */
function cell(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Rows written in the block: a list of objects, or columns with rows. */
function inlineData(value: unknown): Outcome<ChartData> {
  if (Array.isArray(value)) {
    const records = value.slice(0, MAX_INLINE_ROWS);
    if (!records.every(isRecord)) {
      return fail('"data" must be a list of objects, one for each row.');
    }
    const columns: string[] = [];
    for (const record of records) {
      for (const key of Object.keys(record)) {
        if (!columns.includes(key)) {
          columns.push(key);
        }
      }
    }
    return {
      ok: true,
      value: { columns, rows: records.map((record) => columns.map((name) => cell(record[name]))) },
    };
  }
  if (isRecord(value)) {
    const columns = names(value.columns);
    const rows = value.rows;
    if (!columns || !Array.isArray(rows) || !rows.every((row) => Array.isArray(row))) {
      return fail('"data" must be a list of objects, one for each row.');
    }
    return {
      ok: true,
      value: {
        columns,
        rows: rows
          .slice(0, MAX_INLINE_ROWS)
          .map((row) => columns.map((_, index) => cell((row as unknown[])[index]))),
      },
    };
  }
  return fail('"data" must be a list of objects, one for each row.');
}

/** Reads the text of a chart block. Anything that is not understood is an error, not a guess. */
export function parseChartSpec(source: string): Outcome<ChartSpec> {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    return fail('The block is not valid JSON.');
  }
  if (!isRecord(raw)) {
    return fail('The block must hold one JSON object.');
  }
  const type = typeof raw.type === 'string' ? TYPES[raw.type.trim().toLowerCase()] : undefined;
  if (!type) {
    return fail('"type" must be one of bar, line, area, pie, scatter and table.');
  }
  const x = text(raw.x);
  const y = raw.y === undefined || raw.y === null ? [] : names(raw.y);
  if (y === null) {
    return fail('"y" must name one or more columns.');
  }
  if (type !== 'table') {
    if (x === null) {
      return fail('"x" must name a column.');
    }
    if (y.length === 0) {
      return fail('"y" must name one or more columns.');
    }
  }
  let columns: string[] | null = null;
  if (raw.columns !== undefined && raw.columns !== null) {
    columns = names(raw.columns);
    if (columns === null) {
      return fail('"columns" must be a list of column names.');
    }
  }
  let data: ChartData | null = null;
  if (raw.data !== undefined && raw.data !== null) {
    const read = inlineData(raw.data);
    if (!read.ok) {
      return read;
    }
    data = read.value;
  }
  return {
    ok: true,
    value: {
      type,
      title: text(raw.title),
      x,
      y,
      series: text(raw.series),
      columns,
      stacked: raw.stacked === true,
      horizontal: raw.horizontal === true,
      xLabel: text(raw.xLabel),
      yLabel: text(raw.yLabel),
      data,
    },
  };
}

/** Where a named column is. The name as written wins over one that differs only in case. */
export function columnIndex(columns: string[], name: string): number {
  const exact = columns.indexOf(name);
  if (exact >= 0) {
    return exact;
  }
  const lower = name.toLowerCase();
  return columns.findIndex((column) => column.toLowerCase() === lower);
}

/** The columns a block names, which the data it is drawn from must have. */
export function neededColumns(spec: ChartSpec): string[] {
  const list =
    spec.type === 'table'
      ? (spec.columns ?? [])
      : [
          ...(spec.x === null ? [] : [spec.x]),
          ...spec.y,
          ...(spec.series === null ? [] : [spec.series]),
        ];
  return [...new Set(list)];
}

const quoted = (list: string[]) => list.map((name) => `"${name}"`).join(', ');

export interface ResolvedData {
  data: ChartData;
  /** Which of the result sets the rows came from. Null when the block carried them. */
  from: number | null;
}

/**
 * Finds the rows a block is drawn from: its own, or the most recent result
 * set that has every column it names. `results` is oldest first.
 */
export function resolveChartData(spec: ChartSpec, results: ChartData[]): Outcome<ResolvedData> {
  const needed = neededColumns(spec);
  const has = (data: ChartData) => needed.every((name) => columnIndex(data.columns, name) >= 0);
  if (spec.data) {
    const missing = needed.filter((name) => columnIndex(spec.data?.columns ?? [], name) < 0);
    return missing.length === 0
      ? { ok: true, value: { data: spec.data, from: null } }
      : fail(`The data in the block has no column ${quoted(missing)}.`);
  }
  for (let index = results.length - 1; index >= 0; index -= 1) {
    const candidate = results[index];
    if (candidate && has(candidate)) {
      return { ok: true, value: { data: candidate, from: index } };
    }
  }
  if (results.length === 0) {
    return fail('There is no result set in this conversation to draw from.');
  }
  return fail(`No result set in this conversation has the columns ${quoted(needed)}.`);
}

/** The columns a table block asks for, or all of them. */
export function tableView(spec: ChartSpec, data: ChartData): ChartData {
  if (spec.type !== 'table' || spec.columns === null) {
    return data;
  }
  const picked = spec.columns
    .map((name) => columnIndex(data.columns, name))
    .filter((at) => at >= 0);
  return {
    columns: picked.map((at) => data.columns[at] ?? ''),
    rows: data.rows.map((row) => picked.map((at) => row[at] ?? null)),
  };
}

const GROUPED = /^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/;

/** The number in a cell. Also reads 1,234 and 45%, which a result can hold as text. */
export function chartNumber(value: string | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  let candidate = value.trim();
  if (candidate.endsWith('%')) {
    candidate = candidate.slice(0, -1).trim();
  }
  if (GROUPED.test(candidate)) {
    candidate = candidate.replace(/,/g, '');
  }
  return cellNumber(candidate);
}

const DATE = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/;
const DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i;

/**
 * The moment a cell names, in milliseconds since 1970, for the forms a
 * result set holds: a year, a month, a day, or a date with a time. A time
 * with no zone is taken as UTC, so that a chart does not move with the
 * operator's own zone.
 */
export function parseTime(value: string | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const source = value.trim();
  const date = DATE.exec(source);
  if (date) {
    const year = Number(date[1]);
    const month = date[2] === undefined ? 1 : Number(date[2]);
    const day = date[3] === undefined ? 1 : Number(date[3]);
    if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) {
      return null;
    }
    return Date.UTC(year, month - 1, day);
  }
  const moment = DATE_TIME.exec(source);
  if (moment) {
    const zone = moment[7] ? moment[7].toUpperCase() : 'Z';
    const parsed = Date.parse(
      `${moment[1]}-${moment[2]}-${moment[3]}T${moment[4]}:${moment[5]}:${moment[6] ?? '00'}${zone}`,
    );
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

export interface Series {
  name: string;
  /** One value for each position along the axis. Null where there is none. */
  values: (number | null)[];
}

export interface CartesianModel {
  kind: 'cartesian';
  type: 'bar' | 'line' | 'area' | 'scatter';
  /** What each position along the axis is called. */
  labels: string[];
  /** Where each position sits on a continuous axis. Null spaces them evenly. */
  positions: number[] | null;
  xKind: 'category' | 'time' | 'number';
  series: Series[];
  stacked: boolean;
  horizontal: boolean;
  /** What was left out or put together, said under the chart. */
  notes: string[];
}

export interface PieModel {
  kind: 'pie';
  slices: { name: string; value: number }[];
  total: number;
  /** What the slices measure. */
  valueName: string;
  notes: string[];
}

export type ChartModel = CartesianModel | PieModel;

const OTHER = 'Other';

const plural = (count: number, one: string, many: string) =>
  `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`;

/** Keeps the largest series and adds the rest together, so that a chart never runs out of colours. */
function capSeries(series: Series[], notes: string[]): Series[] {
  if (series.length <= MAX_SERIES) {
    return series;
  }
  const size = (entry: Series) =>
    entry.values.reduce<number>((sum, v) => sum + Math.abs(v ?? 0), 0);
  const ranked = series.map((entry, index) => ({ entry, index, size: size(entry) }));
  const keep = new Set(
    [...ranked]
      .sort((a, b) => b.size - a.size || a.index - b.index)
      .slice(0, MAX_SERIES - 1)
      .map((item) => item.index),
  );
  const kept = series.filter((_, index) => keep.has(index));
  const rest = series.filter((_, index) => !keep.has(index));
  const length = series[0]?.values.length ?? 0;
  const other: Series = {
    name: OTHER,
    values: Array.from({ length }, (_, at) => {
      const present = rest.flatMap((entry) => {
        const value = entry.values[at];
        return value === null || value === undefined ? [] : [value];
      });
      return present.length === 0 ? null : present.reduce((sum, value) => sum + value, 0);
    }),
  };
  notes.push(
    `Showing the ${MAX_SERIES - 1} largest of ${series.length} series. The rest are added together as ${OTHER}.`,
  );
  return [...kept, other];
}

function buildPie(spec: ChartSpec, data: ChartData): Outcome<PieModel> {
  const labelAt = columnIndex(data.columns, spec.x ?? '');
  const valueName = spec.y[0] ?? '';
  const valueAt = columnIndex(data.columns, valueName);
  const notes: string[] = [];
  const totals = new Map<string, number>();
  let skipped = 0;
  for (const row of data.rows) {
    const value = chartNumber(row[valueAt]);
    if (value === null || value <= 0) {
      skipped += 1;
      continue;
    }
    const name = row[labelAt] ?? '(none)';
    totals.set(name, (totals.get(name) ?? 0) + value);
  }
  if (skipped > 0) {
    notes.push(
      `${plural(skipped, 'row', 'rows')} with no amount above zero ${skipped === 1 ? 'was' : 'were'} left out.`,
    );
  }
  let slices = [...totals].map(([name, value]) => ({ name, value }));
  if (slices.length === 0) {
    return fail(`There is nothing to draw: "${valueName}" holds no amounts above zero.`);
  }
  if (slices.length > MAX_SERIES) {
    const ranked = [...slices].sort((a, b) => b.value - a.value);
    const kept = ranked.slice(0, MAX_SERIES - 1);
    const rest = ranked.slice(MAX_SERIES - 1).reduce((sum, slice) => sum + slice.value, 0);
    notes.push(
      `Showing the ${MAX_SERIES - 1} largest of ${slices.length} parts. The rest are added together as ${OTHER}.`,
    );
    slices = [...kept, { name: OTHER, value: rest }];
  }
  return {
    ok: true,
    value: {
      kind: 'pie',
      slices,
      total: slices.reduce((sum, slice) => sum + slice.value, 0),
      valueName,
      notes,
    },
  };
}

interface Draft {
  labels: string[];
  series: Series[];
}

/** Rows that carry a series name: one position for each x, one series for each name. */
function pivot(
  data: ChartData,
  xAt: number,
  yAt: number,
  seriesAt: number,
  merge: boolean,
): Draft & { unread: number } {
  const labels: string[] = [];
  const position = new Map<string, number>();
  const series = new Map<string, (number | null)[]>();
  let unread = 0;
  data.rows.forEach((row) => {
    const label = row[xAt] ?? '';
    let at: number;
    const known = merge ? position.get(label) : undefined;
    if (known === undefined) {
      at = labels.length;
      labels.push(label);
      position.set(label, at);
    } else {
      at = known;
    }
    const name = row[seriesAt] ?? '(none)';
    const values = series.get(name) ?? [];
    series.set(name, values);
    const raw = row[yAt];
    const value = chartNumber(raw);
    if (value === null) {
      if (raw !== null && raw !== undefined && raw.trim() !== '') {
        unread += 1;
      }
      return;
    }
    // Rows that share a point are added together.
    values[at] = (values[at] ?? 0) + value;
  });
  return {
    labels,
    series: [...series].map(([name, values]) => ({
      name,
      values: Array.from({ length: labels.length }, (_, at) => values[at] ?? null),
    })),
    unread,
  };
}

/** Works out what to draw. An error says why nothing can be. */
export function buildChart(spec: ChartSpec, data: ChartData): Outcome<ChartModel> {
  if (spec.type === 'table') {
    return fail('A table is not a chart.');
  }
  if (data.rows.length === 0) {
    return fail('There is nothing to draw: the result set has no rows.');
  }
  if (spec.type === 'pie') {
    return buildPie(spec, data);
  }

  const type = spec.type;
  const notes: string[] = [];
  const xAt = columnIndex(data.columns, spec.x ?? '');
  let draft: Draft;
  let unread = 0;

  if (spec.series !== null) {
    if (spec.y.length > 1) {
      notes.push(`With a series column only "${spec.y[0] ?? ''}" is drawn.`);
    }
    const pivoted = pivot(
      data,
      xAt,
      columnIndex(data.columns, spec.y[0] ?? ''),
      columnIndex(data.columns, spec.series),
      // Each row of a scatter chart is a point of its own.
      type !== 'scatter',
    );
    draft = pivoted;
    unread = pivoted.unread;
  } else {
    draft = {
      labels: data.rows.map((row) => row[xAt] ?? ''),
      series: spec.y.map((name) => {
        const at = columnIndex(data.columns, name);
        return {
          name,
          values: data.rows.map((row) => {
            const raw = row[at];
            const value = chartNumber(raw);
            if (value === null && raw !== null && raw !== undefined && raw.trim() !== '') {
              unread += 1;
            }
            return value;
          }),
        };
      }),
    };
  }
  if (unread > 0) {
    notes.push(
      `${plural(unread, 'value that is not a number was', 'values that are not numbers were')} left out.`,
    );
  }

  // A line follows its axis, so the positions of a continuous axis are put in order.
  let xKind: CartesianModel['xKind'] = 'category';
  let positions: number[] | null = null;
  if (type !== 'bar') {
    const asTime = draft.labels.map(parseTime);
    const asNumber = draft.labels.map(chartNumber);
    if (asTime.every((value) => value !== null)) {
      xKind = 'time';
      positions = asTime;
    } else if (asNumber.every((value) => value !== null)) {
      xKind = 'number';
      positions = asNumber;
    }
  }
  if (positions) {
    const where = positions;
    const order = where
      .map((_, index) => index)
      .sort((a, b) => (where[a] ?? 0) - (where[b] ?? 0) || a - b);
    draft = {
      labels: order.map((index) => draft.labels[index] ?? ''),
      series: draft.series.map((entry) => ({
        name: entry.name,
        values: order.map((index) => entry.values[index] ?? null),
      })),
    };
    positions = order.map((index) => where[index] ?? 0);
  }

  // Bars that lie down each take a row, so fewer of them fit a card.
  const limit = type !== 'bar' ? MAX_POINTS : spec.horizontal ? MAX_ROWS_OF_BARS : MAX_BARS;
  if (draft.labels.length > limit) {
    notes.push(
      `Showing the first ${limit.toLocaleString('en-US')} of ${draft.labels.length.toLocaleString('en-US')} points.`,
    );
    draft = {
      labels: draft.labels.slice(0, limit),
      series: draft.series.map((entry) => ({
        name: entry.name,
        values: entry.values.slice(0, limit),
      })),
    };
    positions = positions ? positions.slice(0, limit) : null;
  }

  const series = capSeries(draft.series, notes);
  if (!series.some((entry) => entry.values.some((value) => value !== null))) {
    return fail(
      `There is nothing to draw: ${quoted(spec.y)} ${spec.y.length === 1 ? 'holds' : 'hold'} no numbers.`,
    );
  }
  return {
    ok: true,
    value: {
      kind: 'cartesian',
      type,
      labels: draft.labels,
      positions,
      xKind,
      series,
      stacked: type === 'bar' && spec.stacked && series.length > 1,
      horizontal: type === 'bar' && spec.horizontal,
      notes,
    },
  };
}

/** The step between ticks: 1, 2 or 5 times a power of ten. */
function niceStep(rough: number): number {
  const power = Math.pow(10, Math.floor(Math.log10(rough)));
  const fraction = rough / power;
  const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  return nice * power;
}

/** Round values that cover `min` to `max`, about `target` of them. The first and last are the ends of the axis. */
export function niceTicks(min: number, max: number, target = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return [0, 1];
  }
  if (min === max) {
    // One value: an axis around it, from zero when that is close.
    if (min === 0) {
      return [0, 1];
    }
    return min > 0 ? niceTicks(0, min, target) : niceTicks(min, 0, target);
  }
  const step = niceStep((max - min) / Math.max(1, target));
  const first = Math.floor(min / step) * step;
  const last = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  // Counted, not added up, so that a step such as 0.1 does not drift.
  const count = Math.round((last - first) / step);
  for (let index = 0; index <= count; index += 1) {
    ticks.push(Number((first + index * step).toPrecision(12)));
  }
  return ticks;
}

/**
 * The range of values an axis has to cover. Bars and areas grow from zero,
 * so zero is always on their axis. A line keeps zero when it is near.
 */
export function valueRange(model: CartesianModel): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  const count = model.labels.length;
  if (model.stacked) {
    for (let at = 0; at < count; at += 1) {
      let up = 0;
      let down = 0;
      for (const entry of model.series) {
        const value = entry.values[at] ?? 0;
        if (value >= 0) {
          up += value;
        } else {
          down += value;
        }
      }
      min = Math.min(min, down);
      max = Math.max(max, up);
    }
  } else {
    for (const entry of model.series) {
      for (const value of entry.values) {
        if (value !== null) {
          min = Math.min(min, value);
          max = Math.max(max, value);
        }
      }
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return [0, 1];
  }
  const fromZero = model.type === 'bar' || model.type === 'area' || (min >= 0 && min <= max / 2);
  return fromZero ? [Math.min(min, 0), Math.max(max, 0)] : [min, max];
}

/** A value as an axis writes it: in full under ten thousand, and short above. */
export function formatTick(value: number, ticks: number[]): string {
  const reach = Math.max(...ticks.map((tick) => Math.abs(tick)), 0);
  const step = ticks.length > 1 ? Math.abs((ticks[1] ?? 0) - (ticks[0] ?? 0)) : 1;
  if (reach >= 10_000) {
    const units: [number, string][] = [
      [1e12, 'T'],
      [1e9, 'B'],
      [1e6, 'M'],
      [1e3, 'K'],
    ];
    for (const [size, suffix] of units) {
      if (reach >= size) {
        const scaled = value / size;
        const decimals = step / size >= 1 ? 0 : step / size >= 0.1 ? 1 : 2;
        return `${scaled.toFixed(decimals)}${suffix}`;
      }
    }
  }
  const decimals = step >= 1 ? 0 : Math.min(6, Math.ceil(-Math.log10(step)));
  return value.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** A value as a tooltip or a legend writes it: in full. */
export function formatValue(value: number): string {
  const digits = Number.isInteger(value)
    ? 0
    : Math.abs(value) >= 100
      ? 1
      : Math.abs(value) >= 1
        ? 2
        : 4;
  return value.toLocaleString('en-US', { maximumFractionDigits: digits });
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY = 86_400_000;
const two = (value: number) => String(value).padStart(2, '0');

export interface Tick {
  value: number;
  label: string;
}

/** Ticks along a time axis, on years, months, days or hours as the span asks. */
export function timeTicks(min: number, max: number, target = 6): Tick[] {
  const span = Math.max(max - min, 1);
  const first = new Date(min);
  const ticks: Tick[] = [];
  const month = (date: Date) => MONTHS[date.getUTCMonth()] ?? '';

  if (span > 2 * 365 * DAY) {
    const years = span / (365 * DAY);
    const step = Math.max(1, niceStep(years / target));
    for (let year = Math.ceil(first.getUTCFullYear() / step) * step; ; year += step) {
      const value = Date.UTC(year, 0, 1);
      if (value > max) {
        break;
      }
      if (value >= min) {
        ticks.push({ value, label: String(year) });
      }
    }
  } else if (span > 60 * DAY) {
    const months = span / (30.4 * DAY);
    const step = [1, 2, 3, 6, 12].find((candidate) => months / candidate <= target) ?? 12;
    let year = first.getUTCFullYear();
    let index = Math.ceil(first.getUTCMonth() / step) * step;
    for (;;) {
      const value = Date.UTC(year, index, 1);
      if (value > max) {
        break;
      }
      if (value >= min) {
        const date = new Date(value);
        ticks.push({ value, label: `${month(date)} ${date.getUTCFullYear()}` });
      }
      index += step;
      if (index >= 12) {
        year += Math.floor(index / 12);
        index %= 12;
      }
    }
  } else if (span > 2 * DAY) {
    const step = Math.max(1, Math.ceil(span / DAY / target)) * DAY;
    for (let value = Math.ceil(min / DAY) * DAY; value <= max; value += step) {
      const date = new Date(value);
      ticks.push({ value, label: `${date.getUTCDate()} ${month(date)}` });
    }
  } else {
    const hour = 3_600_000;
    const step =
      ([1, 2, 3, 6, 12, 24].find((candidate) => span / hour / candidate <= target) ?? 24) * hour;
    for (let value = Math.ceil(min / step) * step; value <= max; value += step) {
      const date = new Date(value);
      ticks.push({ value, label: `${two(date.getUTCHours())}:${two(date.getUTCMinutes())}` });
    }
  }
  return ticks;
}

/** Text cut to a length, for a label that has to fit a space. */
export function clip(label: string, maxChars: number): string {
  return label.length > maxChars ? `${label.slice(0, Math.max(1, maxChars - 3))}...` : label;
}

/** What a chart is called when the block gave it no title. */
export function chartTitle(spec: ChartSpec): string {
  if (spec.title !== null) {
    return spec.title;
  }
  if (spec.type === 'table') {
    return 'Result';
  }
  const measured = spec.y.join(', ');
  return spec.x === null ? measured : `${measured} by ${spec.x}`;
}
