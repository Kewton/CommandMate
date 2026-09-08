/**
 * Terminal split configuration (Issue #728, 2x2 grid in Issue #2421)
 *
 * Defines constants, storage key helpers, and a stale-state validation guard
 * for the PC-only terminal split feature.
 *
 * Issue #2421 raised the ceiling to 4 splits. 1-3 splits stay a strictly
 * one-dimensional row (`widths` alone describes the layout); at exactly 4 the
 * container switches to a 2x2 GRID, because a quarter-width column cannot show
 * an agent TUI (`TUI_PANE_WIDTH = 200` columns, `src/config/tmux-pane-config.ts`
 * — the tmux pane geometry is independent of the browser pane, so the grid is
 * purely a display concern and the detection layer is untouched).
 *
 * The grid adds `rowHeights` (2 entries) to the persisted shape. It is OPTIONAL
 * and only written while the layout actually is a grid, so a 1-3 split payload
 * is byte-for-byte what it was before this Issue and old payloads keep loading.
 *
 * Persistence is worktree-scoped (one entry per worktreeId). The mobile path
 * does not consume this config — only the WorktreeDetailRefactored PC branch.
 */

import { CLI_TOOL_IDS, isValidInstanceId, type CLIToolType } from '@/lib/cli-tools/types';

/** Minimum number of splits in the PC terminal area. */
export const MIN_SPLITS = 1;

/**
 * Maximum number of splits in the PC terminal area.
 *
 * Issue #2421: 3 -> 4. The 4th split is what turns the row into a 2x2 grid; see
 * {@link GRID_SPLIT_COUNT}.
 */
export const MAX_SPLITS = 4;

/**
 * The split count at which the terminal area becomes a 2x2 grid (Issue #2421).
 *
 * Deliberately a single count rather than a general MxN layout engine: 4 is the
 * only split count where a 1-D row stops working (each column would be ~1/4 of
 * the viewport, far narrower than the 200-column TUI it has to show), and a
 * general engine would have to answer questions (3 splits as 2+1? 2 as a
 * column?) this Issue does not ask.
 */
export const GRID_SPLIT_COUNT = 4;

/** Number of rows in the 2x2 grid (Issue #2421). */
export const GRID_ROW_COUNT = 2;

/** Equal-height rows — the layout a fresh grid starts from (Issue #2421). */
export const DEFAULT_GRID_ROW_HEIGHTS: readonly [number, number] = [0.5, 0.5];

/**
 * Minimum height, in CSS pixels, of ONE row of the 2x2 grid (Issue #2421).
 *
 * A 2x2 layout halves the vertical space AND pays the per-pane chrome twice
 * (each pane carries its own title bar ~30px and composer ~50px), so without a
 * floor the terminal body inside a row collapses to a few lines on a laptop.
 * 280px keeps ~200px of terminal body per pane — the same order as the 250px
 * floor the mobile terminal is held to (`tests/e2e/mobile-opencode-quick-keys-2106.spec.ts`)
 * — while 2 * 280 = 560px still fits the terminal area of a 1440x900 laptop
 * without forcing a scrollbar. Enforced in CSS as the `min` half of the grid
 * rows' `minmax()`, so it holds no matter what ratio `rowHeights` carries; the
 * grid scrolls rather than shrinking past it on a short viewport.
 */
export const MIN_GRID_ROW_PX = 280;

/** localStorage key prefix; full key is `${prefix}${worktreeId}`. */
export const TERMINAL_SPLITS_STORAGE_KEY_PREFIX = 'commandmate:terminalSplits:';

/**
 * Single split entry: which agent instance is rendered in this slot.
 *
 * Issue #869: a slot is now identified by an `instanceId` (the tab/split
 * identity) in addition to the backing `cliToolId` (which still drives
 * cliTool-keyed concerns such as auto-yes and status). For the primary instance
 * `instanceId === cliToolId`, so pre-#869 single-instance behavior is unchanged.
 */
export interface TerminalSplitEntry {
  cliToolId: CLIToolType;
  instanceId: string;
}

