/**
 * tmux pane geometry for TUI CLI sessions (Issue #1163).
 *
 * TUI tools (Claude Code, Codex, OpenCode, Gemini, ...) run in the terminal's
 * alternate screen with no scrollback (`history_size=0`), so `capture-pane` can
 * only return the currently visible frame — i.e. exactly `pane_height` rows.
 *
 * The tmux server's global `window-size latest` resizes a window to the most
 * recently active client. When a small terminal client attaches (e.g. a 73-row
 * `tmux attach` or a control-mode client), the pane shrinks and the number of
 * capturable rows collapses with it, so the terminal view loses history.
 *
 * The fix pins each session's window to a fixed, generous height via
 * `set-window-option -t <session> window-size manual` + `resize-window`, applied
 * per session so the global option is never touched. Kept at a practical ceiling
 * so `capture-pane` cost / render load stays reasonable.
 */

/** Fixed pane height (rows) for TUI sessions. Large enough to retain useful history. */
export const TUI_PANE_HEIGHT = 1000;

/** Fixed pane width (columns) for TUI sessions. Matches the historical default. */
export const TUI_PANE_WIDTH = 200;

/**
 * OpenCode tmux pane height (rows).
 *
 * Set to 200 to expand the TUI content area (~190 visible lines), allowing most
 * responses to be captured in a single tmux capture-pane. OpenCode runs in
 * alternate screen mode with no scrollback buffer, so only visible rows are
 * capturable — which makes this both the session's height and the most a
 * `capture-pane` can ever return for it.
 *
 * Issue #1906 moved it here from `lib/cli-tools/opencode.ts` (which re-exports
 * it, so every existing importer is unchanged). `submit-verified-sender.ts` now
 * needs the number to size its read-back window, and it is imported BY
 * `opencode.ts` — taking the constant from there would have created an import
 * cycle and pulled opencode's `child_process` use into every consumer of the
 * sender. This module has no imports at all, so it costs nothing to depend on.
 */
export const OPENCODE_PANE_HEIGHT = 200;

/**
 * Scrollback lines retained per pane (`history-limit`), Issue #1624.
 *
 * Only NON-alternate-screen tools (codex / gemini / vibe-local / antigravity)
 * consume this: the alternate-screen tools in `ALTERNATE_SCREEN_CLI_TOOLS`
 * (claude / opencode / copilot) keep `history_size` at 0, so scrollback depth is
 * irrelevant to them. See `usesAlternateScreen` in lib/cli-tools/types.ts.
 *
 * WHY 20000 and not the 50000 this used to request — measured on tmux 3.5a with
 * a 200-column pane full of realistic, heavily-SGR-coloured agent output
 * (274 bytes/line as re-emitted by `capture-pane -e`):
 *
 * 1. `capturePane` runs tmux under `execFile` with `maxBuffer: 10 MB`. A full
 *    50000-line capture extrapolates to ~13 MB of escape-laden text, which
 *    OVERFLOWS that buffer and makes `capturePane` THROW rather than return a
 *    truncated string — i.e. the deepest part of a 50000-line buffer was never
 *    readable by this app in the first place. 20000 lines is ~5.2 MB, leaving
 *    roughly 2x headroom.
 * 2. Nothing in the app reads deeper than 10000 lines by default (`capturePane`'s
 *    options-path default is `-S -10000`; every other call site asks for 1000 or
 *    fewer). 20000 keeps a 2x margin over the deepest default read.
 * 3. Memory is charged per line ACTUALLY emitted, not preallocated from the
 *    limit: a fresh session cost ~0.3 MB of tmux-server RSS, growing to ~34 MB
 *    only after 45000 lines had scrolled (~0.68 KB/line). At 20000 a saturated
 *    pane costs ~14 MB, so 20 concurrent sessions cap out near 270 MB instead of
 *    the ~680 MB implied by 50000.
 *
 * This is still a 10x increase over tmux's built-in 2000, which is what sessions
 * were actually getting before #1624 (a `mcbd-codex-*` session was observed at
 * 1977/2000 lines used, i.e. actively losing transcript).
 */
export const TMUX_HISTORY_LIMIT = 20000;

