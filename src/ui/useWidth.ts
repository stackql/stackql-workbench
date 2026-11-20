import { useEffect, useRef, useState, type RefObject } from 'react';

const FALLBACK_WIDTH = 720;

/**
 * The width of an element, kept up as it changes, so that what is drawn in
 * it can be sized to it. Until the element has been measured, and where it
 * cannot be, a usual width stands in.
 */
export function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(FALLBACK_WIDTH);
  useEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }
    const measure = () => {
      const next = Math.round(element.getBoundingClientRect().width);
      if (next > 0) {
        setWidth(next);
      }
    };
    measure();
    // Not there in every place the tests run.
    if (typeof ResizeObserver === 'undefined') {
      return;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, []);
  return [ref, width];
}