/**
 * Persisted terminal-split configuration.
 *
 * Invariants enforced by `isValidSplitConfig`:
 * - `splits.length` in `[MIN_SPLITS, MAX_SPLITS]`
 * - `widths.length === splits.length`
 * - each `widths[i]` is a finite number > 0
 * - `rowHeights`, when present, has exactly `GRID_ROW_COUNT` finite entries > 0
 */
export interface TerminalSplitConfig {
  splits: TerminalSplitEntry[];
  widths: number[];
  /**
   * Issue #2421: the two row heights of the 2x2 grid, as ratios (the same
   * unitless "share" `widths` uses).
   *
   * OPTIONAL and absent unless the layout IS a grid (`splits.length ===
   * GRID_SPLIT_COUNT`). That is what keeps a 1-3 split payload identical to the
   * pre-#2421 shape — nothing new is written, so nothing new can be misread by
   * an older build, and `useTerminalSplits` drops the key again as soon as the
   * split count leaves 4.
   *
   * In the grid the COLUMN ratio comes from `widths[0] : widths[1]` (a CSS grid
   * column is shared by both rows, so there is one column ratio, not two);
   * `widths[2]` / `widths[3]` mirror them so every entry still describes its own
   * pane's horizontal share.
   */
  rowHeights?: number[];
}

/** Default config used both as initial state and stale-state fallback. */
export const DEFAULT_SPLIT_CONFIG: TerminalSplitConfig = {
  splits: [{ cliToolId: 'claude', instanceId: 'claude' }],
  widths: [1],
};

const KNOWN_CLI_IDS = new Set<string>(CLI_TOOL_IDS);

