import { describe, expect, it } from 'vitest';
import {
  MAX_SERIES,
  buildChart,
  chartNumber,
  chartTitle,
  clip,
  columnIndex,
  formatTick,
  formatValue,
  neededColumns,
  niceTicks,
  parseChartSpec,
  parseTime,
  resolveChartData,
  tableView,
  timeTicks,
  valueRange,
  type CartesianModel,
  type ChartData,
  type ChartSpec,
  type PieModel,
} from './chart';

function spec(source: object): ChartSpec {
  const parsed = parseChartSpec(JSON.stringify(source));
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  return parsed.value;
}

function cartesian(source: object, data: ChartData): CartesianModel {
  const built = buildChart(spec(source), data);
  if (!built.ok || built.value.kind !== 'cartesian') {
    throw new Error(built.ok ? 'Not a cartesian chart.' : built.error);
  }
  return built.value;
}

function pie(source: object, data: ChartData): PieModel {
  const built = buildChart(spec(source), data);
  if (!built.ok || built.value.kind !== 'pie') {
    throw new Error(built.ok ? 'Not a pie chart.' : built.error);
  }
  return built.value;
}

const errorOf = (outcome: { ok: true } | { ok: false; error: string }) =>
  outcome.ok ? null : outcome.error;

const MONTHS: ChartData = {
  columns: ['issues_created', 'month'],
  rows: [
    ['1', '2023-01'],
    ['46', '2023-10'],
    ['13', '2026-10'],
  ],
};

describe('parseChartSpec', () => {
  it('reads the block a model is shown as the example', () => {
    expect(
      parseChartSpec(
        '{"type": "bar", "title": "Issues created per month", "x": "month", "y": ["issues_created"]}',
      ),
    ).toEqual({
      ok: true,
      value: {
        type: 'bar',
        title: 'Issues created per month',
        x: 'month',
        y: ['issues_created'],
        series: null,
        columns: null,
        stacked: false,
        horizontal: false,
        xLabel: null,
        yLabel: null,
        data: null,
      },
    });
  });

  it('takes one y column written as text, and the other names a chart goes by', () => {
    expect(spec({ type: 'Line', x: 'day', y: 'n' })).toMatchObject({ type: 'line', y: ['n'] });
    expect(spec({ type: 'column', x: 'a', y: ['b'] }).type).toBe('bar');
    expect(spec({ type: 'donut', x: 'a', y: ['b'] }).type).toBe('pie');
  });

  it('reads the options', () => {
    expect(
      spec({
        type: 'bar',
        x: 'region',
        y: ['n'],
        series: 'state',
        stacked: true,
        horizontal: true,
        xLabel: 'Region',
        yLabel: 'Instances',
      }),
    ).toMatchObject({
      series: 'state',
      stacked: true,
      horizontal: true,
      xLabel: 'Region',
      yLabel: 'Instances',
    });
    // Only true turns an option on.
    expect(spec({ type: 'bar', x: 'a', y: ['b'], stacked: 'yes' }).stacked).toBe(false);
  });

  it('says what is wrong with a block it cannot read', () => {
    expect(errorOf(parseChartSpec('{"type": "bar", '))).toBe('The block is not valid JSON.');
    expect(errorOf(parseChartSpec('[1, 2]'))).toBe('The block must hold one JSON object.');
    expect(errorOf(parseChartSpec('{"type": "radar", "x": "a", "y": ["b"]}'))).toContain('"type"');
    expect(errorOf(parseChartSpec('{"x": "a", "y": ["b"]}'))).toContain('"type"');
    expect(errorOf(parseChartSpec('{"type": "bar", "y": ["b"]}'))).toContain('"x"');
    expect(errorOf(parseChartSpec('{"type": "bar", "x": "a"}'))).toContain('"y"');
    expect(errorOf(parseChartSpec('{"type": "bar", "x": "a", "y": [1]}'))).toContain('"y"');
    expect(errorOf(parseChartSpec('{"type": "bar", "x": "a", "y": []}'))).toContain('"y"');
  });

  it('lets a table name no columns at all', () => {
    expect(spec({ type: 'table' })).toMatchObject({ type: 'table', x: null, y: [], columns: null });
    expect(spec({ type: 'table', columns: ['name', 'region'] }).columns).toEqual([
      'name',
      'region',
    ]);
    expect(errorOf(parseChartSpec('{"type": "table", "columns": "nope, really"}'))).toBeNull();
    expect(errorOf(parseChartSpec('{"type": "table", "columns": [1]}'))).toContain('"columns"');
  });

  it('reads rows written in the block as the text a result set holds', () => {
    const read = spec({
      type: 'bar',
      x: 'month',
      y: ['open', 'closed'],
      data: [
        { month: '2026-01', open: 3, closed: 5 },
        { month: '2026-02', open: 4, extra: { nested: true } },
      ],
    });
    expect(read.data).toEqual({
      columns: ['month', 'open', 'closed', 'extra'],
      rows: [
        ['2026-01', '3', '5', null],
        ['2026-02', '4', null, '{"nested":true}'],
      ],
    });
  });

  it('also reads rows written as columns and rows', () => {
    const read = spec({
      type: 'line',
      x: 'd',
      y: ['n'],
      data: {
        columns: ['d', 'n'],
        rows: [
          ['2026-01-01', 2],
          ['2026-01-02', null, 'ignored'],
        ],
      },
    });
    expect(read.data).toEqual({
      columns: ['d', 'n'],
      rows: [
        ['2026-01-01', '2'],
        ['2026-01-02', null],
      ],
    });
  });

  it('refuses data that is not rows', () => {
    expect(errorOf(parseChartSpec('{"type":"bar","x":"a","y":["b"],"data":"a,b"}'))).toContain(
      '"data"',
    );
    expect(errorOf(parseChartSpec('{"type":"bar","x":"a","y":["b"],"data":[1,2]}'))).toContain(
      '"data"',
    );
    expect(
      errorOf(parseChartSpec('{"type":"bar","x":"a","y":["b"],"data":{"rows":[]}}')),
    ).toContain('"data"');
  });
});

