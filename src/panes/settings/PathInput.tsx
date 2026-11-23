import { useState } from 'react';
import { host, toHostError, type PathPurpose } from '../../host';

interface PathInputProps {
  id: string;
  /** What the path is for. The host opens a file or a folder dialog to match. */
  purpose: PathPurpose;
  /** Names the field for the Browse button, for example "the stackql location". */
  label: string;
  value: string;
  placeholder: string;
  /** Where the dialog opens while the field is empty, for example the path in use. */
  fallback?: string | null;
  onChange: (value: string) => void;
}

/**
 * A path the operator can type or choose. Browse opens the system's own
 * dialog through the host, and the chosen path goes into the field like
 * typed text, so nothing is saved until the operator saves.
 */
export function PathInput({
  id,
  purpose,
  label,
  value,
  placeholder,
  fallback,
  onChange,
}: PathInputProps) {
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const browse = () => {
    setPicking(true);
    setError(null);
    host.pickPath(purpose, value.trim() || fallback || null).then(
      (picked) => {
        setPicking(false);
        if (picked !== null) {
          onChange(picked);
        }
      },
      (reason: unknown) => {
        setPicking(false);
        setError(toHostError(reason).message);
      },
    );
  };

  return (
    <>
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="text"
          spellCheck={false}
          className="selectable h-7 min-w-0 flex-1 rounded border border-line bg-surface px-2 font-mono text-[12px]"
          placeholder={placeholder}
          value={value}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        />
        <button
          type="button"
          aria-label={`Browse for ${label}`}
          className="h-7 shrink-0 rounded border border-line bg-surface px-3 hover:bg-surface-sunken disabled:opacity-50"
          disabled={picking}
          onClick={browse}
        >
          Browse
        </button>
      </div>
      {error && <p className="selectable mt-1 text-[12px] text-danger">{error}</p>}
    </>
  );
}
