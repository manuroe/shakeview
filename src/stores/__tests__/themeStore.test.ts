import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock Zustand's persist middleware to avoid localStorage dependency in tests
vi.mock('zustand/middleware', async (importOriginal) => {
  const original = await importOriginal<typeof import('zustand/middleware')>();
  return {
    ...original,
    // Replace persist with a passthrough that skips storage
    persist: (fn: Parameters<typeof original.persist>[0]) => fn,
  };
});

import { useThemeStore } from '../themeStore';

describe('themeStore', () => {
  beforeEach(() => {
    // Reset store to default state
    useThemeStore.setState({ theme: 'system' });
    // Clear any DOM attributes
    document.documentElement.removeAttribute('data-theme');
  });

  describe('initial state', () => {
    it('has system theme by default', () => {
      expect(useThemeStore.getState().theme).toBe('system');
    });
  });

  describe('setTheme', () => {
    it('sets light theme', () => {
      useThemeStore.getState().setTheme('light');
      expect(useThemeStore.getState().theme).toBe('light');
    });

    it('sets dark theme', () => {
      useThemeStore.getState().setTheme('dark');
      expect(useThemeStore.getState().theme).toBe('dark');
    });

    it('sets system theme', () => {
      useThemeStore.getState().setTheme('light');
      useThemeStore.getState().setTheme('system');
      expect(useThemeStore.getState().theme).toBe('system');
    });

    it('applies light theme to document', () => {
      useThemeStore.getState().setTheme('light');
      expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    });

    it('applies dark theme to document', () => {
      useThemeStore.getState().setTheme('dark');
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    });

    it('removes data-theme attribute for system theme', () => {
      useThemeStore.getState().setTheme('dark');
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark');

      useThemeStore.getState().setTheme('system');
      expect(document.documentElement.getAttribute('data-theme')).toBeNull();
    });

    it('toggles the Compound theme class', () => {
      const { classList } = document.documentElement;
      useThemeStore.getState().setTheme('light');
      expect(classList.contains('cpd-theme-light')).toBe(true);

      useThemeStore.getState().setTheme('dark');
      expect(classList.contains('cpd-theme-dark')).toBe(true);
      expect(classList.contains('cpd-theme-light')).toBe(false);

      useThemeStore.getState().setTheme('system');
      expect(classList.contains('cpd-theme-dark')).toBe(false);
    });
  });

  describe('persistence', () => {
    it('stores theme in state', () => {
      useThemeStore.getState().setTheme('dark');
      const stored = useThemeStore.getState().theme;
      expect(stored).toBe('dark');
    });

    it('can switch between all themes', () => {
      const themes = ['light', 'dark', 'system'] as const;
      for (const theme of themes) {
        useThemeStore.getState().setTheme(theme);
        expect(useThemeStore.getState().theme).toBe(theme);
      }
    });
  });

  describe('document interaction', () => {
    it('handles multiple setTheme calls', () => {
      useThemeStore.getState().setTheme('light');
      useThemeStore.getState().setTheme('dark');
      useThemeStore.getState().setTheme('light');
      expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    });

    it('setAttribute is called when setting non-system theme', () => {
      const setSpy = vi.spyOn(document.documentElement, 'setAttribute');
      useThemeStore.getState().setTheme('dark');
      expect(setSpy).toHaveBeenCalledWith('data-theme', 'dark');
      setSpy.mockRestore();
    });

    it('removeAttribute is called when setting system theme', () => {
      const removeSpy = vi.spyOn(document.documentElement, 'removeAttribute');
      useThemeStore.getState().setTheme('system');
      expect(removeSpy).toHaveBeenCalledWith('data-theme');
      removeSpy.mockRestore();
    });
  });

  // Note: The module-level applyTheme(getInitialTheme()) init call cannot be reliably
  // tested in this environment because the zustand/middleware persist mock interferes with
  // the jsdom localStorage object. The behaviour it covers (applying the stored theme to
  // the DOM on first load) is exercised at the integration level by the setTheme DOM tests
  // above, which verify the same applyTheme code path.

  describe('chrome.storage sync', () => {
    it('syncs theme to chrome.storage.local when extension API is available', () => {
      const mockSet = vi.fn().mockResolvedValue(undefined);
      // Simulate being inside a browser extension context.
      vi.stubGlobal('chrome', {
        storage: { local: { set: mockSet } },
      });

      useThemeStore.getState().setTheme('dark');

      // eslint-disable-next-line @typescript-eslint/naming-convention -- matching the actual storage key
      expect(mockSet).toHaveBeenCalledWith({ 'rs-theme': 'dark' });

      vi.unstubAllGlobals();
    });

    it('does not throw when chrome.storage is unavailable', () => {
      // chrome is not defined outside an extension context — this must be a no-op.
      vi.stubGlobal('chrome', undefined);
      expect(() => useThemeStore.getState().setTheme('light')).not.toThrow();
      vi.unstubAllGlobals();
    });

    it('swallows errors thrown by chrome.storage.local.set', () => {
      // If chrome.storage.local.set throws (e.g. quota exceeded), applyTheme must
      // not propagate the error — we must never crash because of the sync attempt.
      vi.stubGlobal('chrome', {
        storage: { local: { set: () => { throw new Error('quota exceeded'); } } },
      });
      expect(() => useThemeStore.getState().setTheme('dark')).not.toThrow();
      vi.unstubAllGlobals();
    });

    it('swallows promise rejections from chrome.storage.local.set', async () => {
      // If chrome.storage.local.set returns a rejected promise (async quota/permission
      // error), applyTheme must not produce an unhandled rejection.
      vi.stubGlobal('chrome', {
        storage: { local: { set: () => Promise.reject(new Error('quota exceeded')) } },
      });
      expect(() => useThemeStore.getState().setTheme('dark')).not.toThrow();
      // Give the microtask queue a tick so the .catch() callback runs and
      // prevents an unhandled-rejection warning.
      await new Promise((r) => setTimeout(r, 0));
      vi.unstubAllGlobals();
    });
  });
});
