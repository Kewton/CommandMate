/**
 * Terminal navigation key vocabulary (Issue #1922).
 *
 * This lives outside `src/lib/tmux/**` on purpose. `NavigationKey` is the one
 * tmux-adjacent symbol the browser bundle needs (`NavigationButtons.tsx` /
 * `TerminalEscapeHatch.tsx` type their key props with it), and as long as it was
 * declared in `src/lib/tmux/tmux.ts` those two client components had to import
 * from the tmux module to get it — a client → tmux dependency edge that the
 * `no-restricted-imports` guard added for §4 D4 of
 * `docs/design/multi-agent-state-architecture.md` exists to remove.
 *
 * The alternative considered and rejected (D4, DR3-001) was switching the guard
 * to `@typescript-eslint/no-restricted-imports` with `allowTypeImports: true`.
 * That would permanently bless the edge and leave a path where deleting the word
 * `type` from an import turns a compile-time reference into a runtime one. Moving
 * the declaration costs one file and closes the edge outright.
 *
 * Values only — no tmux process access — so this module is safe from any layer.
 */

/**
 * Navigation keys accepted by the special-keys API and the terminal UI.
 *
 * Separate from `SPECIAL_KEY_VALUES` (the `sendSpecialKey()` control keys) and
 * from `ALLOWED_SPECIAL_KEYS` (the broader `sendSpecialKeys()` TUI set).
 *
 * [DR3-001] Named NAVIGATION_KEY_VALUES to avoid collision with existing SPECIAL_KEY_VALUES.
 * [DR2-004] Exported as an `as const` array + type guard (not a Set) for immutability.
 */
export const NAVIGATION_KEY_VALUES = [
  'Up', 'Down', 'Left', 'Right', 'Enter', 'Escape', 'Tab', 'BTab',
  // Issue #1017: Codex pager / edit-previous mode keys surfaced by NavigationButtons.
  // 'q' is the pager quit key (literal char). PageUp/PageDown/Home/End are tmux named keys.
  'PageUp', 'PageDown', 'Home', 'End', 'q',
] as const;

/**
 * Navigation key type derived from NAVIGATION_KEY_VALUES.
 */
export type NavigationKey = typeof NAVIGATION_KEY_VALUES[number];