describe('resolveChartData', () => {
  const providers: ChartData = { columns: ['name', 'version'], rows: [['github', 'v1']] };
  const older: ChartData = { columns: ['month', 'issues_created'], rows: [['2020-01', '9']] };

  it('draws from the most recent result set that has the columns', () => {
    const chart = spec({ type: 'bar', x: 'month', y: ['issues_created'] });
    const resolved = resolveChartData(chart, [older, MONTHS, providers]);
    expect(resolved).toEqual({ ok: true, value: { data: MONTHS, from: 1 } });
  });

  it('matches a column whatever its case, and prefers the name as written', () => {
    expect(columnIndex(['Month', 'month'], 'month')).toBe(1);
    expect(columnIndex(['Month'], 'month')).toBe(0);
    expect(columnIndex(['Month'], 'year')).toBe(-1);
    const chart = spec({ type: 'bar', x: 'MONTH', y: ['Issues_Created'] });
    expect(resolveChartData(chart, [MONTHS])).toMatchObject({ ok: true, value: { from: 0 } });
  });

  it('prefers rows written in the block', () => {
    const chart = spec({ type: 'bar', x: 'month', y: ['n'], data: [{ month: '2026-01', n: 1 }] });
    const resolved = resolveChartData(chart, [MONTHS]);
    expect(resolved.ok && resolved.value.from).toBeNull();
    expect(resolved.ok && resolved.value.data.rows).toEqual([['2026-01', '1']]);
  });

  it('says which columns it could not find', () => {
    const chart = spec({ type: 'bar', x: 'week', y: ['issues_created'] });
    expect(errorOf(resolveChartData(chart, [MONTHS]))).toBe(
      'No result set in this conversation has the columns "week", "issues_created".',
    );
    expect(errorOf(resolveChartData(chart, []))).toBe(
      'There is no result set in this conversation to draw from.',
    );
    const inline = spec({ type: 'bar', x: 'week', y: ['n'], data: [{ month: 'x', n: 1 }] });
    expect(errorOf(resolveChartData(inline, [MONTHS]))).toBe(
      'The data in the block has no column "week".',
    );
  });

  it('gives a table with no columns named the latest result set', () => {
    const resolved = resolveChartData(spec({ type: 'table' }), [MONTHS, providers]);
    expect(resolved).toEqual({ ok: true, value: { data: providers, from: 1 } });
    expect(neededColumns(spec({ type: 'table' }))).toEqual([]);
    expect(neededColumns(spec({ type: 'bar', x: 'a', y: ['b', 'a'], series: 'c' }))).toEqual([
      'a',
      'b',
      'c',
    ]);
  });
});

