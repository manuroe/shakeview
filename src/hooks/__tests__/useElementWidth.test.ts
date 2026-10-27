import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useElementWidth } from '../useElementWidth';

/** An element whose layout width is `width`, as jsdom reports 0 for everything. */
function elementOfWidth(width: number): Element {
  const el = document.createElement('div');
  el.getBoundingClientRect = () => ({ width } as DOMRect);
  return el;
}

describe('useElementWidth', () => {
  const OriginalResizeObserver = globalThis.ResizeObserver;
  afterEach(() => {
    globalThis.ResizeObserver = OriginalResizeObserver;
  });

  it('returns the fallback until an element is attached', () => {
    const { result } = renderHook(() => useElementWidth(800));
    expect(result.current[1]).toBe(800);
  });

  it('measures the attached element', () => {
    const { result } = renderHook(() => useElementWidth(800));
    act(() => result.current[0](elementOfWidth(640.4)));
    expect(result.current[1]).toBe(640);
  });

  it('keeps the fallback when layout reports 0', () => {
    const { result } = renderHook(() => useElementWidth(800));
    act(() => result.current[0](elementOfWidth(0)));
    expect(result.current[1]).toBe(800);
  });

  it('follows resizes and disconnects when the element detaches', () => {
    let notify = () => {};
    const disconnect = vi.fn();
    globalThis.ResizeObserver = vi.fn().mockImplementation((cb: () => void) => {
      notify = cb;
      return { observe: vi.fn(), unobserve: vi.fn(), disconnect };
    });
    let width = 500;
    const el = document.createElement('div');
    el.getBoundingClientRect = () => ({ width } as DOMRect);

    const { result } = renderHook(() => useElementWidth(800));
    act(() => result.current[0](el));
    expect(result.current[1]).toBe(500);

    width = 1200;
    act(() => notify());
    expect(result.current[1]).toBe(1200);

    act(() => result.current[0](null));
    expect(disconnect).toHaveBeenCalled();
  });
});
