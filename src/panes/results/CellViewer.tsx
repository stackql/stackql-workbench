import { useMemo, useState } from 'react';
import { copyText } from '../../host/clipboard';
import { describeCell } from '../../lib/cell';
import { IconButton } from '../../ui/IconButton';
import { Check, Close, Copy } from '../../ui/icons';

interface CellViewerProps {
  column: string;
  rowNumber: number;
  value: string | null;
  onClose: () => void;
}

/** Shows one cell in full. JSON values are pretty-printed. */
export function CellViewer({ column, rowNumber, value, onClose }: CellViewerProps) {
  const content = useMemo(() => describeCell(value), [value]);
  const [copied, setCopied] = useState(false);

  const shown =
    content.kind === 'json' ? content.pretty : content.kind === 'text' ? content.text : '';
  const badge = content.kind === 'json' ? 'JSON' : content.kind === 'null' ? 'NULL' : 'Text';

  return (
    <div className="flex h-full min-h-0 flex-col border-l border-line bg-surface">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line bg-surface-alt px-2">
        <span className="truncate font-semibold" title={column}>
          {column}
        </span>
        <span className="shrink-0 text-ink-muted">row {rowNumber}</span>
        <span className="shrink-0 rounded-sm border border-line px-1 text-[10px] text-ink-muted">
          {badge}
        </span>
        <span className="flex-1" />
        <IconButton
          label="Copy value"
          disabled={content.kind === 'null'}
          onClick={() => {
            void copyText(shown).then((ok) => {
              if (ok) {
                setCopied(true);
                window.setTimeout(() => {
                  setCopied(false);
                }, 1200);
              }
            });
          }}
        >
          {copied ? <Check className="text-ok" /> : <Copy />}
        </IconButton>
        <IconButton label="Close cell viewer" onClick={onClose}>
          <Close />
        </IconButton>
      </div>
      {content.kind === 'null' ? (
        <p className="px-3 py-2 text-ink-muted italic">The engine sent a NULL for this cell.</p>
      ) : (
        <pre className="selectable m-0 min-h-0 flex-1 overflow-auto p-3 font-mono text-[12px] leading-5 break-words whitespace-pre-wrap">
          {shown}
        </pre>
      )}
    </div>
  );
}
