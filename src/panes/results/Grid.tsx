import {
  columnResizingFeature,
  columnSizingFeature,
  tableFeatures,
  useTable,
  type ColumnDef,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useMemo, useRef } from 'react';
import type { Row } from '../../host/types';
import { cellPreview, looksLikeJson } from '../../lib/cell';

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
  rows: Row[];
  selected: CellRef | null;
  onSelect: (cell: CellRef) => void;
  /** Called when the operator asks to see a cell in full. */
  onOpen: (cell: CellRef) => void;
}

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
export function Grid({ columns, rows, selected, onSelect, onOpen }: GridProps) {
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

  const scroller = useRef<HTMLDivElement>(null);
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
  const widths = headers.map((header) => header.getSize());
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
          {headers.map((header, index) => (
            <div
              key={header.id}
              role="columnheader"
              title={columns[index]}
              className="relative flex shrink-0 items-center border-r border-line px-2"
              style={{ width: widths[index] }}
            >
              <span className="selectable truncate">{columns[index]}</span>
              <div
                role="separator"
                aria-orientation="vertical"
                aria-label={`Resize column ${columns[index] ?? ''}`}
                onMouseDown={header.getResizeHandler()}
                onTouchStart={header.getResizeHandler()}
                onDoubleClick={() => {
                  header.column.resetSize();
                }}
                className={`absolute top-0 right-0 h-full w-1.5 cursor-col-resize hover:bg-accent/60 ${
                  header.column.getIsResizing() ? 'bg-accent' : ''
                }`}
              />
            </div>
          ))}
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
                        onSelect({ row: item.index, column });
                      }}
                      onDoubleClick={() => {
                        onOpen({ row: item.index, column });
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
