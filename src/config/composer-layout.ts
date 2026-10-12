/**
 * Composer layout thresholds (Issue #2598).
 *
 * Plain values only: the Playwright specs import this module.
 */

/**
 * Composer width at or above which the PC meta row prints its keyboard hints
 * (`/ commands · ⇧ ↵ newline`) beside the Auto-Yes toggle.
 *
 * The container is the meta row itself (`@container` in `MessageInput`), which
 * is as wide as the composer's input row, so like #2597's
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
 *   | where                             | row width | hints   |
 *   |-----------------------------------|-----------|---------|
 *   | PC split pane 218px (the Issue's) | 174       | hidden  |
 *   | PC split pane 272px               | 228       | hidden  |
 *   | PC, three equal split panes       | 271       | hidden  |
 *   | PC split pane 455px (the Issue's) | 411       | hidden  |
 *   | PC, two equal split panes         | 431       | printed |
 *   | PC, 2x2 grid pane                 | 431       | printed |
 *   | PC, one split pane                | 910       | printed |
 */
export const COMPOSER_HINTS_MIN_CONTAINER_PX = 420;
