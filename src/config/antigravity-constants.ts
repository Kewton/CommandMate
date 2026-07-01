/**
 * Antigravity CLI constants
 * Issue #989 (Phase B): Model name validation for `agy --model <name>`.
 *
 * Unlike Copilot, `--model` is a launch-time flag (not an in-session slash
 * command), and its value is the exact display name from `agy models`
 * (e.g. "Gemini 3.1 Pro (High)"), which includes spaces and parentheses.
 * COPILOT's MODEL_NAME_PATTERN disallows those characters, so a dedicated
 * pattern is required here.
 */

/**
 * Antigravity model name allowed pattern.
 * Leading character must be alphanumeric (same rationale as Copilot's
 * pattern: avoids CLI option injection ambiguity with a leading '-').
 * Allows spaces, parentheses, periods, slashes, underscores, and hyphens
 * to accommodate display names like "Claude Sonnet 4.6 (Thinking)", while
 * excluding shell metacharacters so the value can be safely single-quoted
 * when building the `agy --model '<name>'` launch command.
 */
export const ANTIGRAVITY_MODEL_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9 ()./_-]*$/;

/** Maximum length for Antigravity model names (same limit as Copilot). */
export const MAX_ANTIGRAVITY_MODEL_NAME_LENGTH = 128;