describe('tableView', () => {
  it('shows the columns a table block asks for, in its order', () => {
    const view = tableView(
      spec({ type: 'table', columns: ['Month', 'nope', 'issues_created'] }),
      MONTHS,
    );
    expect(view.columns).toEqual(['month', 'issues_created']);
    expect(view.rows[1]).toEqual(['2023-10', '46']);
  });

  it('shows everything otherwise', () => {
    expect(tableView(spec({ type: 'table' }), MONTHS)).toBe(MONTHS);
    expect(tableView(spec({ type: 'bar', x: 'month', y: ['issues_created'] }), MONTHS)).toBe(
      MONTHS,
    );
  });
});

describe('chartNumber and parseTime', () => {
  it('reads the numbers a result set holds as text', () => {
    expect(chartNumber('46')).toBe(46);
    expect(chartNumber('1,234,567.5')).toBe(1234567.5);
    expect(chartNumber('45%')).toBe(45);
    expect(chartNumber(' 3.5 ')).toBe(3.5);
    expect(chartNumber('1,23')).toBeNull();
    expect(chartNumber('n/a')).toBeNull();
    expect(chartNumber('')).toBeNull();
    expect(chartNumber(null)).toBeNull();
  });

  it('reads years, months, days and moments, in UTC', () => {
    expect(parseTime('2026')).toBe(Date.UTC(2026, 0, 1));
    expect(parseTime('2026-11')).toBe(Date.UTC(2026, 10, 1));
    expect(parseTime('2026-11-16')).toBe(Date.UTC(2026, 10, 16));
    expect(parseTime('2026-11-16T01:40:36Z')).toBe(Date.UTC(2026, 10, 16, 1, 40, 36));
    expect(parseTime('2026-11-16 01:40')).toBe(Date.UTC(2026, 10, 16, 1, 40));
    expect(parseTime('2026-11-16T01:40:36+11:00')).toBe(Date.UTC(2026, 10, 15, 14, 40, 36));
  });

  it('does not take other things for a time', () => {
    for (const value of ['8080', '1500', '2026-13', '2026-00-10', 'November', '', '26-11-2026']) {
      expect(parseTime(value), value).toBeNull();
    }
    expect(parseTime(null)).toBeNull();
  });
});

describe('a bar chart', () => {
  it('draws one bar for each row, in the order of the rows', () => {
    const model = cartesian({ type: 'bar', x: 'month', y: ['issues_created'] }, MONTHS);
    expect(model).toMatchObject({
      type: 'bar',
      xKind: 'category',
      positions: null,
      labels: ['2023-01', '2023-10', '2026-10'],
      series: [{ name: 'issues_created', values: [1, 46, 13] }],
      stacked: false,
      horizontal: false,
      notes: [],
    });
  });

  it('draws one series for each y column', () => {
    const model = cartesian(
      { type: 'bar', x: 'region', y: ['running', 'stopped'], stacked: true },
      {
        columns: ['region', 'running', 'stopped'],
        rows: [
          ['us-east-1', '12', '3'],
          ['eu-west-1', '4', null],
        ],
      },
    );
    expect(model.series).toEqual([
      { name: 'running', values: [12, 4] },
      { name: 'stopped', values: [3, null] },
    ]);
    expect(model.stacked).toBe(true);
  });

  it('does not stack one series', () => {
    const model = cartesian(
      { type: 'bar', x: 'month', y: ['issues_created'], stacked: true },
      MONTHS,
    );
    expect(model.stacked).toBe(false);
  });

  it('turns rows that carry a series name into one series for each name', () => {
    const model = cartesian(
      { type: 'bar', x: 'month', y: ['n'], series: 'state' },
      {
        columns: ['month', 'state', 'n'],
        rows: [
          ['2026-10', 'open', '13'],
          ['2026-10', 'closed', '20'],
          ['2026-11', 'open', '8'],
          // Rows that share a point are added together.
          ['2026-10', 'open', '2'],
        ],
      },
    );
    expect(model.labels).toEqual(['2026-10', '2026-11']);
    expect(model.series).toEqual([
      { name: 'open', values: [15, 8] },
      { name: 'closed', values: [20, null] },
    ]);
  });

  it('says what it left out', () => {
    const model = cartesian(
      { type: 'bar', x: 'name', y: ['size'] },
      {
        columns: ['name', 'size'],
        rows: [
          ['a', '10'],
          ['b', 'unknown'],
          ['c', ''],
          ['d', null],
        ],
      },
    );
    expect(model.series[0]?.values).toEqual([10, null, null, null]);
    expect(model.notes).toEqual(['1 value that is not a number was left out.']);
  });

  it('keeps the largest series and adds the rest together when there are too many', () => {
    const names = Array.from({ length: 12 }, (_, index) => `s${index + 1}`);
    const model = cartesian(
      { type: 'bar', x: 'x', y: names },
      { columns: ['x', ...names], rows: [['only', ...names.map((_, index) => String(index + 1))]] },
    );
    expect(model.series).toHaveLength(MAX_SERIES);
    expect(model.series.map((entry) => entry.name)).toEqual([
      's6',
      's7',
      's8',
      's9',
      's10',
      's11',
      's12',
      'Other',
    ]);
    // 1 + 2 + 3 + 4 + 5
    expect(model.series[MAX_SERIES - 1]?.values).toEqual([15]);
    expect(model.notes[0]).toContain('7 largest of 12 series');
  });

  it('draws no more bars than can be told apart', () => {
    const rows = Array.from({ length: 250 }, (_, index) => [`c${index}`, String(index)]);
    const model = cartesian({ type: 'bar', x: 'c', y: ['n'] }, { columns: ['c', 'n'], rows });
    expect(model.labels).toHaveLength(200);
    expect(model.notes).toEqual(['Showing the first 200 of 250 points.']);
    // Bars that lie down take a row each, so fewer are drawn.
    const down = cartesian(
      { type: 'bar', x: 'c', y: ['n'], horizontal: true },
      { columns: ['c', 'n'], rows },
    );
    expect(down.labels).toHaveLength(25);
    expect(down.notes).toEqual(['Showing the first 25 of 250 points.']);
  });
});

