/**
 * Copilot CLI timing constants
 * Issue #565: Centralized delay values for Copilot TUI message sending
 *
 * These constants replace hardcoded 200ms/100ms delays in:
 * - src/app/api/worktrees/[id]/send/route.ts
 * - src/app/api/worktrees/[id]/terminal/route.ts
 * - src/lib/cli-tools/copilot.ts
 */

/**
 * Delay (ms) after sending text before pressing Enter.
 * Copilot CLI auto-enters multi-line mode when text exceeds pane width.
 * In multi-line mode, C-m (bundled with text) adds a newline instead of
 * submitting. This delay allows the TUI to process text before Enter.
 */
export const COPILOT_SEND_ENTER_DELAY_MS = 200;

/**
 * Delay (ms) after sendKeys for text input to be registered.
 * Used in copilot.ts sendMessage() between sendKeys and sendSpecialKey.
 */
export const COPILOT_TEXT_INPUT_DELAY_MS = 100;

/**
 * Maximum message length (in characters) for Copilot messages saved to the database.
 * Issue #571: Messages exceeding this limit are truncated with a marker.
 * Copilot's full-screen TUI can accumulate very large buffers; this prevents
 * excessively large messages from being stored in the chat history.
 */
export const COPILOT_MAX_MESSAGE_LENGTH = 100_000;

/**
 * Marker text prepended to truncated messages.
 * Issue #571: Indicates that the message head was removed to fit within
 * COPILOT_MAX_MESSAGE_LENGTH. The tail (most recent content) is preserved.
 */
export const COPILOT_TRUNCATION_MARKER = '[... truncated ...]';

/**
 * Timeout (ms) for waiting for prompt recovery after /model command.
 * Issue #576: Model switching may take longer than normal prompt detection
 * due to server-side model loading.
 */
export const COPILOT_MODEL_SWITCH_TIMEOUT_MS = 30_000;

/**
 * Copilot model name allowed pattern.
 * Leading character must be alphanumeric to prevent CLI option injection
 * ambiguity with leading '-' (DR4-001).
 * Issue #588: Shared between cmate-cli-tool-parser, send API, and CLI send.
 */
export const MODEL_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9\-._/:]*$/;

/**
 * Maximum length for Copilot model names.
 * Issue #588: Shared validation constant.
 */
export const MAX_MODEL_NAME_LENGTH = 128;
