/**
 * CLI / TUI / session interaction timing constants.
 *
 * Issue #760: Consolidates hardcoded setTimeout/setInterval delays that were
 * scattered across `src/lib/cli-tools/*.ts`, `src/lib/session-key-sender.ts`,
 * `src/lib/prompt-answer-sender.ts`, and `src/lib/session/claude-session.ts`.
 *
 * Follows the precedent set by `src/config/copilot-constants.ts` (Issue #565).
 *
 * Design notes:
 * - `TUI_*` constants capture interaction waits that are the SAME operation with
 *   the SAME value across multiple CLI tools (codex/gemini/opencode/vibe-local/
 *   copilot/claude). Sharing them is DRY and, because the values coincide, keeps
 *   behavior identical even if a call site were mapped to a sibling constant.
 * - Tool-specific constants (`CODEX_*`, `OPENCODE_*`, `VIBE_LOCAL_*`, `CLAUDE_*`)
 *   capture timing that reflects a particular tool's behavior and must stay
 *   independently tunable.
 *
 * All values are preserved from the original literals (no behavior change).
 */

/**
 * Wait (ms) after `createSession()` before sending the first keys, giving tmux
 * time to spin up the session.
 * Sites: codex / opencode / gemini / copilot / vibe-local startSession().
 */
export const TUI_SESSION_CREATE_WAIT_MS = 100;

/**
 * Wait (ms) after typing the message text (sendKeys) and before pressing Enter,
 * so the TUI registers the input first.
 * Sites: codex / opencode / gemini / vibe-local sendMessage(),
 * prompt-answer-sender standard-prompt answer.
 */
export const TUI_TEXT_INPUT_WAIT_MS = 100;

/**
 * Wait (ms) after pressing Enter for the message to be processed by the TUI.
 * Sites: codex / opencode / gemini / vibe-local sendMessage().
 */
export const TUI_MESSAGE_PROCESSED_WAIT_MS = 200;

/**
 * Wait (ms) after sending Ctrl+C to let the running operation settle before the
 * next shutdown step.
 * Sites: gemini / vibe-local / copilot killSession().
 */
export const TUI_INTERRUPT_SETTLE_MS = 300;

/**
 * Wait (ms) after an exit/quit command (or Ctrl+D) for the CLI to shut down
 * gracefully before the tmux session is killed.
 * Sites: codex / gemini / vibe-local killSession(),
 * session-key-sender stopSession().
 * (copilot moved to {@link COPILOT_EXIT_WAIT_MS} in Issue #1905.)
 */
export const TUI_EXIT_WAIT_MS = 500;

/**
 * Wait (ms) after Codex `waitForReady` handles a dialog (update skip / notification
 * dismiss / folder trust) before re-polling.
 * Sites: codex waitForReady() (3 occurrences).
 */
export const CODEX_DIALOG_SETTLE_MS = 500;

/**
 * Wait (ms) for OpenCode to process its `/exit` TUI command. Longer than the
 * generic exit wait because OpenCode's TUI teardown is slower.
 * Site: opencode killSession().
 *
 * Issue #1905 measured the teardown on opencode 1.18.21 (private tmux socket,
 * 200x50): once `/exit` is submitted as body-then-Enter the TUI is gone in
 * 0.445 / 0.456 / 0.458 s (n=3), so this window is not the binding constraint.
 * It was left at 2000 rather than tightened because the measurement is for an
 * unloaded machine.
 */
export const OPENCODE_EXIT_WAIT_MS = 2000;

/**
 * Wait (ms) for Copilot to process its `/exit` TUI command before the tmux
 * session is killed. Copilot-specific because {@link TUI_EXIT_WAIT_MS} (500) is
 * shorter than the shutdown actually takes.
 * Site: copilot killSession().
 *
 * Issue #1905 measured GitHub Copilot CLI 1.0.80 in a private tmux socket
 * (200x50, unloaded). Time from the submitting keystroke to the pane's process
 * no longer being `copilot`, across every exit spelling copilot accepts:
 * 1.006 / 1.109 / 1.115 / 1.118 / 1.204 / 1.208 / 1.288 / 1.330 / 1.795 /
 * 2.165 / 2.193 s. Every sample is past 500 ms, i.e. the generic constant
 * guaranteed the tmux kill landed mid-shutdown; 3000 covers the slowest sample
 * with room for a loaded machine.
 */
export const COPILOT_EXIT_WAIT_MS = 3000;

/**
 * Wait (ms) between the two Enter key presses in vibe-local's IME submit mode
 * (first Enter inserts a newline, second Enter submits).
 * Site: vibe-local sendMessage().
 */
export const VIBE_LOCAL_DOUBLE_ENTER_WAIT_MS = 200;

/**
 * Wait (ms) for the `unset CLAUDECODE` command to reach the shell while
 * sanitizing the session environment (empirically determined).
 * Site: session-key-sender sanitizeSessionEnvironment().
 */
export const CLAUDE_ENV_SANITIZE_WAIT_MS = 100;

/**
 * Wait (ms) before restarting a Claude session, after the old session is stopped.
 * Site: claude-session restartClaudeSession().
 */
export const CLAUDE_RESTART_DELAY_MS = 1000;
