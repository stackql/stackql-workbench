import { describe, expect, it } from 'vitest';
import type { Activity } from '../host/types';
import {
  NO_FILTER,
  OUTCOME_CHOICES,
  activityJsonl,
  activityRows,
  filterActivity,
  formatTime,
} from './activity';

const activity: Activity = {
  operator: [
    {
      timestampMs: Date.parse('2026-11-18T10:00:00Z'),
      sql: 'SHOW PROVIDERS',
      outcome: 'ok',
      rows: 3,
      elapsedMs: 4,
      error: null,
    },
    {
      timestampMs: Date.parse('2026-11-18T10:02:00Z'),
      sql: 'SELEC 1',
      outcome: 'error',
      rows: null,
      elapsedMs: 1,
      error: 'syntax error',
    },
    {
      timestampMs: Date.parse('2026-11-18T10:04:00Z'),
      sql: 'SELECT slow',
      outcome: 'abandoned',
      rows: null,
      elapsedMs: 0,
      error: null,
    },
  ],
  agent: [
    {
      timestamp: '2026-11-18T21:01:00+11:00',
      tool: 'list_providers',
      mode: 'safe',
      decision: 'allow',
      queryClass: 'select',
      sql: null,
      durationMs: 1,
      error: null,
    },
    {
      timestamp: '2026-11-18T21:03:00+11:00',
      tool: 'run_mutation_query',
      mode: 'safe',
      decision: 'needs_approval_declined',
      queryClass: 'mutation_delete',
      sql: 'DELETE FROM t',
      durationMs: 0,
      error: 'refused: user declined approval',
    },
    {
      timestamp: '2026-11-18T21:05:00+11:00',
      tool: 'run_select_query',
      mode: 'safe',
      decision: 'allow',
      queryClass: 'select',
      sql: 'SELECT x',
      durationMs: 40,
      error: 'no such column',
    },
  ],
};

describe('activityRows', () => {
  const rows = activityRows(activity);

  it('merges both channels, newest first, across time zones', () => {
    expect(rows.map((r) => r.label)).toEqual([
      'SELECT x',
      'SELECT slow',
      'DELETE FROM t',
      'SELEC 1',
      'list_providers',
      'SHOW PROVIDERS',
    ]);
    expect(rows.map((r) => r.channel)).toEqual([
      'agent',
      'operator',
      'agent',
      'operator',
      'agent',
      'operator',
    ]);
  });

  it('describes what the operator ran', () => {
    const ok = rows.find((r) => r.label === 'SHOW PROVIDERS');
    expect(ok).toMatchObject({
      outcome: 'Ran',
      kind: 'ran',
      tone: 'ok',
      mode: '',
      rowCount: 3,
      durationMs: 4,
      detail: '',
      sql: 'SHOW PROVIDERS',
    });
    const failed = rows.find((r) => r.label === 'SELEC 1');
    expect(failed).toMatchObject({
      outcome: 'Failed',
      kind: 'failed',
      tone: 'error',
      error: 'syntax error',
    });
    const abandoned = rows.find((r) => r.label === 'SELECT slow');
    // The app stopped waiting, so it has no duration to show.
    expect(abandoned).toMatchObject({
      outcome: 'Stopped waiting',
      kind: 'stopped',
      tone: 'warn',
      durationMs: null,
    });
  });

  it('describes what the agent did, using the engine decision', () => {
    const declined = rows.find((r) => r.label === 'DELETE FROM t');
    expect(declined).toMatchObject({
      outcome: 'Declined',
      kind: 'declined',
      tone: 'warn',
      mode: 'safe',
      durationMs: 0,
      detail: 'run_mutation_query, mutation_delete',
      decision: 'needs_approval_declined',
    });
    const listed = rows.find((r) => r.label === 'list_providers');
    expect(listed).toMatchObject({
      outcome: 'Ran',
      kind: 'ran',
      tone: 'ok',
      sql: null,
      detail: 'select',
      tool: 'list_providers',
    });
    // The audit log carries no row count, so none is shown.
    expect(rows.filter((r) => r.channel === 'agent').every((r) => r.rowCount === null)).toBe(true);
  });

  it('does not call an allowed call that failed a success', () => {
    const failed = rows.find((r) => r.label === 'SELECT x');
    expect(failed).toMatchObject({ outcome: 'Ran, with an error', kind: 'failed', tone: 'error' });
  });

  it('shows an unknown decision as the engine wrote it', () => {
    const [row] = activityRows({
      operator: [],
      agent: [
        {
          timestamp: 'not a date',
          tool: 'list_providers',
          mode: 'safe',
          decision: 'something_new',
          queryClass: 'select',
          sql: null,
          durationMs: 1,
          error: null,
        },
      ],
    });
    expect(row).toMatchObject({
      outcome: 'something_new',
      kind: 'other',
      tone: 'muted',
      time: 0,
    });
  });

  it('gives every row a distinct key', () => {
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
  });
});

