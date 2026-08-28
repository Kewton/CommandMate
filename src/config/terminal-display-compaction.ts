/**
 * Which CLI tools get display-only blank-row compaction, and in which flavour
 * (Issue #1172, extended by Issue #2049).
 *
 * ## Why this is a config module and not two inline booleans
 *
 * Before #2049 the rule was declared twice — once in
 * `TerminalSplitPaneContent.tsx` (PC) and once in `MobileTerminalTab.tsx`
 * (mobile) — as `cliToolId === 'claude' || cliToolId === 'codex'`. Two
 * declarations of the same policy is exactly the shape where PC and phone drift
 * apart: adding a tool to one and forgetting the other makes the same session
 * render differently depending on the screen it is opened on. Both call sites
 * now read {@link getTerminalDisplayCompaction} and nothing else, so the policy
 * has one home.
 *
 * Display-only in every case: the raw capture that feeds status/prompt
 * detection, Auto-Yes, response saving, transport and line counting is untouched.
 */

import type { CLIToolType } from '@/lib/cli-tools/types';

/**
 * How the phone lays a captured frame out horizontally (Issue #2047).
 *
 * - `viewport` — the frame is re-wrapped at whatever width the phone happens to
 *   be. This is what every tool did before #2047 and what every tool except
 *   opencode still does.
 * - `frame` — the frame keeps its OWN column count and the pane scrolls
 *   sideways instead. Rows stay aligned with each other, which is the only way a
 *   TUI's boxes, gutters and footers survive a 390 px screen.
 */
export type TerminalWrapMode = 'viewport' | 'frame';

/** How a tool's terminal pane compacts blank rows for display. */
export interface TerminalDisplayCompaction {
  /**
   * Collapse runs of layout-only blank rows (Issue #1172). Off means the pane
   * renders the raw capture byte-for-byte.
   */
  compactTuiLayoutPadding: boolean;
  /**
   * Treat a visually-blank row that paints columns with a background colour as
   * structure rather than padding (Issue #2049). Only meaningful together with
   * `compactTuiLayoutPadding`.
   */
  preservePaintedPanelRows: boolean;
  /**
   * How the MOBILE pane lays the frame out horizontally (Issue #2047). The PC
   * split pane ignores this: its columns are already wider than any pane
   * geometry CommandMate creates, so re-wrapping never happens there.
   */
  mobileWrapMode: TerminalWrapMode;
}

/**
 * Tools whose pane is pinned to a tall fixed height and padded with layout-only
 * blank rows.
 *
 * - `claude` / `codex`: measured in Issue #1172 — a 1000-row pane anchoring
 *   interactive content at the top and a task panel at the bottom.
 * - `opencode`: measured in Issue #2049 at 1.18.22 — `OPENCODE_PANE_HEIGHT` is
 *   200 rows and a real idle frame carries 185 of them as padding (the frame
 *   compacts from 201 rows to 16). See
 *   `docs/design/opencode-server-live-verification.md` §19.
 *
 * `copilot` is deliberately absent: #2049's acceptance condition is that
 * claude/codex/copilot render unchanged, and no copilot padding measurement
 * exists to justify adding it.
 */
const LAYOUT_PADDING_COMPACTED_TOOLS: ReadonlySet<CLIToolType> = new Set([
  'claude',
  'codex',
  'opencode',
]);

/**
 * Tools that draw overlays as background-painted panels whose body rows carry no
 * glyphs.
 *
 * `opencode` only. Its `ctrl+p` command palette and model picker paint ~70
 * columns under `ESC[48;2;20;20;20m` with nothing printable on them; without
 * this flag the #1172 rule folds those bands into the surrounding blank run and
 * the panel loses its top edge and section separators. claude and codex draw
 * their overlays with box-drawing glyphs, so they have no such row and adding
 * them here would be a no-op that only widens the blast radius.
 */
const PAINTED_PANEL_TOOLS: ReadonlySet<CLIToolType> = new Set(['opencode']);

