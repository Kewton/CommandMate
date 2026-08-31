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
 * Wait (ms) between the two Escape presses that abort an opencode turn.
 *
 * opencode 1.18 does not interrupt on a single Escape. The first press re-labels
 * the footer `esc interrupt` -> `esc again to interrupt` and abandons nothing;
 * only a SECOND Escape inside that label's lifetime aborts the turn.
 *
 * Issue #1894 measured the label on opencode 1.18.21 (private tmux socket,
 * 80x200): sampling the footer every ~360 ms after one Escape, `esc again to
 * interrupt` is up from 0.31 s through 4.71 s and the row has reverted to `esc
 * interrupt` by 5.07 s. So the deadline is five seconds, and a single Escape
 * really does nothing -- the generation continued to a natural
 * `Build ... 11.3s` completion in 3 runs out of 3.
 *
 * 300 ms is the design policy's number
 * (`docs/design/multi-agent-state-architecture.md` §6.3) and it is kept, because
 * both directions of error are bounded by real measurements rather than by
 * taste:
 *
 * - too LATE is the dangerous side (the turn is not aborted and the pane just
 *   collects Escapes). Driving the real `OpenCodeTool.interrupt()` against a
 *   live 1.18.21 session, the whole call -- `send-keys`, this wait, `send-keys`
 *   -- took 317 ms end to end, i.e. the two tmux executions cost ~17 ms and the
 *   press lands at 6% of the deadline. Even the crude shell harness used for
 *   the first probe, which pays a python interpreter per step, landed its
 *   second press at 594 ms: 8x inside the window.
 * - too EARLY would risk the second press being swallowed before opencode has
 *   armed the label. The label was already up at the first sample after the
 *   first press (0.31 s), and both the 317 ms and the 594 ms double-press
 *   aborted the turn (`▣  Build · GPT-5.6 Luna · interrupted` mid-sentence), so
 *   the arming cost is well under one wait.
 *
 * Site: opencode interrupt().
 */
export const OPENCODE_INTERRUPT_SECOND_ESCAPE_DELAY_MS = 300;

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

/**
 * Wait (ms) between the two liveness readings that must agree before a reuse
 * path re-sends a launch command (Issue #2070).
 *
 * There is a real window in which a pane shows a bare shell and nothing is
 * wrong: between `createSession` and the launch line landing. Measured on the
 * five tools this Issue captured (2026-08-31, private socket, 200x1000), the
 * shell frame is the whole pane for 0.4-0.8 s after `new-session` and the
 * tool's first paint follows within 1.3 s. One second between readings puts the
 * second one past that paint, so a booting session is never mistaken for a dead
 * one — the mistake that would type a launch command into a live composer.
 * Site: BaseCLITool.isToolLive({ confirm: true }).
 */
export const LIVENESS_CONFIRM_DELAY_MS = 1000;
