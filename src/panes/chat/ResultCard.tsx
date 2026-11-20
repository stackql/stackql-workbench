import { useMemo, useState, type ReactNode } from 'react';
import { host, toHostError } from '../../host';
import type { Row } from '../../host/types';
import type { ChartModel } from '../../lib/chart';
import { exportFileName, toCsv } from '../../lib/exportResult';
import { formatRowCount } from '../../lib/results';
import { nextSort, sortRows, type SortState } from '../../lib/sortRows';
import { IconButton } from '../../ui/IconButton';
import { Chart as ChartIcon, Code, Download, GoTo, OpenInEditor, Table } from '../../ui/icons';
import { Grid } from '../results/Grid';
import { Cartesian } from './charts/Cartesian';
import { Pie } from './charts/Pie';

/** The rows of a table that show before it scrolls. */
const VISIBLE_ROWS = 10;
const ROW_HEIGHT = 24;
const HEADER_HEIGHT = 26;
/** Room for a scroll bar along the bottom, so it never covers the last row. */
const SCROLL_BAR = 14;

interface DataTableProps {
  columns: string[];
  /** In the order to draw them. */
  rows: Row[];
  sort: SortState | null;
  onSort: (column: number) => void;
  visibleRows?: number;
}

/** A result set as a table: every row, sorted by a click on a column. */
export function DataTable({
  columns,
  rows,
  sort,
  onSort,
  visibleRows = VISIBLE_ROWS,
}: DataTableProps) {
  const shown = Math.max(1, Math.min(rows.length, visibleRows));
  return (
    <div style={{ height: HEADER_HEIGHT + shown * ROW_HEIGHT + SCROLL_BAR }}>
      <Grid columns={columns} rows={rows} sort={sort} onSort={onSort} fill />
    </div>
  );
}

export interface ChartView {
  model: ChartModel;
  xLabel: string | null;
  yLabel: string | null;
}

interface ResultCardProps {
  /** What the card is headed with. Without it the count of rows stands alone. */
  title?: string | null;
  columns: string[];
  rows: Row[];
  /** How many rows the statement returned, when that is more than were kept. */
  totalRows?: number;
  /** The statement behind the rows, when there is one. */
  sql?: string | null;
  /** Draws the rows as a chart, with the table one click away. */
  chart?: ChartView | null;
  /** What was left out of the chart, or anything else worth a line under it. */
  notes?: string[];
  onOpenInEditor?: (sql: string) => void;
  /** Shows the result in the grid of the explorer view, with the cell viewer. */
  onOpenGrid?: () => void;
  visibleRows?: number;
}

/**
 * A result set in the conversation: a table that sorts and downloads, and a
 * chart of it when the assistant asked for one. The chart and the table are
 * two views of the same rows.
 */
