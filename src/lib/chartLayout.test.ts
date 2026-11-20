import { describe, expect, it } from 'vitest';
import type { CartesianModel, PieModel } from './chart';
import {
  CHART_HEIGHT,
  barPath,
  formatShare,
  layoutCartesian,
  layoutPie,
  nearestPoint,
  nearestPosition,
} from './chartLayout';

const UNTITLED = { x: false, y: false };

function model(over: Partial<CartesianModel> & Pick<CartesianModel, 'series'>): CartesianModel {
  const count = over.series[0]?.values.length ?? 0;
  return {
    kind: 'cartesian',
    type: 'bar',
    labels: Array.from({ length: count }, (_, index) => `c${index + 1}`),
    positions: null,
    xKind: 'category',
    stacked: false,
    horizontal: false,
    notes: [],
    ...over,
  };
}

/** The box a path covers: the least and the most of its x and y. */
function box(path: string) {
  const numbers = [...path.matchAll(/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g)];
  const xs = numbers.map((match) => Number(match[1]));
  const ys = numbers.map((match) => Number(match[2]));
  return {
    left: Math.min(...xs),
    right: Math.max(...xs),
    top: Math.min(...ys),
    bottom: Math.max(...ys),
  };
}

describe('barPath', () => {
  it('rounds the end away from the baseline and leaves the other square', () => {
    const up = barPath(10, 20, 16, 100, 'top');
    expect(up.startsWith('M10,120L10,24Q10,20 14,20')).toBe(true);
    expect(up.endsWith('L26,120Z')).toBe(true);
    const across = barPath(0, 0, 100, 16, 'right');
    expect(across.startsWith('M0,0L96,0Q100,0 100,4')).toBe(true);
  });

  it('never rounds more than the bar is long or half as thick', () => {
    // Two pixels of bar cannot carry a four pixel corner.
    expect(barPath(0, 0, 16, 2, 'top')).toContain('Q0,0 2,0');
    expect(barPath(0, 0, 4, 50, 'top')).toContain('Q0,0 2,0');
  });
});

describe('bars that stand up', () => {
  const layout = layoutCartesian(
    model({ series: [{ name: 'n', values: [10, 40, 0, null] }] }),
    600,
    UNTITLED,
  );

  it('fit the frame, with room for the axes', () => {
    const { frame } = layout;
    expect(frame.width).toBe(600);
    expect(frame.height).toBe(CHART_HEIGHT);
    expect(frame.left + frame.plotWidth).toBeLessThanOrEqual(600);
    expect(frame.top + frame.plotHeight).toBeLessThan(CHART_HEIGHT);
    expect(layout.horizontal).toBe(false);
  });

  it('grow from the baseline, in proportion to their values', () => {
    // No bar for a gap in the data.
    expect(layout.bars.map((bar) => bar.index)).toEqual([0, 1, 2]);
    const [small, large] = layout.bars.map((bar) => box(bar.path));
    if (!small || !large) {
      throw new Error('Two bars were expected.');
    }
    expect(small.bottom).toBeCloseTo(layout.zero, 1);
    expect(large.bottom).toBeCloseTo(layout.zero, 1);
    expect((large.bottom - large.top) / (small.bottom - small.top)).toBeCloseTo(4, 1);
  });

  it('are never thicker than 24 pixels, however much room there is', () => {
    for (const bar of layout.bars) {
      const { left, right } = box(bar.path);
      expect(right - left).toBeLessThanOrEqual(24.01);
    }
  });

  it('have an axis of round values that covers them', () => {
    expect(layout.valueTicks.map((tick) => tick.label)).toEqual(['0', '10', '20', '30', '40']);
    // More is higher up, which is a smaller y.
    expect(layout.valueTicks[4]?.at).toBeLessThan(layout.valueTicks[0]?.at ?? 0);
    expect(layout.zero).toBeCloseTo(layout.valueTicks[0]?.at ?? -1, 5);
  });

  it('name every position when the names fit', () => {
    expect(layout.bandTicks.map((tick) => tick.label)).toEqual(['c1', 'c2', 'c3', 'c4']);
  });

  it('cut long names short before leaving any position unnamed', () => {
    const names = [
      'stackql',
      'stackql-provider-registry',
      'psql-wire',
      'stackql-actions-demo',
      'pystackql',
      'stackql-middleware',
      'stackql-jupyter-demo',
      'stackql-registry-docs',
    ];
    const named = layoutCartesian(
      model({ labels: names, series: [{ name: 'stars', values: names.map((_, index) => index) }] }),
      800,
      UNTITLED,
    );
    expect(named.bandTicks).toHaveLength(names.length);
    expect(named.bandTicks[0]?.label).toBe('stackql');
    expect(named.bandTicks[1]?.label).toMatch(/^stackql-pr.*\.\.\.$/);
    // No name is wider than the room under its bar.
    for (const tick of named.bandTicks) {
      expect(tick.label.length * 6.2).toBeLessThanOrEqual(named.band);
    }
  });

  it('name every few positions when they do not', () => {
    const many = Array.from({ length: 60 }, (_, index) => index);
    const crowded = layoutCartesian(
      model({
        labels: many.map((index) => `2026-11-${String(index).padStart(2, '0')}`),
        series: [{ name: 'n', values: many }],
      }),
      600,
      UNTITLED,
    );
    expect(crowded.bandTicks.length).toBeLessThan(20);
    expect(crowded.bandTicks[0]?.label).toBe('2026-11-00');
    // Labels are far enough apart to be read.
    const [first, second] = crowded.bandTicks;
    expect((second?.at ?? 0) - (first?.at ?? 0)).toBeGreaterThan(60);
  });
});

