import { useEffect, useRef, useState } from 'react';
import { MENUS, shortcutLabel, type CommandId } from '../../lib/menu';
import { Check } from '../../ui/icons';

interface MenuBarProps {
  isMac: boolean;
  onCommand: (id: CommandId) => void;
  /** Commands that cannot run right now. They are shown dimmed. */
  disabled?: ReadonlySet<CommandId>;
  /** The choices that are in effect. They are shown with a mark. */
  chosen?: ReadonlySet<CommandId>;
}

/**
 * The menu bar. Its menus repeat what the side menu and the panes already
 * offer, so everything can be found in one place.
 *
 * The menus are drawn in the webview, so they look and behave the same on
 * every platform and can be checked like any other part of the page.
 */
export function MenuBar({ isMac, onCommand, disabled, chosen }: MenuBarProps) {
  const [open, setOpen] = useState<number | null>(null);
  const bar = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open === null) {
      return;
    }
    const onPointer = (event: MouseEvent) => {
      if (!bar.current?.contains(event.target as Node)) {
        setOpen(null);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(null);
      } else if (event.key === 'ArrowRight') {
        setOpen((current) => (current === null ? null : (current + 1) % MENUS.length));
      } else if (event.key === 'ArrowLeft') {
        setOpen((current) =>
          current === null ? null : (current + MENUS.length - 1) % MENUS.length,
        );
      }
    };
    const onBlur = () => {
      setOpen(null);
    };
    window.addEventListener('mousedown', onPointer);
    window.addEventListener('keydown', onKey);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('mousedown', onPointer);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', onBlur);
    };
  }, [open]);

  return (
    <div
      ref={bar}
      role="menubar"
      aria-label="Application menu"
      className="flex h-7 shrink-0 items-center gap-0.5 bg-surface-alt px-1"
    >
      {MENUS.map((menu, index) => (
        <div key={menu.label} className="relative">
          <button
            type="button"
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={open === index}
            className={`h-6 rounded px-2 hover:bg-surface-sunken ${
              open === index ? 'bg-surface-sunken' : ''
            }`}
            // Keep the cursor where it is, so Edit commands act on it.
            onMouseDown={(event) => {
              event.preventDefault();
            }}
            onClick={() => {
              setOpen((current) => (current === index ? null : index));
            }}
            onMouseEnter={() => {
              setOpen((current) => (current === null ? null : index));
            }}
          >
            {menu.label}
          </button>
          {open === index && (
            <div
              role="menu"
              aria-label={menu.label}
              className="absolute top-full left-0 z-40 mt-0.5 min-w-[220px] rounded-md border border-line bg-surface py-1 shadow-lg"
            >
              {menu.entries.map((entry, position) =>
                entry.kind === 'separator' ? (
                  <div
                    key={`separator-${position}`}
                    role="separator"
                    className="my-1 h-px bg-line"
                  />
                ) : (
                  <button
                    key={entry.id}
                    type="button"
                    role={entry.choice ? 'menuitemradio' : 'menuitem'}
                    aria-checked={entry.choice ? (chosen?.has(entry.id) ?? false) : undefined}
                    data-command={entry.id}
                    disabled={disabled?.has(entry.id)}
                    className="flex h-7 w-full items-center gap-6 px-3 text-left whitespace-nowrap hover:bg-surface-sunken disabled:opacity-50 disabled:hover:bg-transparent"
                    onMouseDown={(event) => {
                      event.preventDefault();
                    }}
                    onClick={() => {
                      setOpen(null);
                      onCommand(entry.id);
                    }}
                  >
                    <span className="flex-1">{entry.label}</span>
                    {entry.choice && chosen?.has(entry.id) && <Check className="text-accent" />}
                    {entry.shortcut && (
                      <span className="text-[12px] text-ink-muted">
                        {shortcutLabel(entry.shortcut, isMac)}
                      </span>
                    )}
                  </button>
                ),
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