export function ResultCard({
  title = null,
  columns,
  rows,
  totalRows,
  sql = null,
  chart = null,
  notes = [],
  onOpenInEditor,
  onOpenGrid,
  visibleRows,
}: ResultCardProps) {
  const [view, setView] = useState<'chart' | 'table'>(chart ? 'chart' : 'table');
  const [sort, setSort] = useState<SortState | null>(null);
  const [sqlOpen, setSqlOpen] = useState(false);
  // What the last download did.
  const [saved, setSaved] = useState<{ text: string; failed: boolean } | null>(null);
  const sorted = useMemo(() => sortRows(rows, sort), [rows, sort]);
  const showing = chart && view === 'chart' ? 'chart' : 'table';

  const download = () => {
    // The rows as the table shows them, in the order it shows them.
    host.saveTextFile(exportFileName('csv', new Date()), 'csv', toCsv(columns, sorted)).then(
      (path) => {
        if (path !== null) {
          setSaved({ text: `Saved ${path}`, failed: false });
        }
      },
      (error: unknown) => {
        setSaved({ text: toHostError(error).message, failed: true });
      },
    );
  };

  const kept = rows.length;
  const count =
    totalRows !== undefined && totalRows > kept
      ? `first ${kept.toLocaleString('en-US')} of ${formatRowCount(totalRows)}`
      : formatRowCount(kept);

  return (
    <div className="rounded-lg border border-line bg-surface" data-result-card={showing}>
      <div className="flex min-h-8 items-center gap-1 px-2">
        {title !== null && (
          <span className="selectable min-w-0 truncate font-semibold" title={title}>
            {title}
          </span>
        )}
        <span className="shrink-0 text-[12px] text-ink-muted tabular-nums">{count}</span>
        <span className="flex-1" />
        {saved !== null && (
          <span
            role="status"
            title={saved.text}
            className={`selectable max-w-[40%] truncate text-[12px] ${
              saved.failed ? 'text-danger' : 'text-ink-muted'
            }`}
          >
            {saved.text}
          </span>
        )}
        {chart && (
          <div
            role="group"
            aria-label="View"
            className="mr-1 flex shrink-0 items-center rounded border border-line p-px"
          >
            <ViewButton
              label="Chart"
              active={view === 'chart'}
              onClick={() => {
                setView('chart');
              }}
            >
              <ChartIcon />
            </ViewButton>
            <ViewButton
              label="Table"
              active={view === 'table'}
              onClick={() => {
                setView('table');
              }}
            >
              <Table />
            </ViewButton>
          </div>
        )}
        {sql !== null && (
          <IconButton
            label={sqlOpen ? 'Hide the statement' : 'Show the statement'}
            active={sqlOpen}
            onClick={() => {
              setSqlOpen((open) => !open);
            }}
          >
            <Code />
          </IconButton>
        )}
        <IconButton label="Download as CSV" onClick={download}>
          <Download />
        </IconButton>
        {onOpenGrid && (
          <IconButton label="Open in the results grid" onClick={onOpenGrid}>
            <GoTo />
          </IconButton>
        )}
      </div>

      {sqlOpen && sql !== null && (
        <SqlBlock
          sql={sql}
          onOpen={
            onOpenInEditor
              ? () => {
                  onOpenInEditor(sql);
                }
              : undefined
          }
        />
      )}

      {/* The table is square and the card is not, so the card cuts its corners. */}
      <div
        className={`border-t border-line ${
          showing === 'table' && notes.length === 0 ? 'overflow-hidden rounded-b-[7px]' : ''
        }`}
      >
        {chart && showing === 'chart' ? (
          <div className="px-2 pt-2 pb-1">
            {chart.model.kind === 'pie' ? (
              <Pie model={chart.model} title={title ?? 'Chart'} />
            ) : (
              <Cartesian
                model={chart.model}
                title={title ?? 'Chart'}
                xLabel={chart.xLabel}
                yLabel={chart.yLabel}
              />
            )}
          </div>
        ) : (
          <DataTable
            columns={columns}
            rows={sorted}
            sort={sort}
            onSort={(column) => {
              setSort((current) => nextSort(current, column));
            }}
            visibleRows={visibleRows}
          />
        )}
      </div>

      {notes.length > 0 && (
        <div className="selectable border-t border-line px-2 py-1 text-[12px] text-ink-muted">
          {notes.map((note, index) => (
            <div key={index}>{note}</div>
          ))}
        </div>
      )}
    </div>
  );
}

function ViewButton({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      title={label}
      className={`flex h-5 items-center gap-1 rounded-sm px-1.5 text-[12px] ${
        active ? 'bg-surface-sunken font-semibold text-ink' : 'text-ink-muted hover:text-ink'
      }`}
      onClick={onClick}
    >
      {children}
      {label}
    </button>
  );
}

/** A statement, as SQL, with a way into the editor. */
export function SqlBlock({
  sql,
  label,
  onOpen,
}: {
  sql: string;
  label?: string;
  onOpen?: () => void;
}) {
  return (
    <div className="relative border-t border-line bg-surface-alt">
      {label && (
        <div className="px-2 pt-1 text-[11px] tracking-wide text-ink-muted uppercase">{label}</div>
      )}
      <pre className="selectable m-0 max-h-48 overflow-auto py-1.5 pr-8 pl-2 font-mono text-[12px] break-words whitespace-pre-wrap">
        {sql}
      </pre>
      {onOpen && (
        <div className="absolute top-0.5 right-0.5">
          <IconButton label="Open in editor" onClick={onOpen}>
            <OpenInEditor />
          </IconButton>
        </div>
      )}
    </div>
  );
}
