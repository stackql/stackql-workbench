import { useEffect, useRef } from 'react';
import type { Tab } from '../../lib/tabs';
import { Close, Plus } from '../../ui/icons';

interface TabStripProps {
  tabs: Tab[];
  activeId: string;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
}

/** The row of editor tabs, with a button for a new one. */
export function TabStrip({ tabs, activeId, onActivate, onClose, onNew }: TabStripProps) {
  const strip = useRef<HTMLDivElement>(null);

  // A tab opened or chosen out of sight is brought into view. The strip has
  // no size until its view is shown, so this runs again when it gets one.
  useEffect(() => {
    const element = strip.current;
    if (!element) {
      return;
    }
    const show = () => {
      element
        .querySelector('[role=tab][aria-selected=true]')
        ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    };
    show();
    const observer = new ResizeObserver(show);
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [activeId, tabs.length]);

  return (
    <div
      ref={strip}
      role="tablist"
      aria-label="Editor tabs"
      // No scrollbar: it would cover the tabs. The wheel and the keys still scroll.
      className="flex h-8 min-w-0 flex-1 items-stretch overflow-x-auto [scrollbar-width:none]"
    >
      {tabs.map((tab) => {
        const active = tab.id === activeId;
        return (
          <div
            key={tab.id}
            className={`group flex shrink-0 items-center border-r border-line ${
              active
                ? 'bg-surface text-ink shadow-[inset_0_2px_0_var(--color-accent)]'
                : 'text-ink-muted hover:bg-surface-sunken'
            }`}
          >
            <button
              type="button"
              role="tab"
              aria-selected={active}
              title={tab.title}
              className="h-full max-w-[220px] truncate pr-1 pl-3 font-mono text-[12px]"
              onClick={() => {
                onActivate(tab.id);
              }}
              onAuxClick={(event) => {
                // A middle click closes, as in other tabbed editors.
                if (event.button === 1) {
                  onClose(tab.id);
                }
              }}
            >
              {tab.title}
            </button>
            <button
              type="button"
              title={`Close ${tab.title}`}
              aria-label={`Close ${tab.title}`}
              className={`mr-1 flex h-5 w-5 items-center justify-center rounded hover:bg-line ${
                active ? '' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'
              }`}
              onClick={() => {
                onClose(tab.id);
              }}
            >
              <Close />
            </button>
          </div>
        );
      })}
      <button
        type="button"
        title="New tab"
        aria-label="New tab"
        className="flex w-8 shrink-0 items-center justify-center text-ink-muted hover:bg-surface-sunken hover:text-ink"
        onClick={onNew}
      >
        <Plus />
      </button>
    </div>
  );
}
