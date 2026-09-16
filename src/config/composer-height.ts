/**
 * Composer textarea height (Issue #2598).
 *
 * On a PC the composer's textarea can be given a height by dragging the handle
 * on the composer's top edge. The height is stored per worktree and per
 * *scope* — one scope per split pane of the worktree screen, and one for the
 * worktree's tile on `/sessions` — because each of those has a body of a
 * different height above it, and a height chosen for one does not fit the
 * others.
 *
 * Plain values only: the Playwright fixtures import this module, so it must not
 * pull in React or anything browser-only.
 */

/**
 * The textarea's floor: one line (20px) plus its 8px top and bottom padding.
 * Equal to the `minHeight` the textarea has always carried, so a stored height
 * can never be smaller than what auto-grow draws for an empty composer.
 */
export const COMPOSER_MIN_HEIGHT_PX = 36;

/**
 * Where auto-grow stops when no height is stored — the pre-#2598 cap, unchanged.
 * A stored height is not bound by it; the caller's `maxHeight` bounds that.
 */
export const COMPOSER_AUTO_MAX_HEIGHT_PX = 160;

/**
 * The largest value read back from storage.
 *
 * Not a layout limit — the caller's `maxHeight` is — but a sanity bound on what
 * localStorage may hand back, so a corrupted or hand-edited entry cannot ask
 * for a million-pixel textarea. 4096 is taller than any CSS viewport in use,
 * including a portrait 4K display at a device-pixel ratio of 1.
 */
export const COMPOSER_MAX_STORED_HEIGHT_PX = 4096;

/** localStorage key prefix; the full key is `${prefix}${worktreeId}:${scope}`. */
export const COMPOSER_HEIGHT_STORAGE_KEY_PREFIX = 'commandmate:composer-height:';

/** The scope of the worktree screen's split `splitIndex`. */
export function composerHeightScopeForSplit(splitIndex: number): string {
  return `split:${splitIndex}`;
}

/**
 * The scope of a worktree's tile on `/sessions`.
 *
 * Deliberately not `split:0`, although the tile shares split 0's DRAFT key
 * (#2512): a tile's body is a fixed 35rem card's, a split pane's is whatever the
 * screen leaves it, and a height that fits one would be clamped or wasted in
 * the other.
 */
export const SESSION_TILE_COMPOSER_HEIGHT_SCOPE = 'session-tile';

/**
 * The floor under a split pane's body (`TerminalDisplay` or the chat surface)
 * that a stored composer height is not allowed to push it below.
 *
 * 160px is six rows of the terminal at its default `text-sm` (20px lines inside
 * `p-4`) — enough for an agent's prompt line and the footer it draws under it.
 * Measured in Chromium at 1440x900 with the files panel open
 * (`tests/e2e/composer-two-row-2598.spec.ts`):
 *
 *   | layout                    | body, one-line composer | handle range |
 *   |---------------------------|-------------------------|--------------|
 *   | one split                 | 628px                   | 36–503px     |
 *   | 2x2 grid (#2421), a pane  | 226px                   | 36–101px     |
 *
 * A higher floor would take most of the grid's range away; a lower one would
 * let the handle leave a pane two or three terminal rows. In a grid row at its
 * 280px minimum (`MIN_GRID_ROW_PX`) the body is already under this floor with a
 * one-line composer, so the handle has no room there — the clamp doing its job,
 * and the stored height comes back as soon as the pane is tall again.
 */
export const COMPOSER_PANE_BODY_MIN_HEIGHT_PX = 160;
