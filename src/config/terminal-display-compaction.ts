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
 *
 * ## A PC column is not necessarily wider than the pane (Issue #2510)
 *
 * This module used to say that the PC split pane never re-wraps because its
 * columns are wider than any pane geometry CommandMate creates. That is not a
 * property of PC, it is a property of one layout. claude / codex run in a
 * `TUI_PANE_WIDTH` (200) column pane, and 200 columns at `TerminalDisplay`'s
 * regular `text-sm` (~8.4px per column) need ~1700px. The `/sessions` tile grid
 * (#2509) is where that stops being hypothetical: measured at 1920x1080 with the
 * sidebar open, each of the two tiles gives its terminal an 804px scroll region
 * — ~95 columns at `text-sm` — and at 1280px, still two columns, 484px. A
 * `viewport` pane there folds every full-width rule, box edge and footer of the
 * frame onto a second row.
 *
 * What each PC surface does about it:
 *
 * - The worktree screen's split keeps `viewport` and the regular density. It is
 *   not changed by #2510; whether its own columns ever need `frame` is a
 *   separate question from the tile's.
 * - A tile uses {@link SESSION_TILE_TERMINAL_LAYOUT}: `frame` for every tool,
 *   plus the compact density. See that constant for why the tile does not follow
 *   the phone's per-tool list.
 */

import type { CLIToolType } from '@/lib/cli-tools/types';
import { stripOsc } from '@/lib/detection/ansi';

/**
 * How the phone lays a captured frame out horizontally (Issue #2047).
 *
 * - `viewport` — the frame is re-wrapped at whatever width the phone happens to
 *   be. This is what every tool did before #2047 and what every tool except
 *   opencode still does.
 * - `frame` — the frame keeps its OWN column count and the pane scrolls
 *   sideways instead. Rows stay aligned with each other, which is the only way a
 *   TUI's boxes, gutters and footers survive a 390 px screen — or, since #2510,
 *   a half-width `/sessions` tile.
 */
export type TerminalWrapMode = 'viewport' | 'frame';

/**
 * How large a terminal pane sets its glyphs (Issue #2510).
 *
 * - `regular` — `text-sm`, 14px, ~8.4px per column. Every pane before #2510.
 * - `compact` — `text-xs`, 12px, ~7.2px per column: ~17% more columns in the
 *   same width. The class names live in `TerminalDisplay` (Tailwind scans
 *   components, not config), this module only names the choice.
 */
export type TerminalDisplayDensity = 'regular' | 'compact';

/** The horizontal layout of one terminal surface (Issue #2510). */
export interface TerminalSurfaceLayout {
  wrapMode: TerminalWrapMode;
  density: TerminalDisplayDensity;
}

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
   * surfaces do not read this: the worktree screen's split stays `viewport`, and
   * a `/sessions` tile uses {@link SESSION_TILE_TERMINAL_LAYOUT}. Not because a
   * PC column is always wider than the pane — Issue #2510 is the case where it
   * is not; see the module comment.
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
 * The terminal layout of a `/sessions` tile (Issue #2510).
 *
 * **`frame` for every tool**, unlike {@link FRAME_WIDTH_MOBILE_TOOLS}. The phone
 * list is opencode-only because a 200-column claude frame on a 390px phone is
 * five screens of sideways scrolling, and re-wrapping is the lesser harm there.
 * A full-HD tile's terminal is 804px: the same frame is 1440px at the compact
 * density, under two region-widths, and in exchange the frame's rows stay
 * aligned — the horizontal rules around claude's input box span the full 200
 * columns (`tests/fixtures/claude-live-2247/boot-banner.txt`), and at ~95-111
 * columns each of them folds into two rows. The Issue's acceptance condition is
 * that the borders, gutters and footer survive, which only `frame` guarantees.
 *
 * **`compact` density** as the second half, weighed against legibility: 12px is
 * `text-xs`, the size the tile already sets its own secondary text in (the
 * header's repository line), and it buys ~17% more columns before the scroll is
 * needed (measured: 7.2px per column in the tile against 8.4px). 10px would reach
 * ~134 columns in the same 804px — still not 200, so it would not remove the
 * scroll; it would only make every glyph harder to read to shorten it.
 *
 * The tile's scroll region is its own: the tile and its grid cell are `min-w-0`
 * and clip, so the page itself never scrolls sideways.
 */
export const SESSION_TILE_TERMINAL_LAYOUT: Readonly<TerminalSurfaceLayout> = {
  wrapMode: 'frame',
  density: 'compact',
};

/**
 * Ceiling for {@link measureTerminalFrameColumns}.
 *
 * 400 is `OPENCODE_PANE_WIDTH_MAX`, the widest pane `CM_OPENCODE_PANE_WIDTH`
 * will produce (Issue #2047), so a legitimately wide pane is never clipped while
 * a runaway row — a base64 blob echoed into the transcript — cannot stretch the
 * scroll region past it.
 */
const TERMINAL_FRAME_MAX_COLUMNS = 400;

/** SGR (colour) sequences. OSC is removed separately; see {@link measureTerminalFrameColumns}. */
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
 * 80-column frame measure several hundred columns wide. Cursor motion and erase
 * sequences do not appear in a capture.
 *
 * OSC sequences are removed too (Issue #2510). #2047 measured opencode, which
 * emits none, but claude's header carries OSC 8 hyperlinks (`/rc active`,
 * `claude.ai`) and `capture-pane -e` re-emits them: the live 200-column captures
 * in `tests/fixtures/claude-live-2247` and `claude-live-2486` measured 270 and
 * 228 with SGR alone. Once a tile put claude in `frame` mode that became 70
 * columns of empty sideways scroll. `stripOsc` is the same helper
 * `sanitizeTerminalOutput` drops them with, so the measurement counts exactly
 * the text the renderer draws.
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
    const visible = stripOsc(line).replace(SGR_SEQUENCE, '');
    // `trimEnd` because opencode pads every row out to the full pane width with
    // background-painted spaces; without it EVERY frame measures exactly the
    // pane width and the measurement stops being one.
    const length = visible.trimEnd().length;
    if (length > widest) widest = length;
    if (widest >= maxColumns) return maxColumns;
  }
  return widest;
}
