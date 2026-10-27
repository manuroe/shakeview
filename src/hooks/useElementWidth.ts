import { useCallback, useRef, useState } from 'react';

/**
 * Rendered width (px) of the element the returned callback ref is attached to,
 * kept current with a ResizeObserver. Returns `fallback` until the element is
 * measured (and wherever layout reports 0, e.g. jsdom).
 *
 * Charts use it as their viewBox width so the SVG draws at 1:1 scale and fills
 * its container, instead of a fixed-width viewBox letterboxed in the middle.
 */
export function useElementWidth(fallback: number): [(el: Element | null) => void, number] {
  const [width, setWidth] = useState(fallback);
  const observer = useRef<ResizeObserver | null>(null);

  const ref = useCallback((el: Element | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el) return;
    const update = () => {
      const w = Math.round(el.getBoundingClientRect().width);
      if (w > 0) setWidth(w);
    };
    update();
    observer.current = new ResizeObserver(update);
    observer.current.observe(el);
  }, []);

  return [ref, width];
}
