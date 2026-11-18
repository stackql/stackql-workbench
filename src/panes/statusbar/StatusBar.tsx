import { useState, type ReactNode } from 'react';
import { copyText } from '../../host/clipboard';
import type { EngineState, EngineStatus } from '../../host/types';
import { connectionString } from '../../lib/cli';
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
  /** Extra items shown at the right. */
  children?: ReactNode;
}

/** Engine state, version and address. The details and restart are in a popover on the state. */
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
        {(close) => (
          <EngineDetails
            status={status}
            busy={busy}
            onRestart={() => {
              close();
              onRestart();
            }}
          />
        )}
      </Popover>

      {status.version && (
        <span className="selectable shrink-0" title="Engine version">
          stackql v{status.version}
        </span>
      )}

      {status.endpoint && status.state === 'running' && <Address endpoint={status.endpoint} />}

      <span className="flex-1" />
      {children}
    </div>
  );
}

/** The address statements are sent to. A click copies a connection string for it. */
function Address({ endpoint }: { endpoint: string }) {
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  const connection = connectionString(endpoint);
  if (connection === null) {
    return (
      <span className="selectable shrink-0 opacity-90" title="Address statements are sent to">
        {endpoint}
      </span>
    );
  }
  return (
    <button
      type="button"
      className="flex h-5 shrink-0 items-center rounded px-1 opacity-90 hover:bg-white/15 hover:opacity-100"
      title={`The engine's Postgres wire address, on this machine only. Click to copy a connection string:\n${connection}`}
      onClick={() => {
        void copyText(connection).then((ok) => {
          setCopy(ok ? 'copied' : 'failed');
          window.setTimeout(() => {
            setCopy('idle');
          }, 2500);
        });
      }}
    >
      <span role={copy === 'idle' ? undefined : 'status'}>
        {copy === 'copied'
          ? 'Connection string copied'
          : copy === 'failed'
            ? 'Could not copy to the clipboard'
            : endpoint}
      </span>
    </button>
  );
}

interface EngineDetailsProps {
  status: EngineStatus;
  busy: boolean;
  onRestart: () => void;
}

/** What the engine popover lists, and the way to restart the engine. */
function EngineDetails({ status, busy, onRestart }: EngineDetailsProps) {
  return (
    <div className="w-[420px] max-w-[80vw]">
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
      <div className="mt-3 flex items-center gap-2 border-t border-line pt-2">
        <button
          type="button"
          className="flex h-6 shrink-0 items-center gap-1 rounded border border-line bg-surface px-2 hover:bg-surface-sunken disabled:opacity-50"
          disabled={busy}
          onClick={onRestart}
        >
          <Refresh />
          Restart engine
        </button>
        <span className="text-[12px] text-ink-muted">
          Reads credentials again. Also the only way to stop a running statement.
        </span>
      </div>
    </div>
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
