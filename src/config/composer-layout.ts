/**
 * Composer layout thresholds (Issue #2598, #3595).
 *
 * Plain values only: the Playwright specs import this module.
 */

/**
 * Composer width at or above which the PC meta row prints its keyboard hints
 * (`/ commands · ⇧ ↵ newline`) beside the Auto-Yes toggle — in the TWO-ROW
 * layout (#2598). Where a composer is drawn as one row (Issue #3595, see
 * {@link COMPOSER_ONE_ROW_MIN_CONTAINER_PX}) the hints are not printed at all.
 *
 * Two routes reach this threshold, and both measure the same width:
 *
 * - **Two-row route** (the phone has no hints; the `/sessions` tile, and a
 *   worktree split pane narrower than the one-row threshold): the container is
 *   the meta row itself (`@container` in `MessageInput`).
 * - **One-row route** (a worktree split pane, `oneRowWhenWide`): the meta row
 *   sits inside the input row and is not a container; the input row is. Below
 *   the one-row threshold this is the same answer, because the two are equally
 *   wide; at or above it the hints are hidden (the 800px variant) and reached
 *   through a focusable button with a tooltip instead.
 *
 * Either container is as wide as the composer's input row, so like #2597's
 * `AGENT_MODE_NOTATION_MIN_CONTAINER_PX` the answer follows the pane, not the
 * viewport. The class in `MessageInput` MUST spell the same value as a literal
 * (`@min-[420px]:flex`): Tailwind scans source text, so an interpolated class
 * would generate no CSS and hide the hints at every width (the #2131 rule).
 *
 * Below it the hints are not drawn at all. Before #2598 they were
 * `flex-shrink-0` and wrapped onto a second line in a narrow split pane (20px →
 * 40px of meta row), and the Auto-Yes toggle beside them — the row's `min-w-0`
 * half — was squeezed to nothing and could not be reached.
 *
 * ## What has to fit
 *
 * The toggle comes first: the hints only teach two keys, the toggle is a
 * control. Natural widths, measured with `getBoundingClientRect()` /
 * `scrollWidth` in Chromium (2026-09-17):
 *
 *   | item                                         | en    | ja    |
 *   |----------------------------------------------|-------|-------|
 *   | hints                                        | 187px | 158px |
 *   | Auto-Yes off, `(Claude)` / `(Codex)`         | 155 / 152px (both) |
 *   | Auto-Yes on (adds the countdown), `(Claude)` | 215px (both)       |
 *   | Auto-Yes on, `(Copilot)` / `(Antigravity)`   | 216 / 237px (both) |
 *
 * With the row's 8px gap, English needs about 410px for claude with Auto-Yes on
 * and about 431px for antigravity. 420 keeps the hints in a two-split pane on a
 * 1440px screen (431px of row) and gives every tool but the longest-named its
 * full toggle at any width it prints them; between 420 and 431 the antigravity
 * countdown scrolls (the Auto-Yes half is `whitespace-nowrap` and scrolls
 * sideways) instead of wrapping.
 *
 * Where that lands, 1440x900 with the files panel open
 * (`tests/e2e/composer-two-row-2598.spec.ts`):
 *
 *   | where                             | row width | layout  | hints                 |
 *   |-----------------------------------|-----------|---------|-----------------------|
 *   | PC split pane 218px (the Issue's) | 174       | 2 rows  | hidden                |
 *   | PC split pane 272px               | 228       | 2 rows  | hidden                |
 *   | PC, three equal split panes       | 271       | 2 rows  | hidden                |
 *   | PC split pane 455px (the Issue's) | 411       | 2 rows  | hidden                |
 *   | PC, two equal split panes         | 431       | 2 rows  | printed               |
 *   | PC, 2x2 grid pane                 | 431       | 2 rows  | printed               |
 *   | PC, one split pane (#3595)        | 910       | 1 row   | button + tooltip      |
 *   | `/sessions` tile (no one-row)     | per tile  | 2 rows  | printed from 420      |
 *
 * (Before #3595 the one-split pane was two rows with the hints printed.)
 */
export const COMPOSER_HINTS_MIN_CONTAINER_PX = 420;

/**
 * Composer width (px) at or above which a `oneRowWhenWide` composer (the PC
 * worktree screen's split pane, Issue #3595) is drawn as ONE row:
 * [attach][mode] [textarea] [Auto-Yes][hints][direct input][interrupt][send].
 * Below it the composer is #2598's two rows. The phone and the `/sessions`
 * tile never ask for one row and are unaffected.
 *
 * The container is the composer's `<form>` (`@container`, only in that mode),
 * whose content box is exactly as wide as the input row #2597 / #2598 measure
 * against, so the answer follows the split pane, not the viewport (and the
 * Files / History panels opening or closing). `MessageInput` MUST spell the
 * same value as literals (the 800px container variant): Tailwind scans source
 * text, so an interpolated class would generate no CSS (the #2131 rule).
 * `tests/unit/config/composer-layout-one-row-3595.test.ts` checks the two
 * agree; the Playwright spec imports this constant rather than copying it.
 *
 * ## What has to fit
 *
 * Natural widths in the one-row layout, from #2797's and #2598's measurements
 * (Chromium, 1440x900): start group (attach + mode control) 189px for claude,
 * 323px for codex with its #2592 caution; Auto-Yes 155px off, 215px on for
 * claude (237px for antigravity); the hints button 28px; the direct-input
 * toggle with its label (the row is past #2797's 520px) 96px; interrupt and
 * send 36px each; five 8px gaps. Claude, the default tool, with Auto-Yes on:
 * 189 + 215 + 28 + 96 + 36 + 36 + 40 = 640px of controls, which at 800px leaves
 * the textarea the `min-w-40` (160px) floor it keeps in this layout. Wider
 * controls (codex's caution, antigravity's countdown) do not take the floor:
 * the toolbar's start group scrolls sideways, as it does in two rows.
 *
 * Where that lands at 1440x900 (`tests/e2e/composer-two-row-2598.spec.ts`):
 * the one-split pane (910px of row with the files panel open) is one row, and
 * its empty composer drops from 120px to 54px. The two-split pane and the 2x2
 * grid (431px), and every three-split pane, keep two rows: a 218px pane is
 * exactly the case #2598 left the old one-row layout for (a 0px textarea).
 */
export const COMPOSER_ONE_ROW_MIN_CONTAINER_PX = 800;
