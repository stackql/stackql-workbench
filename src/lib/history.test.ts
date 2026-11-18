import { describe, expect, it } from 'vitest';
import type { HistoryEntry } from '../host/types';
import { oneLine, recentStatements, timeAgo } from './history';

const entry = (sql: string, timestampMs: number, outcome = 'ok'): HistoryEntry => ({
  timestampMs,
  sql,
  outcome,
  rows: null,
  elapsedMs: 1,
  error: null,
});

describe('recentStatements', () => {
  it('lists the most recently run first', () => {
    const items = recentStatements([
      entry('SHOW PROVIDERS', 100),
      entry('REGISTRY LIST', 300),
      entry('SHOW VERSION', 200),
    ]);
    expect(items.map((item) => item.sql)).toEqual([
      'REGISTRY LIST',
      'SHOW VERSION',
      'SHOW PROVIDERS',
    ]);
  });

  it('lists a statement once, with its last run and a count', () => {
    const items = recentStatements([
      entry('SHOW PROVIDERS', 100),
      entry('SHOW VERSION', 150),
      entry('  SHOW PROVIDERS\n', 300, 'error'),
    ]);
    expect(items).toEqual([
      { sql: 'SHOW PROVIDERS', timestampMs: 300, outcome: 'error', runs: 2 },
      { sql: 'SHOW VERSION', timestampMs: 150, outcome: 'ok', runs: 1 },
    ]);
  });

  it('keeps what holds the search text, whatever its case', () => {
    const items = recentStatements(
      [entry('SELECT login FROM github.orgs.orgs', 1), entry('SHOW PROVIDERS', 2)],
      ' GITHUB ',
    );
    expect(items.map((item) => item.sql)).toEqual(['SELECT login FROM github.orgs.orgs']);
  });

  it('leaves out an empty statement', () => {
    expect(recentStatements([entry('   ', 1)])).toEqual([]);
  });
});

describe('oneLine', () => {
  it('folds line breaks and runs of spaces', () => {
    expect(oneLine('SELECT a,\n   b\nFROM t ')).toBe('SELECT a, b FROM t');
  });
});

describe('timeAgo', () => {
  it('gives a short phrase', () => {
    const now = 10_000_000_000;
    expect(timeAgo(now - 20_000, now)).toBe('just now');
    expect(timeAgo(now - 5 * 60_000, now)).toBe('5 min ago');
    expect(timeAgo(now - 3 * 3_600_000, now)).toBe('3 h ago');
    expect(timeAgo(now - 2 * 86_400_000, now)).toBe('2 d ago');
    expect(timeAgo(now + 5_000, now)).toBe('just now');
  });
});
