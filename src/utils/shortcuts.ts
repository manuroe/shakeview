/**
 * Keyboard shortcut definitions.
 *
 * Conventions:
 * - Navigation uses Vim-style go-to chords: press `g` then a letter
 * - Actions use modifier keys (Cmd/Ctrl) to avoid conflicts with text inputs
 * - Plain keys without modifiers are only active when no input is focused
 */

export type ShortcutCategory =
  | 'navigation'
  | 'search'
  | 'filter'
  | 'session'
  | 'theme'
  | 'ui';

export interface ShortcutDef {
  /** Human-readable key label(s), e.g. "g → s" or "Cmd+/" */
  label: string;
  /** Short description of the action */
  description: string;
  /** Category for grouping in the help overlay */
  category: ShortcutCategory;
  /**
   * If true, this shortcut only works when no input element is focused
   * (non-modifier shortcuts). Default: false (modifier-based shortcuts
   * work regardless of focus).
   */
  requiresNoInputFocus?: boolean;
}

export const SHORTCUT_CATEGORIES: Record<ShortcutCategory, string> = {
  navigation: 'Navigation',
  search: 'Search',
  filter: 'Filter',
  session: 'Session',
  theme: 'Theme',
  ui: 'UI',
};

/** All shortcut definitions, keyed by a unique action name */
export const SHORTCUTS = {
  goSummary: {
    label: 'g → s',
    description: 'Go to Summary',
    category: 'navigation',
    requiresNoInputFocus: true,
  },
  goLogs: {
    label: 'g → l',
    description: 'Go to Logs',
    category: 'navigation',
    requiresNoInputFocus: true,
  },
  goTriaged: {
    label: 'g → t',
    description: 'Go to logs by target',
    category: 'navigation',
    requiresNoInputFocus: true,
  },
  goSpans: {
    label: 'g → n',
    description: 'Go to logs by span',
    category: 'navigation',
    requiresNoInputFocus: true,
  },
  goHttp: {
    label: 'g → h',
    description: 'Go to HTTP Requests',
    category: 'navigation',
    requiresNoInputFocus: true,
  },
  goSync: {
    label: 'g → y',
    description: 'Go to Sync',
    category: 'navigation',
    requiresNoInputFocus: true,
  },
  goDecryption: {
    label: 'g → d',
    description: 'Go to Megolm decryption',
    category: 'navigation',
    requiresNoInputFocus: true,
  },
  focusSearch: {
    label: '/',
    description: 'Focus search input',
    category: 'search',
    requiresNoInputFocus: true,
  },
  focusFilter: {
    label: 'Option+/',
    description: 'Focus filter input (also Cmd+F)',
    category: 'filter',
    requiresNoInputFocus: false,
  },
  toggleLineWrap: {
    label: 'w',
    description: 'Toggle line wrap (Logs view)',
    category: 'filter',
    requiresNoInputFocus: true,
  },
  toggleStripPrefix: {
    label: 'p',
    description: 'Toggle strip prefix (Logs view)',
    category: 'filter',
    requiresNoInputFocus: true,
  },
  openExport: {
    label: 'Cmd+S',
    description: 'Open export / save dialog (Logs view)',
    category: 'filter',
    requiresNoInputFocus: false,
  },
  newSession: {
    label: 'Cmd+R',
    description: 'Refresh page for a new session (browser default)',
    category: 'session',
    requiresNoInputFocus: false,
  },
  toggleTheme: {
    label: 't',
    description: 'Cycle theme (light → dark → system)',
    category: 'theme',
    requiresNoInputFocus: true,
  },
  showHelp: {
    label: '?',
    description: 'Open help',
    category: 'ui',
    requiresNoInputFocus: true,
  },
  dismiss: {
    label: 'Escape',
    description: 'Dismiss overlay / close panel',
    category: 'ui',
    requiresNoInputFocus: false,
  },
} satisfies Record<string, ShortcutDef>;

export type ShortcutAction = keyof typeof SHORTCUTS;

/** Returns true if the currently focused element is a text input */
export function isInputFocused(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  if (el instanceof HTMLElement) {
    if (el.isContentEditable) return true;
    const role = el.getAttribute('role');
    if (role && role.toLowerCase() === 'textbox') return true;
  }
  return false;
}

/** True when running on an Apple platform (Mac / iOS) */
const isApplePlatform =
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);

/** Display label for the Cmd key depending on platform */
export const metaKey = isApplePlatform ? '⌘' : 'Ctrl';

/** Display label for the Option/Alt key depending on platform */
export const optionKey = isApplePlatform ? '⌥' : 'Alt';
