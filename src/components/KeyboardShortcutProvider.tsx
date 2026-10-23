import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useThemeStore } from '../stores/themeStore';
import { isInputFocused } from '../utils/shortcuts';
import { useKeyboardShortcuts, type ChordKey } from '../hooks/useKeyboardShortcuts';
import {
  KeyboardShortcutContext,
  type KeyboardShortcutContextValue,
} from './KeyboardShortcutContext';

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

interface KeyboardShortcutProviderProps {
  children: ReactNode;
}

export function KeyboardShortcutProvider({ children }: KeyboardShortcutProviderProps) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { theme, setTheme } = useThemeStore();

  const [showHelp, setShowHelp] = useState(false);
  const [pendingChord, setPendingChord] = useState<string | null>(null);

  // Registered handlers for view-specific actions (LIFO stacks for nested registrations)
  const focusSearchHandlerRef = useRef<(() => void) | null>(null);
  const focusFilterHandlerRef = useRef<(() => void) | null>(null);
  const dismissHandlerRef = useRef<(() => void) | null>(null);
  const focusSearchHandlerStackRef = useRef<(() => void)[]>([]);
  const focusFilterHandlerStackRef = useRef<(() => void)[]>([]);
  const dismissHandlerStackRef = useRef<(() => void)[]>([]);

  // startChord ref — populated after useKeyboardShortcuts hook runs below;
  // declared here so handleKey can call it without a stale closure.
  const startChordRef = useRef<(chord: ChordKey) => void>(() => undefined);

  const registerFocusSearch = useCallback((fn: () => void) => {
    const stack = focusSearchHandlerStackRef.current.slice();
    stack.push(fn);
    focusSearchHandlerStackRef.current = stack;
    focusSearchHandlerRef.current = fn;
    return () => {
      const currentStack = focusSearchHandlerStackRef.current.slice();
      const index = currentStack.lastIndexOf(fn);
      if (index === -1) return;
      currentStack.splice(index, 1);
      focusSearchHandlerStackRef.current = currentStack;
      focusSearchHandlerRef.current = currentStack.length > 0 ? currentStack[currentStack.length - 1] : null;
    };
  }, []);

  const registerFocusFilter = useCallback((fn: () => void) => {
    const stack = focusFilterHandlerStackRef.current.slice();
    stack.push(fn);
    focusFilterHandlerStackRef.current = stack;
    focusFilterHandlerRef.current = fn;
    return () => {
      const currentStack = focusFilterHandlerStackRef.current.slice();
      const index = currentStack.lastIndexOf(fn);
      if (index === -1) return;
      currentStack.splice(index, 1);
      focusFilterHandlerStackRef.current = currentStack;
      focusFilterHandlerRef.current = currentStack.length > 0 ? currentStack[currentStack.length - 1] : null;
    };
  }, []);

  const registerDismiss = useCallback((fn: () => void) => {
    const stack = dismissHandlerStackRef.current.slice();
    stack.push(fn);
    dismissHandlerStackRef.current = stack;
    dismissHandlerRef.current = fn;
    return () => {
      const currentStack = dismissHandlerStackRef.current.slice();
      const index = currentStack.lastIndexOf(fn);
      if (index === -1) return;
      currentStack.splice(index, 1);
      dismissHandlerStackRef.current = currentStack;
      dismissHandlerRef.current = currentStack.length > 0 ? currentStack[currentStack.length - 1] : null;
    };
  }, []);

  const toggleHelp = useCallback(() => setShowHelp((v) => !v), []);

  // Navigate helper that preserves time params
  const navigateTo = useCallback(
    (path: string) => {
      const start = searchParams.get('start');
      const end = searchParams.get('end');
      const params = new URLSearchParams();
      if (start) params.set('start', start);
      if (end) params.set('end', end);
      const qs = params.toString();
      void navigate(qs ? `${path}?${qs}` : path);
    },
    [navigate, searchParams],
  );

  // Cycle theme: system → light → dark → system
  const cycleTheme = useCallback(() => {
    const next = theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system';
    setTheme(next);
  }, [theme, setTheme]);

  // Handle chord completion (g + second key)
  const handleChordComplete = useCallback(
    (_chord: ChordKey, second: string) => {
      setPendingChord(null);
      switch (second) {
        case 's': navigateTo('/summary'); break;
        case 'l': navigateTo('/logs'); break;
        case 't': navigateTo('/triaged'); break;
        case 'n': navigateTo('/spans'); break;
        case 'h': navigateTo('/http_requests'); break;
        case 'y': navigateTo('/http_requests/sync'); break;
        case 'd': navigateTo('/decryption'); break;
        default: break;
      }
    },
    [navigateTo],
  );

  const handleChordStart = useCallback((_chord: ChordKey) => {
    setPendingChord('g');
  }, []);

  const handleChordTimeout = useCallback((_chord: ChordKey) => {
    setPendingChord(null);
  }, []);

  // Handle individual key events
  const handleKey = useCallback(
    (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      const shift = e.shiftKey;

      // --- Modifier-based shortcuts (work even when input is focused) ---

      // Option+/ → focus filter (only when a filter handler is registered)
      if (e.altKey && !meta && !shift && e.code === 'Slash') {
        const handler = focusFilterHandlerRef.current;
        if (handler) {
          e.preventDefault();
          handler();
          return;
        }
      }

      // Cmd+F → focus filter alias (only when a filter handler is registered)
      if (meta && !shift && e.key.toLowerCase() === 'f') {
        const handler = focusFilterHandlerRef.current;
        if (handler) {
          e.preventDefault();
          handler();
          return;
        }
      }

      // Escape → close help overlay first; otherwise call registered dismiss handler
      if (e.key === 'Escape') {
        if (showHelp) {
          setShowHelp(false);
          return;
        }
        dismissHandlerRef.current?.();
        return;
      }

      // Block all other shortcuts while the help overlay is open
      if (showHelp) return;

      // --- Plain-key shortcuts (only when no input is focused) ---
      if (isInputFocused()) return;

      // / → focus search
      if (e.key === '/' && !meta && !shift && !e.altKey) {
        e.preventDefault();
        focusSearchHandlerRef.current?.();
        return;
      }

      // Chord leader: g
      if (e.key.toLowerCase() === 'g' && !meta && !shift && !e.altKey) {
        e.preventDefault();
        startChordRef.current('g');
        return;
      }

      // ? → toggle help
      if (e.key === '?' && !meta) {
        e.preventDefault();
        setShowHelp((v) => !v);
        return;
      }

      // t → cycle theme
      if (e.key.toLowerCase() === 't' && !meta && !shift) {
        e.preventDefault();
        cycleTheme();
        return;
      }
    },
    [cycleTheme, showHelp],
  );

  const { startChord } = useKeyboardShortcuts({
    onChordStart: handleChordStart,
    onChordComplete: handleChordComplete,
    onChordTimeout: handleChordTimeout,
    onKey: handleKey,
  });

  // Keep startChordRef in sync after each render (outside render path)
  useLayoutEffect(() => {
    startChordRef.current = startChord;
  });

  const contextValue: KeyboardShortcutContextValue = {
    showHelp,
    toggleHelp,
    pendingChord,
    registerFocusSearch,
    registerFocusFilter,
    registerDismiss,
  };

  return (
    <KeyboardShortcutContext.Provider value={contextValue}>
      {children}
    </KeyboardShortcutContext.Provider>
  );
}
