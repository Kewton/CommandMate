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
