import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

interface PopoverProps {
  /** What the trigger says to assistive technology, and its tooltip. */
  label: string;
  /** The trigger's content. */
  trigger: ReactNode;
  triggerClassName?: string;
  /** Where the panel opens relative to the trigger. */
  placement?: 'top' | 'bottom';
  align?: 'start' | 'end';
  children: ReactNode;
}

/** A button that opens a small panel beside it. Esc or a click elsewhere closes it. */
export function Popover({
  label,
  trigger,
  triggerClassName,
  placement = 'bottom',
  align = 'start',
  children,
}: PopoverProps) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointer = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };
    window.addEventListener('mousedown', onPointer);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onPointer);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <span ref={root} className="relative inline-flex">
      <button
        type="button"
        title={label}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        className={triggerClassName}
        onClick={() => {
          setOpen((current) => !current);
        }}
      >
        {trigger}
      </button>
      {open && (
        <div
          id={panelId}
          role="dialog"
          aria-label={label}
          className={`absolute z-40 min-w-[280px] rounded-md border border-line bg-surface p-3 text-[13px] text-ink shadow-lg ${
            placement === 'top' ? 'bottom-full mb-1' : 'top-full mt-1'
          } ${align === 'end' ? 'right-0' : 'left-0'}`}
        >
          {children}
        </div>
      )}
    </span>
  );
}
