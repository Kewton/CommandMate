/**
 * Capture line count for the display path (current-output/route.ts).
 *
 * Issue #604: Previously, worktree-status-helper used 100 lines while
 * current-output used 10000, causing status inconsistency when tmux
 * buffer had 150+ trailing blank lines after a prompt.
 *
 * Issue #965: detection no longer shares this large value — see
 * STATUS_DETECTION_CAPTURE_LINES below. The display path keeps 10000 so the
 * full terminal scrollback remains available to the UI.
 */
export const STATUS_CAPTURE_LINES = 10000;

/**
 * Capture line count for the status DETECTION path (worktree-status-helper.ts).
 *
 * Issue #965: Status detection only needs enough trailing lines to find the
 * active prompt/spinner. The detector (status-detector.ts) trims trailing blank
 * padding before windowing, so it just needs the captured slice to reach past
 * that padding to the real content. Capturing the full 10000 lines on every
 * sidebar→detail status probe makes the tmux capture-pane call needlessly slow.
 *
 * 1000 lines keeps a large margin above the worst observed trailing-blank
 * padding (Issue #604: ~150+ blank lines after a prompt), so detection still
 * sees the prompt/status after trimming — no regression of the #604 case —
 * while cutting the capture cost. Tools with their own fixed pane height
 * (OpenCode, Gemini) keep using that height instead.
 */
export const STATUS_DETECTION_CAPTURE_LINES = 1000;