/**
 * Tools whose mobile pane keeps the frame's own column count instead of
 * re-wrapping at the phone's width (Issue #2047).
 *
 * `opencode` only, and for a measured reason: its pane is pinned to
 * `OPENCODE_PANE_WIDTH` (80) precisely because opencode draws a right-hand
 * sidebar at >=121 columns, and every row of the frame is laid out against that
 * fixed width — the input box gutter, the permission dialog's button strip and
 * the footer all line up column-by-column. Re-wrapping that at ~50 columns of
 * phone breaks each row into two and the boxes stop being boxes.
 *
 * claude / codex / copilot are deliberately absent: this is the same discipline
 * #2049 applied to the compaction flags — a tool joins the list when someone has
 * measured its frame on a phone, not because it is also a TUI.
 */
const FRAME_WIDTH_MOBILE_TOOLS: ReadonlySet<CLIToolType> = new Set(['opencode']);

/**
 * Ceiling for {@link measureTerminalFrameColumns}.
 *
 * 400 is `OPENCODE_PANE_WIDTH_MAX`, the widest pane `CM_OPENCODE_PANE_WIDTH`
 * will produce (Issue #2047), so a legitimately wide pane is never clipped while
 * a runaway row — a base64 blob echoed into the transcript — cannot stretch the
 * scroll region past it.
 */
const TERMINAL_FRAME_MAX_COLUMNS = 400;

/** SGR (colour) sequences, the only escape `capture-pane -e` re-emits. */
const SGR_SEQUENCE = /\x1b\[[0-9;]*m/g;

/**
 * Resolve the display compaction policy for a CLI tool.
 *
 * @param cliToolId - The tool rendered in this pane.
 * @returns Flags to hand straight to `TerminalDisplay`.
 */
export function getTerminalDisplayCompaction(
  cliToolId: CLIToolType
): TerminalDisplayCompaction {
  return {
    compactTuiLayoutPadding: LAYOUT_PADDING_COMPACTED_TOOLS.has(cliToolId),
    preservePaintedPanelRows: PAINTED_PANEL_TOOLS.has(cliToolId),
    mobileWrapMode: FRAME_WIDTH_MOBILE_TOOLS.has(cliToolId) ? 'frame' : 'viewport',
  };
}

/**
 * Longest VISIBLE row in a captured frame, in terminal columns.
 *
 * "Visible" means after SGR sequences are removed: `capture-pane -e` re-emits
 * colour as `ESC[…m`, and counting those bytes would make a heavily coloured
 * 80-column frame measure several hundred columns wide. Only SGR is stripped,
 * which is all `capture-pane -e` emits — cursor motion and erase sequences do
 * not appear in a capture.
 *
 * Returned in columns so the caller can spend it as `ch`. It is a measurement of
 * the frame in hand, NOT of `OPENCODE_PANE_WIDTH`: that is what keeps the
 * display independent of the TUI-side setting, so an operator's
 * `CM_OPENCODE_PANE_WIDTH` reflows the phone correctly without any plumbing, and
 * a frame captured before a width change still renders at the width it was
 * captured at.
 *
 * @param output - Raw terminal text, ANSI included.
 * @param maxColumns - Upper bound, so one pathological row cannot stretch the
 *   pane to a width no scroll gesture can cross. Defaults to
 *   {@link TERMINAL_FRAME_MAX_COLUMNS}.
 * @returns Column count, at least 1.
 */
export function measureTerminalFrameColumns(
  output: string,
  maxColumns: number = TERMINAL_FRAME_MAX_COLUMNS
): number {
  let widest = 1;
  for (const line of output.split('\n')) {
    const visible = line.replace(SGR_SEQUENCE, '');
    // `trimEnd` because opencode pads every row out to the full pane width with
    // background-painted spaces; without it EVERY frame measures exactly the
    // pane width and the measurement stops being one.
    const length = visible.trimEnd().length;
    if (length > widest) widest = length;
    if (widest >= maxColumns) return maxColumns;
  }
  return widest;
}