describe('bars side by side and stacked', () => {
  const series = [
    { name: 'open', values: [10, 5] },
    { name: 'closed', values: [20, -5] },
  ];

  it('are kept apart by a gap, not by an outline', () => {
    const layout = layoutCartesian(model({ series }), 600, UNTITLED);
    const first = layout.bars.find((bar) => bar.series === 0 && bar.index === 0);
    const second = layout.bars.find((bar) => bar.series === 1 && bar.index === 0);
    if (!first || !second) {
      throw new Error('Two bars were expected.');
    }
    expect(box(second.path).left - box(first.path).right).toBeCloseTo(2, 1);
  });

  it('stack above zero and below it apart, with a gap between segments', () => {
    const layout = layoutCartesian(model({ series, stacked: true }), 600, UNTITLED);
    const at = (seriesIndex: number, index: number) => {
      const bar = layout.bars.find((b) => b.series === seriesIndex && b.index === index);
      if (!bar) {
        throw new Error('A bar is missing.');
      }
      return box(bar.path);
    };
    // The second segment sits on the first, two pixels clear of it.
    expect(at(0, 0).bottom).toBeCloseTo(layout.zero, 1);
    expect(at(0, 0).top - at(1, 0).bottom).toBeCloseTo(2, 1);
    // A value below zero hangs from the baseline.
    expect(at(1, 1).top).toBeCloseTo(layout.zero, 1);
    expect(at(0, 1).bottom).toBeCloseTo(layout.zero, 1);
    // The axis covers the stack, not only the largest value.
    expect(layout.valueTicks[layout.valueTicks.length - 1]?.label).toBe('30');
  });
});

describe('bars that lie down', () => {
  const layout = layoutCartesian(
    model({
      labels: ['a-long-bucket-name', 'b', 'c'],
      series: [{ name: 'size', values: [300, 150, 50] }],
      horizontal: true,
    }),
    600,
    UNTITLED,
  );

  it('grow to the right from the baseline', () => {
    const [longest, shorter] = layout.bars.map((bar) => box(bar.path));
    if (!longest || !shorter) {
      throw new Error('Bars were expected.');
    }
    expect(layout.horizontal).toBe(true);
    expect(longest.left).toBeCloseTo(layout.zero, 1);
    expect((longest.right - longest.left) / (shorter.right - shorter.left)).toBeCloseTo(2, 1);
  });

  it('are as tall as their rows need, and leave room for the names', () => {
    expect(layout.frame.height).toBeLessThan(CHART_HEIGHT);
    expect(layout.frame.left).toBeGreaterThan('a-long-bucket-name'.length * 6);
    expect(layout.bandTicks.map((tick) => tick.label)).toEqual(['a-long-bucket-name', 'b', 'c']);
    // One below the other.
    expect(layout.centres[1]).toBeGreaterThan(layout.centres[0] ?? 0);
  });
});

