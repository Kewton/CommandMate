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