/** Build the worktree-scoped localStorage key for a given worktreeId. */
export function getTerminalSplitsStorageKey(worktreeId: string): string {
  return `${TERMINAL_SPLITS_STORAGE_KEY_PREFIX}${worktreeId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** A ratio the layout can actually divide by: finite and strictly positive. */
function isPositiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * Issue #2421: is `rowHeights` a usable pair of row ratios?
 *
 * `undefined` is valid — it is what every 1-3 split config carries, and what a
 * grid config falls back to (`DEFAULT_GRID_ROW_HEIGHTS`).
 */
export function isValidRowHeights(value: unknown): value is number[] {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length !== GRID_ROW_COUNT) return false;
  return value.every(isPositiveFinite);
}

/** Does a split count render as the 2x2 grid rather than a 1-D row? (#2421) */
export function isGridLayout(splitCount: number): boolean {
  return splitCount === GRID_SPLIT_COUNT;
}

/**
 * Issue #2421: the row ratios to actually render with — the persisted pair when
 * it is usable, equal rows otherwise. Callers never have to branch on
 * `rowHeights === undefined`, which is the state EVERY pre-#2421 payload is in.
 */
export function resolveRowHeights(rowHeights: number[] | undefined): number[] {
  return rowHeights && isValidRowHeights(rowHeights)
    ? [...rowHeights]
    : [...DEFAULT_GRID_ROW_HEIGHTS];
}

/**
 * Issue #2424: the two `fr` factors a grid track pair is rendered with.
 *
 * `widths` and `rowHeights` are unitless SHARES — only their ratio carries
 * meaning, and nothing in this module constrains what they sum to.
 * `equalGridWidths()` writes `1 / 4` per pane, so a fresh 2x2 grid reaches the
 * renderer as `0.25` and `0.25`; `isValidRowHeights` likewise accepts any pair
 * of positive numbers, so a persisted `[0.3, 0.3]` is valid.
 *
 * Handed to CSS unchanged, that is a bug rather than a scale: **when the flex
 * factors of a grid sum to LESS THAN 1, the tracks take only that fraction of
 * the leftover space instead of sharing all of it.** Measured in Chromium on a
 * 1000px container: `0.25fr 4px 0.25fr` lays out as `249px 4px 249px` and
 * leaves 498px blank, which is the ~50% gap #2424 reported down the right of
 * the grid. `0.5fr` / `1fr` pairs both fill it.
 *
 * Normalising here rather than at the source keeps the fix in one place and
 * independent of scale: the persisted shapes are unchanged (no migration), and
 * `handleGridColumnResize` / `handleGridRowResize` can keep preserving their
 * own total the way they do — whatever total that is, the tracks still fill the
 * container.
 *
 * @param a - First track's share; must be finite and > 0
 * @param b - Second track's share; must be finite and > 0
 * @returns The pair scaled so it sums to 1, or equal halves when the input
 *   cannot be scaled (a non-positive sum would divide by zero, and the caller
 *   has nothing better to draw than two equal tracks)
 */
export function toGridTrackFractions(a: number, b: number): [number, number] {
  const total = a + b;
  if (!Number.isFinite(total) || total <= 0) return [0.5, 0.5];
  return [a / total, b / total];
}

/**
 * Defensive type guard. Rejects any input that does not exactly match the
 * `TerminalSplitConfig` invariants. Used by `useTerminalSplits` to discard
 * stale or externally-edited localStorage payloads.
 */
export function isValidSplitConfig(value: unknown): value is TerminalSplitConfig {
  if (!isRecord(value)) return false;

  const { splits, widths, rowHeights } = value;

  if (!Array.isArray(splits) || !Array.isArray(widths)) return false;
  if (splits.length < MIN_SPLITS || splits.length > MAX_SPLITS) return false;
  if (widths.length !== splits.length) return false;
  // Issue #2421: absent is the normal case (every 1-3 split config).
  if (!isValidRowHeights(rowHeights)) return false;

  for (const entry of splits) {
    if (!isRecord(entry)) return false;
    const cli = entry.cliToolId;
    if (typeof cli !== 'string' || !KNOWN_CLI_IDS.has(cli)) return false;
    const instanceId = entry.instanceId;
    if (typeof instanceId !== 'string' || !isValidInstanceId(instanceId)) return false;
  }

  for (const w of widths) {
    if (!isPositiveFinite(w)) return false;
  }

  return true;
}

/**
 * Normalize a persisted split payload to the current shape (Issue #869, #2421).
 *
 * Migrates pre-#869 entries (which only carried `cliToolId`) by deriving
 * `instanceId = cliToolId` (the primary instance). Returns a fully-formed,
 * validated `TerminalSplitConfig`, or `null` when the payload cannot be
 * salvaged. Roster cross-checks (does the instanceId still exist?) happen in
 * `useTerminalSplits`, which owns the live roster.
 *
 * Issue #2421 (grid migration): the ONLY new field is `rowHeights`, and it is
 * optional — so a pre-#2421 one-dimensional payload normalizes with no changes
 * at all and keeps the user's layout instead of silently resetting to the
 * default. A `rowHeights` that IS present but unusable is dropped rather than
 * rejecting the whole payload: the row ratios are the most disposable part of
 * the config (they fall back to equal rows), and throwing away the split
 * assignments over them would be the exact "layout silently reset" failure this
 * function exists to prevent.
 */
export function normalizeSplitConfig(value: unknown): TerminalSplitConfig | null {
  if (!isRecord(value)) return null;

  const { splits, widths, rowHeights } = value;
  if (!Array.isArray(splits) || !Array.isArray(widths)) return null;
  if (splits.length < MIN_SPLITS || splits.length > MAX_SPLITS) return null;
  if (widths.length !== splits.length) return null;

  const normalizedSplits: TerminalSplitEntry[] = [];
  for (const entry of splits) {
    if (!isRecord(entry)) return null;
    const cli = entry.cliToolId;
    if (typeof cli !== 'string' || !KNOWN_CLI_IDS.has(cli)) return null;
    const rawInstanceId = entry.instanceId;
    const instanceId =
      typeof rawInstanceId === 'string' && isValidInstanceId(rawInstanceId)
        ? rawInstanceId
        : cli; // legacy migration: primary instance (instanceId === cliToolId)
    normalizedSplits.push({ cliToolId: cli as CLIToolType, instanceId });
  }

  for (const w of widths) {
    if (!isPositiveFinite(w)) return null;
  }

  const normalized: TerminalSplitConfig = {
    splits: normalizedSplits,
    widths: widths as number[],
  };
  // Only a grid carries row heights; a usable pair on a grid payload is kept,
  // anything else is simply left off (see the doc comment above).
  if (isGridLayout(normalizedSplits.length) && rowHeights !== undefined && isValidRowHeights(rowHeights)) {
    normalized.rowHeights = [...rowHeights];
  }
  return normalized;
}
