import { memo, useMemo } from 'react';
import type { ToolItem } from '../../lib/chat';
import {
  buildChart,
  chartTitle,
  parseChartSpec,
  resolveChartData,
  tableView,
  type ChartData,
  type ChartModel,
  type ChartSpec,
} from '../../lib/chart';
import { Spinner } from '../../ui/icons';
import { ResultCard } from './ResultCard';

interface ChartBlockProps {
  /** The text of the block. */
  source: string;
  /** The block is still being written. */
  open: boolean;
  /** The result sets it can be drawn from, oldest first. */
  tables: ToolItem[];
  onOpenInEditor: (sql: string) => void;
  onShowTable: (item: ToolItem) => void;
}

type Drawn =
  | {
      ok: true;
      spec: ChartSpec;
      data: ChartData;
      /** The call the rows came from. Null when the block carried them. */
      item: ToolItem | null;
      /** Null for a block that asks for a table. */
      model: ChartModel | null;
    }
  | { ok: false; error: string };

const EMPTY: ChartData = { columns: [], rows: [] };

/** Reads a block, finds its rows and works out what to draw. */
function draw(source: string, tables: ToolItem[]): Drawn {
  const parsed = parseChartSpec(source);
  if (!parsed.ok) {
    return parsed;
  }
  const spec = parsed.value;
  const resolved = resolveChartData(
    spec,
    tables.map((item) => item.table ?? EMPTY),
  );
  if (!resolved.ok) {
    return resolved;
  }
  const { data, from } = resolved.value;
  const item = from === null ? null : (tables[from] ?? null);
  if (spec.type === 'table') {
    return { ok: true, spec, data: tableView(spec, data), item, model: null };
  }
  const built = buildChart(spec, data);
  return built.ok ? { ok: true, spec, data, item, model: built.value } : built;
}

/**
 * A chart block from a reply, drawn. The block names columns. The rows
 * come from a result set in the conversation, or from the block. A block
 * that cannot be drawn is shown as the text it is, with the reason.
 */
function ChartBlockView({ source, open, tables, onOpenInEditor, onShowTable }: ChartBlockProps) {
  const drawn = useMemo(() => (open ? null : draw(source, tables)), [open, source, tables]);

  if (drawn === null) {
    return (
      <div
        className="flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2 text-ink-muted"
        data-chart-block="writing"
      >
        <Spinner /> Drawing the chart
      </div>
    );
  }

  if (!drawn.ok) {
    return (
      <div className="rounded-lg border border-line bg-surface" data-chart-block="unread">
        <div className="px-3 pt-2 text-ink-muted">This chart could not be drawn. {drawn.error}</div>
        <pre className="selectable m-0 max-h-40 overflow-auto px-3 py-2 font-mono text-[12px] break-words whitespace-pre-wrap">
          {source}
        </pre>
      </div>
    );
  }

  const { spec, item, model } = drawn;
  return (
    <div data-chart-block={spec.type}>
      <ResultCard
        title={chartTitle(spec)}
        columns={drawn.data.columns}
        rows={drawn.data.rows}
        totalRows={item?.table?.totalRows}
        sql={item?.sql ?? null}
        chart={model ? { model, xLabel: spec.xLabel, yLabel: spec.yLabel } : null}
        notes={model?.notes ?? []}
        onOpenInEditor={onOpenInEditor}
        onOpenGrid={
          item
            ? () => {
                onShowTable(item);
              }
            : undefined
        }
      />
    </div>
  );
}

const sameItems = (a: ToolItem[], b: ToolItem[]) =>
  a.length === b.length && a.every((item, index) => item === b[index]);

/**
 * A reply arrives in many pieces, and the conversation is laid out again
 * for each. A chart is drawn again only when its own block or the result
 * sets behind it have changed, not for every piece of text around it.
 */
export const ChartBlock = memo(
  ChartBlockView,
  (before, after) =>
    before.source === after.source &&
    before.open === after.open &&
    before.onOpenInEditor === after.onOpenInEditor &&
    before.onShowTable === after.onShowTable &&
    sameItems(before.tables, after.tables),
);
