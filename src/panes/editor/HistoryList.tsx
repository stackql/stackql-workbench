import { useEffect, useMemo, useState } from 'react';
import { host, toHostError, type HistoryEntry } from '../../host';
import { oneLine, recentStatements, timeAgo } from '../../lib/history';
import { IconButton } from '../../ui/IconButton';
import { Play, Spinner } from '../../ui/icons';

interface HistoryListProps {
  /** Whether a statement can be run right now. */
  canRun: boolean;
  /** Opens a statement in a new tab. Nothing runs. */
  onOpen: (sql: string) => void;
  /** Opens a statement in a new tab and runs it. */
  onRun: (sql: string) => void;
}

/** The statements the operator ran, most recent first. Statements only. */
export function HistoryList({ canRun, onOpen, onRun }: HistoryListProps) {
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [now, setNow] = useState(0);

  useEffect(() => {
    let active = true;
    host.activity(1000).then(
      (activity) => {
        if (active) {
          setNow(Date.now());
          setEntries(activity.operator);
        }
      },
      (failure: unknown) => {
        if (active) {
          setError(toHostError(failure).message);
        }
      },
    );
    return () => {
      active = false;
    };
  }, []);

  const items = useMemo(() => recentStatements(entries ?? [], search), [entries, search]);

  return (
    <div className="flex max-h-[60vh] w-[560px] max-w-[70vw] flex-col">
      <input
        autoFocus
        type="text"
        spellCheck={false}
        aria-label="Search the history"
        className="selectable mb-2 h-7 w-full shrink-0 rounded border border-line bg-surface px-2"
        placeholder="Search statements you have run"
        value={search}
        onChange={(event) => {
          setSearch(event.target.value);
        }}
      />
      <div className="min-h-0 flex-1 overflow-auto">
        {error !== null ? (
          <p className="selectable text-danger">{error}</p>
        ) : entries === null ? (
          <p className="flex items-center gap-2 text-ink-muted">
            <Spinner /> Reading the history
          </p>
        ) : items.length === 0 ? (
          <p className="text-ink-muted">
            {entries.length === 0 ? 'Nothing has been run yet.' : 'No statement matches.'}
          </p>
        ) : (
          items.map((item) => (
            <div
              key={item.sql}
              className="flex h-7 items-center gap-2 rounded px-1 hover:bg-surface-sunken"
            >
              <button
                type="button"
                title={`${item.sql}\n\nOpens in a new tab`}
                className="min-w-0 flex-1 truncate text-left font-mono text-[12px]"
                onClick={() => {
                  onOpen(item.sql);
                }}
              >
                {oneLine(item.sql)}
              </button>
              {item.outcome === 'error' && (
                <span className="shrink-0 text-[11px] text-danger">failed</span>
              )}
              <span className="shrink-0 text-[11px] text-ink-muted tabular-nums">
                {timeAgo(item.timestampMs, now)}
              </span>
              <IconButton
                label="Run again in a new tab"
                disabled={!canRun}
                onClick={() => {
                  onRun(item.sql);
                }}
              >
                <Play />
              </IconButton>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
