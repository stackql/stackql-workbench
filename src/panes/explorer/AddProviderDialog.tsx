import { useEffect, useState } from 'react';
import { host, toHostError, type Provider } from '../../host';
import { IconButton } from '../../ui/IconButton';
import { Close, Spinner } from '../../ui/icons';

interface AddProviderDialogProps {
  /** Names of the providers that are installed. */
  installed: ReadonlySet<string>;
  /** Whether a statement can be run right now. */
  canRun: boolean;
  /** Installs a provider. The statement runs on the operator's channel. */
  onInstall: (provider: string) => void;
  onClose: () => void;
}

type Listing =
  | { status: 'loading' }
  | { status: 'loaded'; providers: Provider[] }
  | { status: 'error'; message: string };

/** What the registry offers, with a way to install each. */
export function AddProviderDialog({
  installed,
  canRun,
  onInstall,
  onClose,
}: AddProviderDialogProps) {
  const [listing, setListing] = useState<Listing>({ status: 'loading' });
  const [search, setSearch] = useState('');

  useEffect(() => {
    let active = true;
    host.explorer.registry().then(
      (providers) => {
        if (active) {
          setListing({ status: 'loaded', providers });
        }
      },
      (error: unknown) => {
        if (active) {
          setListing({ status: 'error', message: toHostError(error).message });
        }
      },
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

  const text = search.trim().toLowerCase();
  const shown =
    listing.status === 'loaded'
      ? listing.providers
          .filter((provider) => provider.name.toLowerCase().includes(text))
          .sort((a, b) => a.name.localeCompare(b.name))
      : [];

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-scrim pt-16"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Add provider"
        className="flex max-h-[76vh] w-[520px] max-w-[92vw] flex-col rounded-md border border-line bg-surface shadow-xl"
      >
        <div className="flex h-9 shrink-0 items-center justify-between border-b border-line px-3">
          <span className="font-semibold">Add provider</span>
          <IconButton label="Close" onClick={onClose}>
            <Close />
          </IconButton>
        </div>
        <div className="shrink-0 px-3 pt-2">
          <p className="mb-2 text-ink-muted">
            Providers in the registry. Installing one runs <code>REGISTRY PULL</code> on the engine.
          </p>
          <input
            type="text"
            spellCheck={false}
            aria-label="Search providers"
            className="selectable mb-2 h-7 w-full rounded border border-line bg-surface px-2"
            placeholder="Search by name"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
            }}
          />
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-3 pb-3">
          {listing.status === 'loading' && (
            <p className="flex items-center gap-2 text-ink-muted">
              <Spinner /> Asking the registry
            </p>
          )}
          {listing.status === 'error' && (
            <p className="selectable break-words text-danger">{listing.message}</p>
          )}
          {listing.status === 'loaded' && shown.length === 0 && (
            <p className="text-ink-muted">No provider matches.</p>
          )}
          {shown.map((provider) => {
            const have = installed.has(provider.name);
            return (
              <div
                key={provider.name}
                className="flex h-8 items-center gap-2 border-b border-line last:border-b-0"
              >
                <span className="min-w-0 flex-1 truncate font-mono text-[12px]">
                  {provider.name}
                </span>
                <span className="shrink-0 text-[12px] text-ink-muted">{provider.version}</span>
                {have ? (
                  <span className="w-[72px] shrink-0 text-right text-[12px] text-ink-muted">
                    installed
                  </span>
                ) : (
                  <button
                    type="button"
                    disabled={!canRun}
                    title={canRun ? undefined : 'A statement is still running'}
                    className="h-6 w-[72px] shrink-0 rounded bg-brand text-on-brand hover:bg-brand-dark disabled:opacity-50"
                    onClick={() => {
                      onInstall(provider.name);
                      onClose();
                    }}
                  >
                    Install
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
