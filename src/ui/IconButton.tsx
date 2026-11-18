import type { ReactNode } from 'react';

interface IconButtonProps {
  label: string;
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
  active?: boolean;
  className?: string;
}

/** The look of an icon button, for a control that draws its own button. */
export const ICON_BUTTON_CLASS =
  'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-ink-muted hover:bg-surface-sunken hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent';

/** A square button that shows only an icon. The label is its tooltip and accessible name. */
export function IconButton({
  label,
  onClick,
  children,
  disabled,
  active,
  className,
}: IconButtonProps) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={`${ICON_BUTTON_CLASS} ${
        active ? 'bg-surface-sunken text-ink' : ''
      } ${className ?? ''}`}
    >
      {children}
    </button>
  );
}
