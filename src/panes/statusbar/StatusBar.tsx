import type { ReactNode } from 'react';
import type { EngineState, EngineStatus } from '../../host/types';
import { Refresh, Spinner } from '../../ui/icons';
import { Popover } from '../../ui/Popover';

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
  /** Extra items shown at the right, before the buttons. */
  children?: ReactNode;
}

/** Engine state, version and address. The details are in a popover on the state. */
export function StatusBar({ status, restarting, onRestart, children }: StatusBarProps) {
  const busy = restarting || status.state === 'starting';
  return (
    <div className="flex h-6 shrink-0 items-center gap-3 border-t border-line bg-brand px-2 text-[12px] text-on-brand">
      <Popover
        label="Engine details"
        placement="top"
        triggerClassName="flex h-5 shrink-0 items-center gap-1.5 rounded px-1 hover:bg-white/15"
        trigger={
          <span className="flex items-center gap-1.5" role="status">
            {busy ? (
              <Spinner />
            ) : (
              <span className={`h-2 w-2 rounded-full ${STATE_DOT[status.state]}`} aria-hidden />
            )}
            <span>{STATE_TEXT[status.state]}</span>
          </span>
        }
      >
        <EngineDetails status={status} />
      </Popover>

      {status.version && (
        <span className="selectable shrink-0" title="Engine version">
          stackql v{status.version}
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
    </div>
  );
}

/** What the engine popover lists. */
function EngineDetails({ status }: { status: EngineStatus }) {
  return (
    <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
      <Detail name="State" value={STATE_TEXT[status.state]} />
      <Detail name="Version" value={status.version ? `v${status.version}` : null} />
      <Detail
        name="Engine binary"
        value={status.location}
        note={status.locationSource ? `Found via ${status.locationSource}` : null}
      />
      <Detail name="Data folder" value={status.dataFolder} note={status.dataFolderSource} />
      <Detail name="Address" value={status.endpoint} />
    </dl>
  );
}

function Detail({
  name,
  value,
  note,
}: {
  name: string;
  value: string | null;
  note?: string | null;
}) {
  return (
    <>
      <dt className="text-ink-muted">{name}</dt>
      <dd className="m-0 min-w-0">
        <span className="selectable font-mono text-[12px] break-all">{value ?? 'Not known'}</span>
        {note && <span className="block text-[12px] text-ink-muted">{note}</span>}
      </dd>
    </>
  );
}
