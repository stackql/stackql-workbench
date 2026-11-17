import { useState } from 'react';
import type { EngineStatus } from '../../host/types';
import { ErrorMark } from '../../ui/icons';

interface EngineBannerProps {
  status: EngineStatus;
  onRetry: () => void;
  onOpenSettings: () => void;
}

/** Says plainly why the engine is not running, and what to do about it. */
export function EngineBanner({ status, onRetry, onOpenSettings }: EngineBannerProps) {
  const [showLog, setShowLog] = useState(false);
  if (status.state !== 'failed') {
    return null;
  }
  return (
    <div className="shrink-0 border-b border-line bg-danger/10 px-3 py-2">
      <div className="flex items-start gap-2">
        <ErrorMark className="mt-0.5 shrink-0 text-danger" />
        <div className="selectable min-w-0 flex-1">
          <div className="font-semibold">The engine is not running</div>
          <div>{status.error ?? 'No reason was reported.'}</div>
        </div>
        <button
          type="button"
          className="h-6 shrink-0 rounded border border-line bg-surface px-2 hover:bg-surface-sunken"
          onClick={onOpenSettings}
        >
          Open settings
        </button>
        <button
          type="button"
          className="h-6 shrink-0 rounded bg-brand px-2 text-on-brand hover:bg-brand-dark"
          onClick={onRetry}
        >
          Try again
        </button>
      </div>
      {status.logTail.length > 0 && (
        <div className="mt-1 ml-6">
          <button
            type="button"
            className="text-[12px] text-accent hover:underline"
            onClick={() => {
              setShowLog((open) => !open);
            }}
          >
            {showLog ? 'Hide engine output' : 'Show engine output'}
          </button>
          {showLog && (
            <pre className="selectable m-0 mt-1 max-h-40 overflow-auto rounded border border-line bg-surface p-2 font-mono text-[12px] whitespace-pre-wrap">
              {status.logTail.join('\n')}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
