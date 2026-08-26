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

// ---------------------------------------------------------------------------
// Per-tool vocabularies (Issue #2046)
// ---------------------------------------------------------------------------

/**
 * opencode's leader prefix — the first half of a two-step chord.
 *
 * Measured, not assumed: opencode 1.18.22 ships `leader: "ctrl+x"` and
 * `leader_timeout: 2000` as the defaults in its own binary, and a live TUI on a
 * private tmux socket answered `C-x` + one letter at the 100 ms
 * `SPECIAL_KEY_DELAY_MS` the transport already sends multi-key requests with
 * (3/3 on `C-x` `a`). See `docs/design/opencode-server-live-verification.md` §22.
 */
export const OPENCODE_LEADER_KEY = 'C-x';

/**
 * The letters that complete an opencode leader chord, in the order the quick-key
 * strip renders them.
 *
 * These are LITERAL characters, not tmux key names — `tmux send-keys -- a` puts
 * an `a` through, exactly as `q` has done for the codex pager since #1017. The
 * one thing that makes them safe to hand to `tmux send-keys` is that they are
 * fixed single characters chosen here, delivered through `execFile` and never a
 * shell; the one thing that makes them safe to hand to *opencode* is that the
 * route only accepts them for a tool that declares them (see
 * `ICLITool.navigationKeys()`), so an `a` can never reach claude's composer.
 *
 * **`b` (`sidebar_toggle`) is deliberately absent.** It is a real opencode
 * binding and it is the one this Issue measured and refused: §22.3.
 */
export const OPENCODE_LEADER_CHORD_VALUES = [
  'a', 'l', 'n', 't', 'm', 'g', 'u', 'r', 'c',
] as const;

/**
 * opencode keys that need no leader.
 *
 * `C-p` opens the command palette (opencode prints `ctrl+p commands` in its own
 * footer) and `C-t` cycles the model variant — both confirmed live on 1.18.22.
 * `Tab` / `BTab` cycle the agent and are already in {@link NAVIGATION_KEY_VALUES}.
 */
export const OPENCODE_DIRECT_KEY_VALUES = ['C-p', 'C-t'] as const;

/**
 * Everything an opencode pane may be sent — the base navigation pad plus this
 * tool's own chords. Returned by `OpenCodeTool.navigationKeys()`.
 */
export const OPENCODE_NAVIGATION_KEY_VALUES = [
  ...NAVIGATION_KEY_VALUES,
  OPENCODE_LEADER_KEY,
  ...OPENCODE_DIRECT_KEY_VALUES,
  ...OPENCODE_LEADER_CHORD_VALUES,
] as const;

/**
 * The union of every tool's vocabulary — what the tmux transport must be able to
 * deliver.
 *
 * This is NOT what any single request is validated against. Since Issue #2046
 * the special-keys route validates against the *declaring tool's* set
 * (`ICLITool.navigationKeys()`), and this list exists so the transport's
 * allow-list has one place to be checked against. The #2032 invariant is now
 * stated per tool — every declared key must be deliverable — and
 * `tests/unit/tmux/special-keys-allowlist-2032.test.ts` plus
 * `tests/unit/cli-tools/navigation-keys-declaration-2046.test.ts` pin both
 * halves.
 */
export const TERMINAL_KEY_VALUES = [
  ...NAVIGATION_KEY_VALUES,
  OPENCODE_LEADER_KEY,
  ...OPENCODE_DIRECT_KEY_VALUES,
  ...OPENCODE_LEADER_CHORD_VALUES,
] as const;

/** Any key name a tool may declare in its {@link NavigationKeySpec}. */
export type TerminalKey = typeof TERMINAL_KEY_VALUES[number];
