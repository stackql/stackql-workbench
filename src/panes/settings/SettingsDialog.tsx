import { useEffect, useId, useState, type ReactNode } from 'react';
import { host, toHostError, type EngineStatus, type Settings } from '../../host';
import { IconButton } from '../../ui/IconButton';
import { Close } from '../../ui/icons';

interface SettingsDialogProps {
  status: EngineStatus;
  onClose: () => void;
  /** Extra sections, shown under the engine settings. */
  children?: ReactNode;
}

/** Engine settings. Saving restarts the engine when a setting it depends on changed. */
export function SettingsDialog({ status, onClose, children }: SettingsDialogProps) {
  const [loaded, setLoaded] = useState<Settings | null>(null);
  const [enginePath, setEnginePath] = useState('');
  const [envFile, setEnvFile] = useState('');
  const [approot, setApproot] = useState('');
  const [warning, setWarning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const pathId = useId();
  const envId = useId();
  const approotId = useId();

  useEffect(() => {
    let active = true;
    host.settingsGet().then(
      (view) => {
        if (!active) {
          return;
        }
        setLoaded(view.settings);
        setEnginePath(view.settings.enginePath ?? '');
        setEnvFile(view.settings.envFile ?? '');
        setApproot(view.settings.approot ?? '');
        setWarning(view.warning);
      },
      (reason: unknown) => {
        if (active) {
          setError(toHostError(reason).message);
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

  const dirty =
    loaded !== null &&
    (enginePath.trim() !== (loaded.enginePath ?? '') ||
      envFile.trim() !== (loaded.envFile ?? '') ||
      approot.trim() !== (loaded.approot ?? ''));

  const save = () => {
    if (!loaded) {
      return;
    }
    setSaving(true);
    setError(null);
    host
      .settingsSave({
        ...loaded,
        enginePath: enginePath.trim() || null,
        envFile: envFile.trim() || null,
        approot: approot.trim() || null,
      })
      .then(
        (saved) => {
          setLoaded(saved);
          setEnginePath(saved.enginePath ?? '');
          setEnvFile(saved.envFile ?? '');
          setApproot(saved.approot ?? '');
          setSaving(false);
        },
        (reason: unknown) => {
          setError(toHostError(reason).message);
          setSaving(false);
        },
      );
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-16"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        className="flex max-h-[80vh] w-[620px] max-w-[92vw] flex-col rounded-md border border-line bg-surface shadow-xl"
      >
        <div className="flex h-9 shrink-0 items-center justify-between border-b border-line px-3">
          <span className="font-semibold">Settings</span>
          <IconButton label="Close settings" onClick={onClose}>
            <Close />
          </IconButton>
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
          {warning && <p className="selectable mb-3 text-warn">{warning}</p>}

          <h2 className="mb-2 text-[11px] font-semibold tracking-wide text-ink-muted uppercase">
            Engine
          </h2>

          <label htmlFor={pathId} className="block font-semibold">
            stackql location
          </label>
          <p className="mb-1 text-ink-muted">
            Leave empty to search: the STACKQL_BIN variable, beside this app, the usual install
            locations, then PATH.
          </p>
          <input
            id={pathId}
            type="text"
            spellCheck={false}
            className="selectable h-7 w-full rounded border border-line bg-surface px-2 font-mono text-[12px]"
            placeholder={status.location ?? 'Path to the stackql binary'}
            value={enginePath}
            onChange={(event) => {
              setEnginePath(event.target.value);
            }}
          />
          <p className="selectable mt-1 mb-3 text-[12px] text-ink-muted">
            {status.location
              ? `In use: ${status.location}${status.version ? `, version ${status.version}` : ''}${
                  status.locationSource ? `, found via ${status.locationSource}` : ''
                }`
              : 'No engine has been found.'}
          </p>

          <label htmlFor={approotId} className="block font-semibold">
            Engine data folder
          </label>
          <p className="mb-1 text-ink-muted">
            Optional. Where the engine keeps the providers it has pulled. Leave empty to use a
            .stackql folder beside this app, or the app data folder when that place cannot be
            written to. Providers pulled into one folder are not seen from another.
          </p>
          <input
            id={approotId}
            type="text"
            spellCheck={false}
            className="selectable h-7 w-full rounded border border-line bg-surface px-2 font-mono text-[12px]"
            placeholder={status.dataFolder ?? 'Full path to a folder'}
            value={approot}
            onChange={(event) => {
              setApproot(event.target.value);
            }}
          />
          <p className="selectable mt-1 text-[12px] text-ink-muted">
            {status.dataFolder
              ? `In use: ${status.dataFolder}${
                  status.dataFolderSource ? `, ${status.dataFolderSource}` : ''
                }`
              : 'No folder is in use yet.'}
          </p>
          {status.dataFolderNote && (
            <p className="selectable mt-1 text-[12px] text-warn">{status.dataFolderNote}</p>
          )}

          <label htmlFor={envId} className="mt-3 block font-semibold">
            Credentials file
          </label>
          <p className="mb-1 text-ink-muted">
            Optional. A dotenv file with the environment variables your providers need. The engine
            reads it at startup. This app never reads or shows its contents.
          </p>
          <input
            id={envId}
            type="text"
            spellCheck={false}
            className="selectable h-7 w-full rounded border border-line bg-surface px-2 font-mono text-[12px]"
            placeholder="Path to a .env file"
            value={envFile}
            onChange={(event) => {
              setEnvFile(event.target.value);
            }}
          />

          {error && <p className="selectable mt-3 text-danger">{error}</p>}

          <div className="mt-3 flex items-center justify-end gap-2">
            <span className="mr-auto text-[12px] text-ink-muted">
              Saving a change here restarts the engine.
            </span>
            <button
              type="button"
              className="h-7 rounded bg-brand px-3 text-on-brand hover:bg-brand-dark disabled:opacity-50"
              disabled={!dirty || saving}
              onClick={save}
            >
              {saving ? 'Saving' : 'Save engine settings'}
            </button>
          </div>

          {children}
        </div>
      </div>
    </div>
  );
}
