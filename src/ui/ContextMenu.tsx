import { useEffect, useLayoutEffect, useRef, useState } from 'react';

export interface MenuItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
}

interface ContextMenuProps {
  /** Where the pointer was, in the window. */
  x: number;
  y: number;
  /** What the menu is for, for assistive technology. */
  label: string;
  items: MenuItem[];
  onClose: () => void;
}

/** A menu at the pointer. Esc, a click elsewhere or a scroll closes it. */
export function ContextMenu({ x, y, label, items, onClose }: ContextMenuProps) {
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });

  // Keep the whole menu inside the window.
  useLayoutEffect(() => {
    const box = menu.current?.getBoundingClientRect();
    if (!box) {
      return;
    }
    setPosition({
      left: Math.max(4, Math.min(x, window.innerWidth - box.width - 4)),
      top: Math.max(4, Math.min(y, window.innerHeight - box.height - 4)),
    });
  }, [x, y]);

  useEffect(() => {
    const onPointer = (event: MouseEvent) => {
      if (!menu.current?.contains(event.target as Node)) {
        onClose();
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('mousedown', onPointer);
    window.addEventListener('keydown', onKey);
    window.addEventListener('blur', onClose);
    window.addEventListener('wheel', onClose, { passive: true });
    menu.current?.querySelector<HTMLElement>('[role=menuitem]:not(:disabled)')?.focus();
    return () => {
      window.removeEventListener('mousedown', onPointer);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('wheel', onClose);
    };
  }, [onClose]);

  return (
    <div
      ref={menu}
      role="menu"
      aria-label={label}
      className="fixed z-50 min-w-[200px] rounded-md border border-line bg-surface py-1 shadow-lg"
      style={position}
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          disabled={item.disabled}
          className="flex h-7 w-full items-center px-3 text-left hover:bg-surface-sunken disabled:opacity-50"
          onClick={() => {
            onClose();
            item.onSelect();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
