import { useState } from 'react';

interface JumpBoxProps {
  /** Goes to the named node. Resolves to a message when it cannot. */
  onJump: (text: string) => Promise<string | null>;
  onClose: () => void;
}

/** A box for going straight to `provider.service.resource`. */
export function JumpBox({ onJump, onClose }: JumpBoxProps) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const go = () => {
    if (busy || text.trim() === '') {
      return;
    }
    setBusy(true);
    setError(null);
    void onJump(text).then((problem) => {
      setBusy(false);
      if (problem === null) {
        onClose();
      } else {
        setError(problem);
      }
    });
  };

  return (
    <div className="absolute inset-x-2 top-10 z-30 rounded-md border border-line bg-surface p-2 shadow-lg">
      <input
        autoFocus
        type="text"
        spellCheck={false}
        aria-label="Go to resource"
        className="selectable h-7 w-full rounded border border-line bg-surface px-2 font-mono text-[12px]"
        placeholder="provider.service.resource"
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          setError(null);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            go();
          } else if (event.key === 'Escape') {
            event.stopPropagation();
            onClose();
          }
        }}
        onBlur={onClose}
      />
      <p className={`mt-1 text-[12px] ${error ? 'text-danger' : 'text-ink-muted'}`}>
        {error ?? (busy ? 'Looking it up' : 'Enter goes there. Esc closes.')}
      </p>
    </div>
  );
}