describe('the engine decisions', () => {
  const decided = (decision: string) =>
    activityRows({
      operator: [],
      agent: [
        {
          timestamp: '2026-11-18T10:00:00Z',
          tool: 'run_mutation_query',
          mode: 'read_only',
          decision,
          queryClass: 'mutation_delete',
          sql: 'DELETE FROM t',
          durationMs: 0,
          error: null,
        },
      ],
    })[0]?.kind;

  it('are grouped for filtering as the engine wrote them', () => {
    expect(decided('allow')).toBe('ran');
    expect(decided('needs_approval_accepted')).toBe('approved');
    expect(decided('needs_approval_declined')).toBe('declined');
    expect(decided('needs_approval_cancelled')).toBe('declined');
    expect(decided('needs_approval_unavailable')).toBe('refused');
    expect(decided('refuse_immediate')).toBe('refused');
  });
});

describe('filterActivity', () => {
  const rows = activityRows(activity);

  it('keeps everything with no filter', () => {
    expect(filterActivity(rows, NO_FILTER)).toHaveLength(rows.length);
  });

  it('narrows by who ran it', () => {
    expect(filterActivity(rows, { actor: 'agent', outcome: 'all' }).map((r) => r.label)).toEqual([
      'SELECT x',
      'DELETE FROM t',
      'list_providers',
    ]);
    expect(filterActivity(rows, { actor: 'operator', outcome: 'all' })).toHaveLength(3);
  });

  it('narrows by what became of it, and by both at once', () => {
    expect(filterActivity(rows, { actor: 'all', outcome: 'failed' }).map((r) => r.label)).toEqual([
      'SELECT x',
      'SELEC 1',
    ]);
    expect(
      filterActivity(rows, { actor: 'agent', outcome: 'declined' }).map((r) => r.label),
    ).toEqual(['DELETE FROM t']);
    expect(filterActivity(rows, { actor: 'operator', outcome: 'declined' })).toEqual([]);
  });

  it('offers each outcome the list can hold, once', () => {
    const values = OUTCOME_CHOICES.map((choice) => choice.value);
    expect(new Set(values).size).toBe(values.length);
    expect(values).toEqual(['ran', 'failed', 'refused', 'approved', 'declined', 'stopped']);
  });
});

describe('activityJsonl', () => {
  it('writes one object on each line', () => {
    const rows = activityRows(activity);
    const text = activityJsonl(rows);
    const lines = text.split('\n');
    expect(lines.pop()).toBe('');
    expect(lines).toHaveLength(rows.length);
    expect(JSON.parse(lines[2] ?? '')).toEqual({
      time: '2026-11-18T10:03:00.000Z',
      actor: 'agent',
      mode: 'safe',
      statement: 'DELETE FROM t',
      tool: 'run_mutation_query',
      durationMs: 0,
      rows: null,
      outcome: 'declined',
      decision: 'needs_approval_declined',
      error: 'refused: user declined approval',
    });
    expect(JSON.parse(lines[5] ?? '')).toEqual({
      time: '2026-11-18T10:00:00.000Z',
      actor: 'operator',
      mode: null,
      statement: 'SHOW PROVIDERS',
      tool: null,
      durationMs: 4,
      rows: 3,
      outcome: 'ran',
      decision: null,
      error: null,
    });
  });

  it('writes nothing for no rows', () => {
    expect(activityJsonl([])).toBe('');
  });
});

describe('formatTime', () => {
  it('shows only the clock for today and the date otherwise', () => {
    const now = new Date();
    now.setHours(9, 5, 7, 0);
    expect(formatTime(now.getTime())).toBe('09:05:07');
    expect(formatTime(new Date(2020, 0, 2, 3, 4, 5).getTime())).toBe('2020-01-02 03:04:05');
    expect(formatTime(0)).toBe('');
  });
});