describe('a line chart', () => {
  it('places dates where they fall in time, in order', () => {
    const model = cartesian(
      { type: 'line', x: 'month', y: ['issues_created'] },
      {
        columns: ['month', 'issues_created'],
        rows: [
          ['2026-10', '13'],
          ['2023-01', '1'],
          ['2023-10', '46'],
        ],
      },
    );
    expect(model.xKind).toBe('time');
    expect(model.labels).toEqual(['2023-01', '2023-10', '2026-10']);
    expect(model.positions).toEqual([
      Date.UTC(2023, 0, 1),
      Date.UTC(2023, 9, 1),
      Date.UTC(2026, 9, 1),
    ]);
    expect(model.series[0]?.values).toEqual([1, 46, 13]);
  });

  it('places numbers where they fall on a scale', () => {
    const model = cartesian(
      { type: 'scatter', x: 'cpu', y: ['cost'] },
      {
        columns: ['cpu', 'cost'],
        rows: [
          ['8', '0.4'],
          ['2', '0.1'],
        ],
      },
    );
    expect(model.xKind).toBe('number');
    expect(model.positions).toEqual([2, 8]);
    expect(model.series[0]?.values).toEqual([0.1, 0.4]);
  });

  it('spaces names evenly when x is neither', () => {
    const model = cartesian(
      { type: 'area', x: 'region', y: ['n'] },
      {
        columns: ['region', 'n'],
        rows: [
          ['us', '1'],
          ['eu', '2'],
        ],
      },
    );
    expect(model.xKind).toBe('category');
    expect(model.positions).toBeNull();
    expect(model.labels).toEqual(['us', 'eu']);
  });

  it('keeps each row of a scatter chart as a point of its own series', () => {
    const model = cartesian(
      { type: 'scatter', x: 'cpu', y: ['cost'], series: 'family' },
      {
        columns: ['cpu', 'cost', 'family'],
        rows: [
          ['2', '0.1', 'm'],
          ['2', '0.2', 'c'],
          ['4', '0.3', 'm'],
        ],
      },
    );
    expect(model.positions).toEqual([2, 2, 4]);
    expect(model.series).toEqual([
      { name: 'm', values: [0.1, null, 0.3] },
      { name: 'c', values: [null, 0.2, null] },
    ]);
  });
});