describe('lines', () => {
  const months = [Date.UTC(2023, 0, 1), Date.UTC(2023, 9, 1), Date.UTC(2026, 9, 1)];
  const line = model({
    type: 'line',
    labels: ['2023-01', '2023-10', '2026-10'],
    positions: months,
    xKind: 'time',
    series: [{ name: 'n', values: [1, 46, 13] }],
  });
  const layout = layoutCartesian(line, 700, UNTITLED);

  it('place a date where it falls in time, not one step after the last', () => {
    const [first, second, third] = layout.centres;
    if (first === undefined || second === undefined || third === undefined) {
      throw new Error('Three positions were expected.');
    }
    // Nine months, then three years.
    expect((third - second) / (second - first)).toBeCloseTo(4, 0);
    expect(layout.band).toBe(0);
    expect(layout.bandTicks.map((tick) => tick.label)).toEqual(['2023', '2024', '2025', '2026']);
  });

  it('draw one path through the points, and no wash under it', () => {
    const [mark] = layout.lines;
    expect(mark?.path.startsWith('M')).toBe(true);
    expect(mark?.path.match(/L/g)).toHaveLength(2);
    expect(mark?.area).toBeNull();
    expect(mark?.points.map((point) => point.value)).toEqual([1, 46, 13]);
    expect(layout.bars).toEqual([]);
  });

  it('break the line at a gap in the data', () => {
    const gapped = layoutCartesian(
      model({ type: 'line', series: [{ name: 'n', values: [1, null, 3, 4] }] }),
      600,
      UNTITLED,
    );
    expect(gapped.lines[0]?.path.match(/M/g)).toHaveLength(2);
    expect(gapped.lines[0]?.points).toHaveLength(3);
  });

  it('close an area down to the baseline', () => {
    const area = layoutCartesian({ ...line, type: 'area' }, 700, UNTITLED);
    expect(area.lines[0]?.area?.endsWith('Z')).toBe(true);
    expect(area.lines[0]?.area).toContain(`,${Number(area.zero.toFixed(2))}Z`);
  });

  it('draw loose points with no line between them', () => {
    const scatter = layoutCartesian(
      model({
        type: 'scatter',
        positions: [2, 8],
        xKind: 'number',
        series: [{ name: 'cost', values: [0.1, 0.4] }],
      }),
      600,
      UNTITLED,
    );
    expect(scatter.lines[0]?.path).toBe('');
    expect(scatter.lines[0]?.points).toHaveLength(2);
    expect(scatter.bandTicks.map((tick) => tick.label)).toEqual([
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
    ]);
    // The ends of the axis are the least and the most of the data.
    expect(scatter.bandTicks[0]?.at).toBeCloseTo(scatter.centres[0] ?? -1, 5);
    expect(scatter.bandTicks[6]?.at).toBeCloseTo(scatter.centres[1] ?? -1, 5);
  });

  it('still draw one point alone', () => {
    const one = layoutCartesian(
      model({
        type: 'line',
        labels: ['2026-11'],
        positions: [Date.UTC(2026, 10, 1)],
        xKind: 'time',
        series: [{ name: 'n', values: [8] }],
      }),
      600,
      UNTITLED,
    );
    const { frame } = one;
    expect(one.centres[0]).toBeCloseTo(frame.left + frame.plotWidth / 2, 5);
    expect(one.bandTicks).toHaveLength(1);
    expect(one.lines[0]?.points).toHaveLength(1);
  });
});

describe('axis titles', () => {
  it('take room from the plot', () => {
    const bars = model({ series: [{ name: 'n', values: [1, 2] }] });
    const plain = layoutCartesian(bars, 600, UNTITLED);
    const titled = layoutCartesian(bars, 600, { x: true, y: true });
    expect(titled.frame.left).toBeGreaterThan(plain.frame.left);
    expect(titled.frame.plotHeight).toBeLessThan(plain.frame.plotHeight);
  });
});

describe('finding what is under the pointer', () => {
  const layout = layoutCartesian(
    model({ type: 'line', series: [{ name: 'n', values: [1, 2, 3] }] }),
    600,
    UNTITLED,
  );

  it('takes the nearest position along the axis', () => {
    expect(nearestPosition(layout, layout.centres[0] ?? 0)).toBe(0);
    expect(nearestPosition(layout, (layout.centres[2] ?? 0) + 500)).toBe(2);
    expect(
      nearestPosition(layout, ((layout.centres[0] ?? 0) + (layout.centres[1] ?? 0)) / 2 + 1),
    ).toBe(1);
    expect(nearestPosition({ ...layout, centres: [] }, 10)).toBeNull();
  });

  it('takes the nearest point, wherever in the plot the pointer is', () => {
    const target = layout.lines[0]?.points[1];
    const hit = nearestPoint(layout, (target?.x ?? 0) + 3, (target?.y ?? 0) - 3);
    expect(hit?.series).toBe(0);
    expect(hit?.point.index).toBe(1);
    expect(nearestPoint({ ...layout, lines: [] }, 0, 0)).toBeNull();
  });
});

describe('layoutPie', () => {
  const pie: PieModel = {
    kind: 'pie',
    slices: [
      { name: 'open', value: 100 },
      { name: 'closed', value: 300 },
    ],
    total: 400,
    valueName: 'n',
    notes: [],
  };

  it('gives each part its share of the ring', () => {
    const layout = layoutPie(pie, 200);
    expect(layout.size).toBe(200);
    expect(layout.slices.map((slice) => slice.share)).toEqual([0.25, 0.75]);
    // The first part starts at the top, in the middle of the box.
    expect(layout.slices[0]?.path.startsWith('M100,2A')).toBe(true);
    // More than half the ring is the long way round.
    expect(layout.slices[0]?.path).toContain(' 0 0 1 ');
    expect(layout.slices[1]?.path).toContain(' 0 1 1 ');
  });

  it('draws a part that is the whole ring', () => {
    const whole = layoutPie({ ...pie, slices: [{ name: 'all', value: 5 }], total: 5 });
    expect(whole.slices).toHaveLength(1);
    expect(whole.slices[0]?.share).toBe(1);
    // Two halves, since an arc cannot end where it starts.
    expect(whole.slices[0]?.path.match(/Z/g)).toHaveLength(2);
  });
});

describe('formatShare', () => {
  it('keeps a decimal only where it says something', () => {
    expect(formatShare(0.25)).toBe('25%');
    expect(formatShare(0.0244)).toBe('2.4%');
    expect(formatShare(1)).toBe('100%');
    expect(formatShare(0)).toBe('0%');
  });
});
