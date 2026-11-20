// Sorting a result set in the webview, by one column. The engine sends every
// value as text, so the order is worked out from the text: numbers by size,
// everything else as words.

import type { Row } from '../host/types';

export type SortDirection = 'asc' | 'desc';

export interface SortState {
  /** The position of the column. Names can repeat, positions cannot. */
  column: number;
  direction: SortDirection;
}

/**
 * What a click on a column header asks for: ascending, then descending,
 * then the order the rows arrived in.
 */
export function nextSort(current: SortState | null, column: number): SortState | null {
  if (current?.column !== column) {
    return { column, direction: 'asc' };
  }
  return current.direction === 'asc' ? { column, direction: 'desc' } : null;
}

const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/** The number a cell holds, or null when it is not one. */
export function cellNumber(value: string | null): number | null {
  if (value === null) {
    return null;
  }
  const text = value.trim();
  if (!NUMBER.test(text)) {
    return null;
  }
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

type Key = { rank: 0; number: number } | { rank: 1; text: string } | { rank: 2 };

/** A NULL and an empty value have nothing to order by, so they go last. */
function sortKey(value: string | null | undefined): Key {
  if (value === null || value === undefined || value.trim() === '') {
    return { rank: 2 };
  }
  const number = cellNumber(value);
  return number === null ? { rank: 1, text: value } : { rank: 0, number };
}

function compareKeys(a: Key, b: Key): number {
  if (a.rank !== b.rank) {
    return a.rank - b.rank;
  }
  if (a.rank === 0 && b.rank === 0) {
    return a.number - b.number;
  }
  if (a.rank === 1 && b.rank === 1) {
    return collator.compare(a.text, b.text);
  }
  return 0;
}

/**
 * The rows in the order asked for. Numbers come before words, and both
 * before empty values, which stay last in either direction. Rows that
 * compare equal keep the order they arrived in. The input is not changed.
 */
export function sortRows(rows: Row[], sort: SortState | null): Row[] {
  if (sort === null) {
    return rows;
  }
  const flip = sort.direction === 'desc' ? -1 : 1;
  return rows
    .map((row, index) => ({ row, index, key: sortKey(row[sort.column]) }))
    .sort((a, b) => {
      // Empty values are last whichever way the rest runs.
      if (a.key.rank === 2 || b.key.rank === 2) {
        return a.key.rank - b.key.rank || a.index - b.index;
      }
      return flip * compareKeys(a.key, b.key) || a.index - b.index;
    })
    .map((entry) => entry.row);
}