describe('a pie chart', () => {
  it('adds up the rows of each part', () => {
    const model = pie(
      { type: 'pie', x: 'state', y: ['n'] },
      {
        columns: ['state', 'n'],
        rows: [
          ['open', '97'],
          ['closed', '300'],
          ['open', '3'],
        ],
      },
    );
    expect(model.slices).toEqual([
      { name: 'open', value: 100 },
      { name: 'closed', value: 300 },
    ]);
    expect(model.total).toBe(400);
    expect(model.valueName).toBe('n');
  });

  it('leaves out what is not above zero, and says so', () => {
    const model = pie(
      { type: 'pie', x: 'k', y: ['n'] },
      {
        columns: ['k', 'n'],
        rows: [
          ['a', '5'],
          ['b', '0'],
          ['c', '-2'],
          ['d', 'x'],
        ],
      },
    );
    expect(model.slices).toEqual([{ name: 'a', value: 5 }]);
    expect(model.notes).toEqual(['3 rows with no amount above zero were left out.']);
  });

  it('keeps the largest parts and adds the rest together', () => {
    const rows = Array.from({ length: 10 }, (_, index) => [`p${index + 1}`, String(index + 1)]);
    const model = pie({ type: 'pie', x: 'p', y: ['n'] }, { columns: ['p', 'n'], rows });
    expect(model.slices.map((slice) => slice.name)).toEqual([
      'p10',
      'p9',
      'p8',
      'p7',
      'p6',
      'p5',
      'p4',
      'Other',
    ]);
    // 1 + 2 + 3
    expect(model.slices[7]?.value).toBe(6);
    expect(model.total).toBe(55);
  });
});

describe('a chart with nothing to draw', () => {
  it('says so in place of an empty frame', () => {
    const bars = spec({ type: 'bar', x: 'month', y: ['issues_created'] });
    expect(errorOf(buildChart(bars, { columns: MONTHS.columns, rows: [] }))).toBe(
      'There is nothing to draw: the result set has no rows.',
    );
    expect(
      errorOf(buildChart(bars, { columns: MONTHS.columns, rows: [['many', '2023-01']] })),
    ).toBe('There is nothing to draw: "issues_created" holds no numbers.');
    expect(
      errorOf(
        buildChart(spec({ type: 'pie', x: 'month', y: ['issues_created'] }), {
          columns: MONTHS.columns,
          rows: [['0', '2023-01']],
        }),
      ),
    ).toContain('no amounts above zero');
    expect(errorOf(buildChart(spec({ type: 'table' }), MONTHS))).toBe('A table is not a chart.');
  });
});

describe('niceTicks', () => {
  it('covers the range with round values', () => {
    expect(niceTicks(0, 46)).toEqual([0, 10, 20, 30, 40, 50]);
    expect(niceTicks(0, 97)).toEqual([0, 20, 40, 60, 80, 100]);
    expect(niceTicks(-3, 7)).toEqual([-4, -2, 0, 2, 4, 6, 8]);
    expect(niceTicks(0, 1234567)).toEqual([0, 500000, 1000000, 1500000]);
  });

  it('does not drift on small steps', () => {
    expect(niceTicks(0, 0.5)).toEqual([0, 0.1, 0.2, 0.3, 0.4, 0.5]);
  });

  it('still makes an axis for one value, or none', () => {
    expect(niceTicks(0, 0)).toEqual([0, 1]);
    expect(niceTicks(8, 8)).toEqual([0, 2, 4, 6, 8]);
    expect(niceTicks(-8, -8)).toEqual([-8, -6, -4, -2, 0]);
    expect(niceTicks(NaN, 3)).toEqual([0, 1]);
  });
});

describe('valueRange', () => {
  const model = (type: CartesianModel['type'], values: (number | null)[][], stacked = false) =>
    ({
      kind: 'cartesian',
      type,
      labels: values[0]?.map((_, index) => String(index)) ?? [],
      positions: null,
      xKind: 'category',
      series: values.map((entries, index) => ({ name: `s${index}`, values: entries })),
      stacked,
      horizontal: false,
      notes: [],
    }) satisfies CartesianModel;

  it('starts bars and areas at zero', () => {
    expect(valueRange(model('bar', [[40, 46]]))).toEqual([0, 46]);
    expect(valueRange(model('area', [[40, 46]]))).toEqual([0, 46]);
    expect(valueRange(model('bar', [[-5, 3]]))).toEqual([-5, 3]);
  });

  it('keeps zero on a line only when it is near', () => {
    expect(valueRange(model('line', [[10, 46]]))).toEqual([0, 46]);
    expect(valueRange(model('line', [[990, 1010]]))).toEqual([990, 1010]);
  });

  it('adds stacked values up, above and below zero apart', () => {
    expect(
      valueRange(
        model(
          'bar',
          [
            [10, -2],
            [5, -3],
          ],
          true,
        ),
      ),
    ).toEqual([-5, 15]);
  });

  it('copes with nothing but gaps', () => {
    expect(valueRange(model('line', [[null, null]]))).toEqual([0, 1]);
  });
});

