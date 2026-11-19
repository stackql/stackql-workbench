import {
  columnResizingFeature,
  columnSizingFeature,
  tableFeatures,
  useTable,
  type ColumnDef,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useMemo, useState } from 'react';
import type { Row } from '../../host/types';
import { cellPreview, looksLikeJson } from '../../lib/cell';
import type { SortState } from '../../lib/sortRows';
import { SortDown, SortUp } from '../../ui/icons';
import { useWidth } from '../../ui/useWidth';

const ROW_HEIGHT = 24;
const HEADER_HEIGHT = 26;
const ROW_NUMBER_WIDTH = 52;

// Only what the grid uses is registered: column widths and drag resizing.
// The core row model is always there.
const features = tableFeatures({ columnSizingFeature, columnResizingFeature });
type GridFeatures = typeof features;

export interface CellRef {
  row: number;
  column: number;
}

interface GridProps {
  columns: string[];
  /** The rows in the order to draw them. Sorting is done by whoever owns the rows. */
  rows: Row[];
  selected?: CellRef | null;
  onSelect?: (cell: CellRef) => void;
  /** Called when the operator asks to see a cell in full. */
  onOpen?: (cell: CellRef) => void;
  /** The column the rows are sorted by, if any. */
  sort?: SortState | null;
  /** Called with a column's position when its header is clicked. Without it, headers do nothing. */
  onSort?: (column: number) => void;
  /** Widens the columns to fill the space when they would not, until one is dragged. */
  fill?: boolean;
}

const ARIA_SORT = { asc: 'ascending', desc: 'descending' } as const;
const SCROLL_BAR_WIDTH = 14;

const SAMPLE_ROWS = 50;
const CHAR_WIDTH = 7.3;

/** A starting width that fits the header and the first rows, within limits. */
function initialWidth(name: string, index: number, sample: Row[]): number {
  let chars = name.length + 1;
  for (const row of sample) {
    const value = row[index];
    chars = Math.max(chars, value === null || value === undefined ? 4 : Math.min(value.length, 44));
  }
  return Math.round(Math.min(360, Math.max(72, chars * CHAR_WIDTH + 22)));
}

