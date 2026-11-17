import type { ReactNode } from 'react';
import type { EngineState, EngineStatus } from '../../host/types';
import { Gear, Refresh, Spinner } from '../../ui/icons';

const STATE_TEXT: Record<EngineState, string> = {
  stopped: 'Engine stopped',
  starting: 'Engine starting',
  running: 'Engine running',
  failed: 'Engine not running',
};

const STATE_DOT: Record<EngineState, string> = {
  stopped: 'bg-ink-muted',
  starting: 'bg-warn',
  running: 'bg-ok',
  failed: 'bg-danger',
};

interface StatusBarProps {
  status: EngineStatus;
  restarting: boolean;
  onRestart: () => void;
  onOpenSettings: () => void;
  /** Extra items shown at the right, before the buttons. */
  children?: ReactNode;
}

/** Shows the resolved engine path, its version and its state. */
export function StatusBar({
  status,
  restarting,
  onRestart,
  onOpenSettings,
  children,
}: StatusBarProps) {
  const busy = restarting || status.state === 'starting';
  return (
    <div className="flex h-6 shrink-0 items-center gap-3 border-t border-line bg-brand px-2 text-[12px] text-on-brand">
      <span className="flex shrink-0 items-center gap-1.5" role="status">
        {busy ? (
          <Spinner />
        ) : (
          <span className={`h-2 w-2 rounded-full ${STATE_DOT[status.state]}`} aria-hidden />
        )}
        <span>{STATE_TEXT[status.state]}</span>
      </span>

      {status.version && (
        <span className="selectable shrink-0" title="Engine version">
          stackql v{status.version}
        </span>
      )}

      {status.location && (
        <span
          className="selectable min-w-0 truncate opacity-90"
          title={`${status.location}${status.locationSource ? ` (found via ${status.locationSource})` : ''}`}
        >
          {status.location}
          {status.locationSource ? ` (${status.locationSource})` : ''}
        </span>
      )}

      {status.endpoint && status.state === 'running' && (
        <span className="selectable shrink-0 opacity-90" title="Address statements are sent to">
          {status.endpoint}
        </span>
      )}

      <span className="flex-1" />
      {children}

      <button
        type="button"
        className="flex h-5 shrink-0 items-center gap-1 rounded px-1.5 hover:bg-white/15 disabled:opacity-50"
        title="Stop and start the engine. This is also the only way to stop a running statement."
        disabled={busy}
        onClick={onRestart}
      >
        <Refresh />
        Restart engine
      </button>
      <button
        type="button"
        className="flex h-5 shrink-0 items-center gap-1 rounded px-1.5 hover:bg-white/15"
        onClick={onOpenSettings}
      >
        <Gear />
        Settings
      </button>
    </div>
  );
}
