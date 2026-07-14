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