/**
 * Default OpenCode tmux pane width (columns) — Issue #2047.
 *
 * ## Why 80 is a measurement and not a leftover
 *
 * `launchSession()` in `lib/cli-tools/opencode.ts` used to spell this `80`
 * inline, twice, with the comment "hide sidebar for clean capture-pane output".
 * #2047 measured what that comment is worth on opencode 1.18.22, and it is
 * load-bearing: **opencode paints a right-hand sidebar at 121 columns and wider,
 * and hides it at 120 and narrower.** The boundary was walked one column at a
 * time on a live TUI and is reproducible in both directions (see
 * `docs/design/opencode-server-live-verification.md` §21).
 *
 * The sidebar is not a separate region of the capture. It shares ROWS with the
 * transcript, so at >=121 columns every captured line is
 * `<transcript text> … <sidebar text>` and the detection layer reads both as one
 * row. Measured consequences at 200 columns, on frames captured from the same
 * session as their 80/120 counterparts:
 *
 * - `sliceOpenCodeTurn()` + `cleanOpenCodeResponse()` saved the sidebar as the
 *   assistant's reply (`8,501 tokens / $0.00 spent / LSP / LSPs are disabled`)
 *   for a turn whose real reply extracted to the empty string at 80 and 120.
 * - `detectSessionStatus` flipped `ready`/`opencode_response_complete` to
 *   `running`/`unknown_frame` on an aborted turn, because the sidebar rows push
 *   the previous turn's `▣ … · 36.1s` out of branch D's content window.
 * - `OPENCODE_IDLE_COMPOSER_PATTERN` false-matched, because the sidebar prints
 *   the session TITLE on a row that already carries the transcript gutter — so
 *   `^\s*┃\s*Ask anything\.\.\.` matches a title, not a composer.
 *
 * At 120 columns all 13 measured frames produced byte-identical verdicts to 80.
 * **120 is therefore the measured safe ceiling, and the default stays 80** —
 * #2047's acceptance condition was "raise the default only if 200 is green",
 * and 200 is not.
 *
 * @see OPENCODE_SIDEBAR_MIN_WIDTH
 * @see resolveOpencodePaneWidth
 */
export const OPENCODE_PANE_WIDTH = 80;

/**
 * The narrowest pane width at which opencode 1.18.22 paints its right-hand
 * sidebar (Issue #2047, measured — 120 hides it, 121 shows it, walked one column
 * at a time and reproduced in both directions).
 *
 * Anything at or above this width interleaves sidebar text into transcript rows,
 * which is what {@link OPENCODE_PANE_WIDTH}'s docblock lists the damage from.
 * `lib/cli-tools/opencode.ts` warns when an operator's
 * `CM_OPENCODE_PANE_WIDTH` lands here or above.
 */
export const OPENCODE_SIDEBAR_MIN_WIDTH = 121;

/** Environment variable that overrides {@link OPENCODE_PANE_WIDTH}. */
export const OPENCODE_PANE_WIDTH_ENV = 'CM_OPENCODE_PANE_WIDTH';

/**
 * Bounds accepted for {@link OPENCODE_PANE_WIDTH_ENV}.
 *
 * The floor is opencode's own layout: its input box plus gutter needs room, and
 * below ~40 columns the footer rows the detector anchors on wrap into each
 * other. The ceiling is a guard against a typo (`8000`) resizing a pane to
 * something tmux will accept and every `capture-pane` will then pay for — a
 * 200-row frame already grows from ~2.5 KB at 80 columns to ~40 KB at 200
 * because of the sidebar's background painting (measured, #2047 §21).
 */
export const OPENCODE_PANE_WIDTH_MIN = 40;
/** @see OPENCODE_PANE_WIDTH_MIN */
export const OPENCODE_PANE_WIDTH_MAX = 400;

/**
 * Resolve the pane width a new or reconnected opencode session is sized to.
 *
 * Read at CALL time rather than at module load so a process can be started with
 * the variable set without import-order deciding whether it is seen, and so
 * tests can drive it without module-registry surgery.
 *
 * A value that is not a base-10 integer, or that falls outside
 * [{@link OPENCODE_PANE_WIDTH_MIN}, {@link OPENCODE_PANE_WIDTH_MAX}], is ignored
 * in favour of {@link OPENCODE_PANE_WIDTH}: a malformed override must never
 * produce a pane no detector has ever been measured against. Callers that want
 * to tell the operator their value was dropped compare the result against what
 * they passed in.
 *
 * @param env - Environment to read. Defaults to `process.env` where there is one.
 * @returns Pane width in columns.
 */
export function resolveOpencodePaneWidth(
  env: Record<string, string | undefined> | undefined = typeof process === 'undefined'
    ? undefined
    : process.env
): number {
  const raw = env?.[OPENCODE_PANE_WIDTH_ENV];
  if (raw === undefined) return OPENCODE_PANE_WIDTH;

  const trimmed = raw.trim();
  // `Number()` accepts '0x50', '1e2' and '' — none of which an operator means by
  // a column count, and all of which would silently resize a real pane.
  if (!/^\d+$/.test(trimmed)) return OPENCODE_PANE_WIDTH;

  const parsed = Number.parseInt(trimmed, 10);
  if (parsed < OPENCODE_PANE_WIDTH_MIN || parsed > OPENCODE_PANE_WIDTH_MAX) {
    return OPENCODE_PANE_WIDTH;
  }
  return parsed;
}
