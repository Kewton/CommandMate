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
  };
}
