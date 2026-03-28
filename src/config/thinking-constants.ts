/** Shared constants for thinking indicator detection across polling and status detection modules. */

/**
 * Number of tail lines to check for active thinking indicators.
 *
 * Used by both response-poller.ts (response extraction) and status-detector.ts
 * (UI status display) to apply windowed thinking detection. A small window
 * prevents completed thinking summaries (e.g., "Churned for 41s") in scrollback
 * from being falsely detected as active thinking (Issue #188 root cause).
 *
 * Previously maintained as separate constants in each module (SF-003 coupling note).
 * Unified into a shared constant in Issue #575 to eliminate duplication.
 *
 * @constant
 */
export const THINKING_TAIL_LINE_COUNT = 5;
