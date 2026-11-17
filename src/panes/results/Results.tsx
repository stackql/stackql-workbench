import { useEffect, useState } from 'react';
import {
  attentionCount,
  formatElapsed,
  formatRowCount,
  gridStatement,
  looksLikeUpstreamFailure,
  type RunState,
  type StatementResult,
} from '../../lib/results';
import { IconButton } from '../../ui/IconButton';
import { Panel, Spinner, Warning } from '../../ui/icons';
import { Splitter } from '../../ui/Splitter';
import { CellViewer } from './CellViewer';
import { Grid, type CellRef } from './Grid';
import { Messages } from './Messages';

interface ResultsProps {
  run: RunState;
  onStopWaiting: () => void;
}

/** The results pane: a grid, a cell viewer and the messages of the run. */
export function Results({ run, onStopWaiting }: ResultsProps) {
  // Keyed by run, so the selection and the chosen tab reset when a new run starts.
  return <ResultsBody key={run.runId ?? 'none'} run={run} onStopWaiting={onStopWaiting} />;
}

type Tab = 'results' | 'messages';

function ResultsBody({ run, onStopWaiting }: ResultsProps) {
  const [tab, setTab] = useState<Tab>('results');
  const [picked, setPicked] = useState<number | null>(null);
  const [selected, setSelected] = useState<CellRef | null>(null);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [viewerWidth, setViewerWidth] = useState(380);

  const withResults = run.statements.filter((s) => s.columns !== null && s.columns.length > 0);
  const statement =
    (picked !== null ? run.statements.find((s) => s.index === picked) : undefined) ??
    gridStatement(run);
  const columns = statement?.columns ?? null;
  const hasGrid = columns !== null && columns.length > 0;
  const attention = attentionCount(run);

  const selectedValue =
    selected && statement ? (statement.rows[selected.row]?.[selected.column] ?? null) : null;
  const selectedColumn = selected && columns ? (columns[selected.column] ?? '') : '';

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-line bg-surface-alt px-2">
        <TabButton
          active={tab === 'results'}
          onClick={() => {
            setTab('results');
          }}
        >
          Results
        </TabButton>
        <TabButton
          active={tab === 'messages'}
          onClick={() => {
            setTab('messages');
          }}
        >
          Messages
          {attention > 0 && (
            <span className="ml-1 rounded-full bg-warn px-1.5 text-[10px] font-semibold text-surface">
              {attention}
            </span>
          )}
        </TabButton>

        {withResults.length > 1 && tab === 'results' && (
          <select
            aria-label="Result set"
            className="ml-2 h-6 max-w-64 rounded border border-line bg-surface px-1"
            value={statement?.index ?? ''}
            onChange={(event) => {
              setPicked(Number(event.target.value));
              setSelected(null);
            }}
          >
            {withResults.map((s) => (
              <option key={s.index} value={s.index}>
                {`${s.index + 1}: ${s.sql.replace(/\s+/g, ' ').slice(0, 60)}`}
              </option>
            ))}
          </select>
        )}

        <span className="flex-1" />
        {run.origin === 'agent' && (
          <span
            className="rounded-sm bg-brand px-1 text-[10px] font-semibold text-on-brand"
            title="This result came from a statement the assistant ran"
          >
            Assistant
          </span>
        )}
        <RunStatus run={run} statement={statement} onStopWaiting={onStopWaiting} />
        {hasGrid && tab === 'results' && (
          <IconButton
            label={viewerOpen ? 'Hide cell viewer' : 'Show cell viewer'}
            active={viewerOpen}
            onClick={() => {
              setViewerOpen((open) => !open);
            }}
          >
            <Panel />
          </IconButton>
        )}
      </div>

      <div className="min-h-0 flex-1">
        {tab === 'messages' ? (
          <Messages run={run} />
        ) : run.statements.length === 0 && !run.hostError ? (
          <EmptyState running={run.running} />
        ) : hasGrid && statement ? (
          <div className="flex h-full min-h-0 flex-col">
            {looksLikeUpstreamFailure(statement) && (
              <UpstreamBanner
                statement={statement}
                onShow={() => {
                  setTab('messages');
                }}
              />
            )}
            <div className="flex min-h-0 flex-1">
              <div className="min-w-0 flex-1">
                <Grid
                  columns={columns}
                  rows={statement.rows}
                  selected={selected}
                  onSelect={setSelected}
                  onOpen={(cell) => {
                    setSelected(cell);
                    setViewerOpen(true);
                  }}
                />
              </div>
              {viewerOpen && (
                <>
                  <Splitter
                    orientation="vertical"
                    label="Resize cell viewer"
                    onResize={(delta) => {
                      setViewerWidth((width) => Math.min(900, Math.max(220, width - delta)));
                    }}
                  />
                  <div className="shrink-0" style={{ width: viewerWidth }}>
                    {selected ? (
                      <CellViewer
                        column={selectedColumn}
                        rowNumber={selected.row + 1}
                        value={selectedValue}
                        onClose={() => {
                          setViewerOpen(false);
                        }}
                      />
                    ) : (
                      <p className="h-full border-l border-line px-3 py-2 text-ink-muted">
                        Select a cell to see its full value.
                      </p>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        ) : (
          // No result set to draw, so what happened is the result.
          <Messages run={run} />
        )}
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`flex h-6 items-center rounded px-2 ${
        active ? 'bg-surface font-semibold text-ink shadow-sm' : 'text-ink-muted hover:text-ink'
      }`}
    >
      {children}
    </button>
  );
}

function EmptyState({ running }: { running: boolean }) {
  return (
    <p className="px-3 py-2 text-ink-muted">
      {running ? 'Starting' : 'Run a statement to see its result here.'}
    </p>
  );
}

function UpstreamBanner({ statement, onShow }: { statement: StatementResult; onShow: () => void }) {
  const first = statement.notices[0];
  const line = (first?.detail ?? first?.message ?? '').split('\n')[0]?.slice(0, 200) ?? '';
  return (
    <div className="flex shrink-0 items-start gap-2 border-b border-line bg-warn/10 px-3 py-1.5 text-warn">
      <Warning className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <div>
          No rows came back and the engine reported a problem. This is how a failed provider API
          call appears.
        </div>
        <div className="selectable truncate font-mono text-[12px]">{line}</div>
      </div>
      <button type="button" className="shrink-0 underline" onClick={onShow}>
        Details
      </button>
    </div>
  );
}

function RunStatus({
  run,
  statement,
  onStopWaiting,
}: {
  run: RunState;
  statement: StatementResult | null;
  onStopWaiting: () => void;
}) {
  if (run.running) {
    const active = run.statements.at(-1);
    return (
      <span className="flex items-center gap-2 text-ink-muted">
        <Spinner />
        <span>
          {run.total > 1 && active ? `Statement ${active.index + 1} of ${run.total}, ` : ''}
          <RunningTimer />
        </span>
        <button
          type="button"
          className="h-6 rounded border border-line bg-surface px-2 text-ink hover:bg-surface-sunken"
          title="Stops waiting for the result. The engine cannot cancel a statement, so it may still complete there."
          onClick={onStopWaiting}
        >
          Stop waiting
        </button>
      </span>
    );
  }
  if (!statement) {
    return null;
  }
  if (statement.status === 'failed') {
    return <span className="text-danger">Failed</span>;
  }
  if (statement.status === 'abandoned') {
    return <span className="text-warn">Stopped waiting</span>;
  }
  const parts: string[] = [];
  if (statement.columns !== null) {
    parts.push(formatRowCount(statement.rowCount ?? statement.rows.length));
  }
  if (statement.elapsedMs !== null) {
    parts.push(formatElapsed(statement.elapsedMs));
  }
  return <span className="mr-1 text-ink-muted tabular-nums">{parts.join(', ')}</span>;
}

/** Counts up while a statement runs. The engine sends nothing until it is done. */
function RunningTimer() {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const started = performance.now();
    const timer = window.setInterval(() => {
      setElapsed(performance.now() - started);
    }, 100);
    return () => {
      window.clearInterval(timer);
    };
  }, []);
  return <span className="tabular-nums">{`${(elapsed / 1000).toFixed(1)} s`}</span>;
}
