import { create } from 'zustand';
import { persist } from 'zustand/middleware';

type Theme = 'light' | 'dark' | 'system';

interface ThemeStore {
  theme: Theme;
  setTheme: (theme: Theme) => void;
}

// Apply theme to document
function applyTheme(theme: Theme) {
  if (typeof document === 'undefined') return;
  
  try {
    const root = document.documentElement;
    
    // Compound tokens follow prefers-color-scheme unless a cpd-theme-* class forces one.
    root.classList.remove('cpd-theme-light', 'cpd-theme-dark');
    if (theme === 'system') {
      root.removeAttribute('data-theme');
    } else {
      root.setAttribute('data-theme', theme);
      root.classList.add(`cpd-theme-${theme}`);
    }
  } catch {
    // document may not be available in tests
  }

  // Sync to chrome.storage.local so the content script (which runs on a
  // different origin and cannot read the extension's localStorage) can also
  // observe the user's explicit preference.
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      // eslint-disable-next-line @typescript-eslint/naming-convention -- chrome.storage key follows extension convention, not camelCase
      void chrome.storage.local.set({ 'rs-theme': theme }).catch(() => {});
    }
  } catch {
    // Not in an extension context, or storage API unavailable
  }
}

// Get initial theme from localStorage or default to system
function getInitialTheme(): Theme {
  if (typeof window === 'undefined') return 'system';
  
  try {
    const stored = localStorage.getItem('theme-storage');
    if (stored) {
      const parsed = JSON.parse(stored);
      return parsed.state?.theme || 'system';
    }
  } catch {
    // localStorage may not be available or may throw in tests
  }
  return 'system';
}

// Apply initial theme immediately to prevent flash
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  try {
    applyTheme(getInitialTheme());
  } catch {
    // Ignore errors during initialization in test environment
  }
}

export const useThemeStore = create<ThemeStore>()(
  persist(
    (set) => ({
      theme: 'system',
      setTheme: (theme) => {
        applyTheme(theme);
        set({ theme });
      },
    }),
    {
      name: 'theme-storage',
      onRehydrateStorage: () => (state) => {
        // Apply theme after rehydration
        if (state) {
          applyTheme(state.theme);
        }
      },
    }
  )
);
