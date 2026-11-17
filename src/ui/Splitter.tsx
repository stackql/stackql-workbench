import type { PointerEvent as ReactPointerEvent } from 'react';

interface SplitterProps {
  /** `vertical` is a vertical bar between side-by-side panes. */
  orientation: 'vertical' | 'horizontal';
  /** Called with the distance dragged since the last call, in pixels. */
  onResize: (deltaPx: number) => void;
  label: string;
}

/** A draggable bar between two panes. */
export function Splitter({ orientation, onResize, label }: SplitterProps) {
  const vertical = orientation === 'vertical';

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const bar = event.currentTarget;
    bar.setPointerCapture(event.pointerId);
    let last = vertical ? event.clientX : event.clientY;

    const move = (moveEvent: PointerEvent) => {
      const position = vertical ? moveEvent.clientX : moveEvent.clientY;
      onResize(position - last);
      last = position;
    };
    const end = () => {
      bar.removeEventListener('pointermove', move);
      bar.removeEventListener('pointerup', end);
      bar.removeEventListener('pointercancel', end);
    };
    bar.addEventListener('pointermove', move);
    bar.addEventListener('pointerup', end);
    bar.addEventListener('pointercancel', end);
  };

  return (
    <div
      role="separator"
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      aria-label={label}
      onPointerDown={onPointerDown}
      className={
        vertical
          ? 'w-1 shrink-0 cursor-col-resize bg-line hover:bg-accent/60'
          : 'h-1 shrink-0 cursor-row-resize bg-line hover:bg-accent/60'
      }
    />
  );
}
