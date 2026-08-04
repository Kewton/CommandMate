/**
 * Terminal output rendering limits (Issue #1674).
 *
 * These are display-side limits only. The raw capture kept by the poller,
 * status/prompt detection, Auto-Yes and transport are untouched.
 */

/**
 * Maximum number of characters a single `sanitizeTerminalOutput()` call renders.
 *
 * Longer input is truncated to its **tail** (newest content) — see
 * `TERMINAL_TRUNCATION_MARKER`. A terminal pane is read from the bottom, so the
 * newest bytes are the ones that must survive.
 *
 * Issue #1624 raised the tmux `history-limit` to 20000 rows, which pushed a real
 * Codex capture from ~240KB to 1,182,902 characters — the first time this cap
 * was ever crossed in practice.
 */
export const MAX_TERMINAL_OUTPUT_LENGTH = 1_048_576; // 1MB

/**
 * Marker prepended to truncated terminal output so the drop is visible rather
 * than reading as "the session stopped producing output" (which is exactly how
 * Issue #1674 was first misdiagnosed).
 *
 * Mirrors `COPILOT_TRUNCATION_MARKER` (`src/config/copilot-constants.ts`), which
 * solves the same problem for saved chat messages.
 */
export const TERMINAL_TRUNCATION_MARKER =
  '[... 古い出力を省略しました / older output truncated ...]';

/**
 * How far past the raw cut point we may scan to reach a line boundary.
 *
 * An ANSI escape never spans a newline, so aligning the kept tail to a line start
 * is what keeps us out of the middle of a sequence. Real terminal lines are a few
 * hundred characters at most; this bound only matters for pathological input
 * (one enormous line), where we fall back to an escape-aware cut instead of
 * discarding most of the tail to find a newline.
 */
export const TERMINAL_TRUNCATION_LINE_SCAN_LIMIT = 64 * 1024; // 64KB
