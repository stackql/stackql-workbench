import { useEffect, useState } from 'react';
import { host, type AppLink, type EngineStatus } from '../../host';
import { IconButton } from '../../ui/IconButton';
import { Close } from '../../ui/icons';

interface AboutDialogProps {
  status: EngineStatus;
  onClose: () => void;
}

const LINKS: { link: AppLink; label: string }[] = [
  { link: 'docs', label: 'Documentation' },
  { link: 'queryLibrary', label: 'Query library' },
  { link: 'issues', label: 'Report an issue' },
];

/** What this app is, and the versions of it and of the engine it found. */
export function AboutDialog({ status, onClose }: AboutDialogProps) {
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    host.appVersion().then(
      (found) => {
        if (active) {
          setVersion(found);
        }
      },
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-scrim pt-24"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="About StackQL Workbench"
        className="w-[420px] max-w-[92vw] rounded-md border border-line bg-surface shadow-xl"
      >
        <div className="flex h-9 items-center justify-between border-b border-line px-3">
          <span className="font-semibold">About StackQL Workbench</span>
          <IconButton label="Close" onClick={onClose}>
            <Close />
          </IconButton>
        </div>
        <div className="px-3 py-3">
          <p className="m-0">
            A query IDE and chat interface for StackQL, which reads and changes cloud and SaaS
            resources with SQL.
          </p>
          <dl className="mt-3 mb-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <dt className="text-ink-muted">Workbench</dt>
            <dd className="selectable m-0 font-mono text-[12px]">{version ?? 'Not known'}</dd>
            <dt className="text-ink-muted">Engine</dt>
            <dd className="selectable m-0 font-mono text-[12px]">
              {status.version ? `stackql v${status.version}` : 'Not found'}
            </dd>
            <dt className="text-ink-muted">Licence</dt>
            <dd className="m-0">MIT</dd>
          </dl>
          <div className="mt-3 flex flex-wrap gap-2 border-t border-line pt-3">
            {LINKS.map(({ link, label }) => (
              <button
                key={link}
                type="button"
                title="Opens in your browser"
                className="h-6 rounded border border-line bg-surface px-2 hover:bg-surface-sunken"
                onClick={() => {
                  void host.openLink(link).catch(() => undefined);
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
