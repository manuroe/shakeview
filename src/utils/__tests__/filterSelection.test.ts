import { describe, it, expect } from 'vitest';
import { toggleFilterKey } from '../filterSelection';

describe('toggleFilterKey', () => {
  const all = ['a', 'b', 'c'];

  it('from all, unticking one keeps every other key, listed or not', () => {
    expect(toggleFilterKey(null, all, 'a')).toEqual(new Set(['b', 'c']));
  });

  it('ticks and unticks within a selection', () => {
    expect(toggleFilterKey(new Set(['a']), all, 'b')).toEqual(new Set(['a', 'b']));
    expect(toggleFilterKey(new Set(['a', 'b']), all, 'b')).toEqual(new Set(['a']));
  });

  it('nothing or everything selected is all', () => {
    expect(toggleFilterKey(new Set(['a']), all, 'a')).toBeNull();
    expect(toggleFilterKey(new Set(['a', 'b']), all, 'c')).toBeNull();
    expect(toggleFilterKey(null, ['a'], 'a')).toBeNull();
  });
});
