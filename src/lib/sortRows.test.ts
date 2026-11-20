import { describe, expect, it } from 'vitest';
import type { Row } from '../host/types';
import { cellNumber, nextSort, sortRows } from './sortRows';

const column = (rows: Row[], index = 0) => rows.map((row) => row[index]);

describe('nextSort', () => {
  it('goes ascending, descending, then back to the order of arrival', () => {
    const first = nextSort(null, 2);
    expect(first).toEqual({ column: 2, direction: 'asc' });
    const second = nextSort(first, 2);
    expect(second).toEqual({ column: 2, direction: 'desc' });
    expect(nextSort(second, 2)).toBeNull();
  });

  it('starts again on another column', () => {
    expect(nextSort({ column: 2, direction: 'desc' }, 0)).toEqual({ column: 0, direction: 'asc' });
  });
});

describe('cellNumber', () => {
  it('reads numbers and nothing else', () => {
    expect(cellNumber('42')).toBe(42);
    expect(cellNumber(' -3.5 ')).toBe(-3.5);
    expect(cellNumber('1e3')).toBe(1000);
    expect(cellNumber('.5')).toBe(0.5);
    expect(cellNumber('')).toBeNull();
    expect(cellNumber(null)).toBeNull();
    expect(cellNumber('2026-11')).toBeNull();
    expect(cellNumber('0x10')).toBeNull();
    expect(cellNumber('true')).toBeNull();
    expect(cellNumber('Infinity')).toBeNull();
  });
});

describe('sortRows', () => {
  const rows: Row[] = [['10'], ['9'], ['100'], ['-1']];

  it('returns the rows as they are when no sort is set', () => {
    expect(sortRows(rows, null)).toBe(rows);
  });

  it('orders numbers by size, not as text', () => {
    expect(column(sortRows(rows, { column: 0, direction: 'asc' }))).toEqual([
      '-1',
      '9',
      '10',
      '100',
    ]);
    expect(column(sortRows(rows, { column: 0, direction: 'desc' }))).toEqual([
      '100',
      '10',
      '9',
      '-1',
    ]);
  });

  it('does not change the rows it was given', () => {
    sortRows(rows, { column: 0, direction: 'asc' });
    expect(column(rows)).toEqual(['10', '9', '100', '-1']);
  });

  it('orders words without regard to case, and digits inside them by size', () => {
    const names: Row[] = [['vm-10'], ['Vm-2'], ['alpha'], ['Beta']];
    expect(column(sortRows(names, { column: 0, direction: 'asc' }))).toEqual([
      'alpha',
      'Beta',
      'Vm-2',
      'vm-10',
    ]);
  });

  it('orders dates written the ISO way', () => {
    const dates: Row[] = [['2026-11-16T01:40:36Z'], ['2023-01-05T00:00:00Z'], ['2026-03-01']];
    expect(column(sortRows(dates, { column: 0, direction: 'asc' }))).toEqual([
      '2023-01-05T00:00:00Z',
      '2026-03-01',
      '2026-11-16T01:40:36Z',
    ]);
  });

  it('keeps empty values last in both directions', () => {
    const mixed: Row[] = [[null], ['b'], [''], ['a'], ['3']];
    expect(column(sortRows(mixed, { column: 0, direction: 'asc' }))).toEqual([
      '3',
      'a',
      'b',
      null,
      '',
    ]);
    expect(column(sortRows(mixed, { column: 0, direction: 'desc' }))).toEqual([
      'b',
      'a',
      '3',
      null,
      '',
    ]);
  });

  it('keeps the order of arrival among rows that compare equal', () => {
    const tied: Row[] = [
      ['open', 'first'],
      ['closed', 'second'],
      ['open', 'third'],
      ['closed', 'fourth'],
    ];
    expect(column(sortRows(tied, { column: 0, direction: 'asc' }), 1)).toEqual([
      'second',
      'fourth',
      'first',
      'third',
    ]);
    expect(column(sortRows(tied, { column: 0, direction: 'desc' }), 1)).toEqual([
      'first',
      'third',
      'second',
      'fourth',
    ]);
  });

  it('treats a column a row does not have as empty', () => {
    const ragged: Row[] = [['a'], ['b', '1'], ['c', '0']];
    expect(column(sortRows(ragged, { column: 1, direction: 'asc' }))).toEqual(['c', 'b', 'a']);
  });
});
