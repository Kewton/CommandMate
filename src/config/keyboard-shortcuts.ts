/**
 * Keyboard shortcut registry (Issue #1130)
 *
 * Single source of truth for the app's keyboard shortcuts, consumed by the `?`
 * help overlay ({@link KeyboardShortcutsOverlay}) and the command palette's
 * "Keyboard shortcuts" action. Display-only: the actual key handling still lives
 * in each feature (command palette, terminal search, composer). Registering a
 * shortcut here does NOT wire a handler — it only documents an existing binding.
 *
 * `keys` render as {@link Kbd} caps in order; the {@link MOD_KEY_TOKEN} token
 * resolves to ⌘ on macOS and Ctrl elsewhere at render time (SSR-safe). Human
 * descriptions come from the `keyboardShortcuts` i18n namespace
 * (`shortcuts.<id>`); scope headings from `scopes.<scope>`.
 */

/** Grouping bucket for a shortcut in the help overlay. */
export type ShortcutScope = 'global' | 'terminal' | 'composer';

/** Placeholder key cap that renders as ⌘ (macOS) or Ctrl (everywhere else). */
export const MOD_KEY_TOKEN = 'MOD';

export interface KeyboardShortcut {
  /** Stable id; also the i18n description key suffix and the overlay row key. */
  id: string;
  /** Key caps to render (in order). Use {@link MOD_KEY_TOKEN} for the mod key. */
  keys: string[];
  /** Which group the shortcut appears under. */
  scope: ShortcutScope;
}

/** Scope order used for grouping/rendering the overlay. */
export const SHORTCUT_SCOPES: readonly ShortcutScope[] = [
  'global',
  'terminal',
  'composer',
] as const;

/**
 * The registered shortcuts. Mirrors the bindings scattered across the app:
 *   - command palette toggle + Escape (CommandPalette.tsx)
 *   - terminal search (TerminalDisplay.tsx)
 *   - composer submit / newline (MessageInput.tsx)
 */
export const KEYBOARD_SHORTCUTS: readonly KeyboardShortcut[] = [
  { id: 'commandPalette', keys: [MOD_KEY_TOKEN, 'K'], scope: 'global' },
  { id: 'keyboardHelp', keys: ['?'], scope: 'global' },
  { id: 'closeOverlay', keys: ['Esc'], scope: 'global' },
  { id: 'navigateList', keys: ['↑', '↓'], scope: 'global' },
  { id: 'terminalSearch', keys: [MOD_KEY_TOKEN, 'F'], scope: 'terminal' },
  { id: 'sendMessage', keys: ['↵'], scope: 'composer' },
  { id: 'composerNewline', keys: ['Shift', '↵'], scope: 'composer' },
] as const;

/**
 * True on macOS-family platforms (where the mod key renders as ⌘). SSR-safe:
 * returns `false` when `navigator` is unavailable.
 */
export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const source = navigator.platform || navigator.userAgent || '';
  return /Mac|iPhone|iPad|iPod/.test(source);
}

/**
 * Resolve one key cap for display, expanding {@link MOD_KEY_TOKEN} per platform.
 */
export function resolveShortcutKey(key: string, mac: boolean): string {
  if (key === MOD_KEY_TOKEN) return mac ? '⌘' : 'Ctrl';
  return key;
}

/** A scope with the shortcuts that belong to it (non-empty scopes only). */
export interface ShortcutGroup {
  scope: ShortcutScope;
  shortcuts: KeyboardShortcut[];
}

/**
 * Group the registry by scope, preserving {@link SHORTCUT_SCOPES} order and
 * dropping any scope with no shortcuts.
 */
export function groupShortcutsByScope(
  shortcuts: readonly KeyboardShortcut[] = KEYBOARD_SHORTCUTS
): ShortcutGroup[] {
  return SHORTCUT_SCOPES.map((scope) => ({
    scope,
    shortcuts: shortcuts.filter((s) => s.scope === scope),
  })).filter((group) => group.shortcuts.length > 0);
}