/** A read-only grid. Rows are virtualised, so only the visible ones are in the DOM. */
export function Grid({
  columns,
  rows,
  selected,
  onSelect,
  onOpen,
  sort,
  onSort,
  fill = false,
}: GridProps) {
  // Sized from the first rows. A width the operator sets by dragging is kept
  // by the table and wins over these.
  const columnDefs = useMemo<ColumnDef<GridFeatures, Row>[]>(() => {
    const sample = rows.slice(0, SAMPLE_ROWS);
    return columns.map((name, index) => ({
      // Column names can repeat, so the id is positional.
      id: `c${index}`,
      header: name,
      accessorFn: (row: Row) => row[index] ?? null,
      size: initialWidth(name, index, sample),
    }));
  }, [columns, rows]);

  const table = useTable(
    {
      features,
      columns: columnDefs,
      data: rows,
      columnResizeMode: 'onChange',
      defaultColumn: { minSize: 48, maxSize: 1600 },
    },
    (state) => state,
  );

  const [scroller, available] = useWidth<HTMLDivElement>();
  // Set once the operator drags a column. From then on widths are theirs.
  const [resized, setResized] = useState(false);
  // The React Compiler is not used in this project, so its warning about this
  // hook does not apply.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    // Every row has the same height, so nothing needs measuring.
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  const headers = table.getHeaderGroups()[0]?.headers ?? [];
  const sizes = headers.map((header) => header.getSize());
  const natural = sizes.reduce((sum, width) => sum + width, 0);
  // Columns narrower than the space they are in are widened to fill it, each
  // in proportion, with room left for a scroll bar.
  const room = available - ROW_NUMBER_WIDTH - SCROLL_BAR_WIDTH;
  const stretch = fill && !resized && natural > 0 && natural < room ? room / natural : 1;
  const widths = sizes.map((size) => Math.floor(size * stretch));
  const totalWidth = ROW_NUMBER_WIDTH + widths.reduce((sum, width) => sum + width, 0);

  return (
    <div ref={scroller} className="h-full min-h-0 overflow-auto bg-surface" role="grid">
      <div style={{ width: totalWidth, minWidth: '100%' }}>
        <div
          role="row"
          className="sticky top-0 z-10 flex border-b border-line bg-surface-alt font-semibold"
          style={{ height: HEADER_HEIGHT }}
        >
          <div
            className="shrink-0 border-r border-line"
            style={{ width: ROW_NUMBER_WIDTH }}
            role="columnheader"
            aria-label="Row number"
          />
          {headers.map((header, index) => {
            const direction = sort?.column === index ? sort.direction : null;
            return (
              <div
                key={header.id}
                role="columnheader"
                aria-sort={direction ? ARIA_SORT[direction] : onSort ? 'none' : undefined}
                title={columns[index]}
                className="relative flex shrink-0 items-center border-r border-line"
                style={{ width: widths[index] }}
              >
                {onSort ? (
                  <button
                    type="button"
                    className="flex h-full min-w-0 flex-1 items-center gap-1 px-2 text-left font-semibold hover:bg-surface-sunken"
                    title={`${columns[index] ?? ''}: click to sort`}
                    onClick={() => {
                      onSort(index);
                    }}
                  >
                    <span className="truncate">{columns[index]}</span>
                    {direction === 'asc' && <SortUp className="shrink-0 text-accent" />}
                    {direction === 'desc' && <SortDown className="shrink-0 text-accent" />}
                  </button>
                ) : (
                  <span className="selectable truncate px-2">{columns[index]}</span>
                )}
                <div
                  role="separator"
                  aria-orientation="vertical"
                  aria-label={`Resize column ${columns[index] ?? ''}`}
                  onMouseDown={(event) => {
                    setResized(true);
                    header.getResizeHandler()(event);
                  }}
                  onTouchStart={(event) => {
                    setResized(true);
                    header.getResizeHandler()(event);
                  }}
                  onDoubleClick={() => {
                    header.column.resetSize();
                  }}
                  className={`absolute top-0 right-0 h-full w-1.5 cursor-col-resize hover:bg-accent/60 ${
                    header.column.getIsResizing() ? 'bg-accent' : ''
                  }`}
                />
              </div>
            );
          })}
        </div>

        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((item) => {
            const row = rows[item.index];
            if (!row) {
              return null;
            }
            return (
              <div
                key={item.key}
                role="row"
                aria-rowindex={item.index + 1}
                className="absolute left-0 flex border-b border-line/60 hover:bg-surface-alt"
                style={{ height: ROW_HEIGHT, transform: `translateY(${item.start}px)` }}
              >
                <div
                  className="shrink-0 border-r border-line bg-surface-alt px-2 text-right text-[11px] leading-6 text-ink-muted tabular-nums"
                  style={{ width: ROW_NUMBER_WIDTH }}
                >
                  {item.index + 1}
                </div>
                {widths.map((width, column) => {
                  const value = row[column] ?? null;
                  const isSelected = selected?.row === item.index && selected.column === column;
                  return (
                    <div
                      key={column}
                      role="gridcell"
                      aria-selected={isSelected}
                      className={`shrink-0 cursor-default truncate border-r border-line/60 px-2 font-mono text-[12px] leading-6 ${
                        value === null ? 'text-ink-muted italic' : ''
                      } ${looksLikeJson(value) ? 'text-accent' : ''} ${
                        isSelected
                          ? 'bg-accent/15 outline outline-1 -outline-offset-1 outline-accent'
                          : ''
                      }`}
                      style={{ width }}
                      onClick={() => {
                        onSelect?.({ row: item.index, column });
                      }}
                      onDoubleClick={() => {
                        onOpen?.({ row: item.index, column });
                      }}
                    >
                      {cellPreview(value)}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