describe('formatTick and formatValue', () => {
  it('writes an axis in full under ten thousand', () => {
    const ticks = [0, 2000, 4000, 6000, 8000];
    expect(ticks.map((tick) => formatTick(tick, ticks))).toEqual([
      '0',
      '2,000',
      '4,000',
      '6,000',
      '8,000',
    ]);
  });

  it('writes an axis short once it reaches ten thousand, one style for the whole axis', () => {
    const thousands = [0, 5000, 10000, 15000];
    expect(thousands.map((tick) => formatTick(tick, thousands))).toEqual([
      '0K',
      '5K',
      '10K',
      '15K',
    ]);
    const millions = [0, 500000, 1000000, 1500000];
    expect(millions.map((tick) => formatTick(tick, millions))).toEqual([
      '0.0M',
      '0.5M',
      '1.0M',
      '1.5M',
    ]);
  });

  it('keeps the decimals a small step needs', () => {
    const tenths = niceTicks(0, 0.5);
    expect(tenths.map((tick) => formatTick(tick, tenths))).toEqual([
      '0.0',
      '0.1',
      '0.2',
      '0.3',
      '0.4',
      '0.5',
    ]);
    const hundredths = [0, 0.05, 0.1];
    expect(hundredths.map((tick) => formatTick(tick, hundredths))).toEqual([
      '0.00',
      '0.05',
      '0.10',
    ]);
  });

  it('writes a value in full for a tooltip', () => {
    expect(formatValue(1234567)).toBe('1,234,567');
    expect(formatValue(1234.5678)).toBe('1,234.6');
    expect(formatValue(3.14159)).toBe('3.14');
    expect(formatValue(0.012345)).toBe('0.0123');
  });
});

describe('timeTicks', () => {
  const labels = (min: number, max: number) => timeTicks(min, max).map((tick) => tick.label);

  it('marks years over a span of years', () => {
    expect(labels(Date.UTC(2023, 0, 1), Date.UTC(2026, 10, 1))).toEqual([
      '2023',
      '2024',
      '2025',
      '2026',
    ]);
  });

  it('marks months over a span of months, counted from January', () => {
    expect(labels(Date.UTC(2026, 0, 15), Date.UTC(2026, 10, 1))).toEqual([
      'Mar 2026',
      'May 2026',
      'Jul 2026',
      'Sep 2026',
      'Nov 2026',
    ]);
  });

  it('marks days over a span of days, and hours within a day', () => {
    expect(labels(Date.UTC(2026, 10, 10), Date.UTC(2026, 10, 16))).toEqual([
      '10 Nov',
      '11 Nov',
      '12 Nov',
      '13 Nov',
      '14 Nov',
      '15 Nov',
      '16 Nov',
    ]);
    expect(labels(Date.UTC(2026, 10, 16, 0), Date.UTC(2026, 10, 16, 12))).toEqual([
      '00:00',
      '02:00',
      '04:00',
      '06:00',
      '08:00',
      '10:00',
      '12:00',
    ]);
  });

  it('keeps every tick inside the span', () => {
    const min = Date.UTC(2024, 5, 20);
    const max = Date.UTC(2025, 1, 3);
    for (const tick of timeTicks(min, max)) {
      expect(tick.value).toBeGreaterThanOrEqual(min);
      expect(tick.value).toBeLessThanOrEqual(max);
    }
  });
});

describe('clip and chartTitle', () => {
  it('cuts a label to fit', () => {
    expect(clip('us-east-1', 20)).toBe('us-east-1');
    expect(clip('a-very-long-resource-name', 12)).toBe('a-very-lo...');
  });

  it('names a chart after its columns when the block gave no title', () => {
    expect(chartTitle(spec({ type: 'bar', x: 'month', y: ['open', 'closed'] }))).toBe(
      'open, closed by month',
    );
    expect(chartTitle(spec({ type: 'bar', title: 'Velocity', x: 'month', y: ['n'] }))).toBe(
      'Velocity',
    );
    expect(chartTitle(spec({ type: 'table' }))).toBe('Result');
  });
});
