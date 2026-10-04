/**
 * Gemini pattern constants moved out of `../../cli-patterns.ts`
 * (Issue #3217). `cli-patterns.ts` re-exports every public name.
 */

/**
 * Gemini interactive REPL prompt pattern
 * Gemini CLI shows a `>` or `❯` prompt when waiting for user input in interactive mode.
 *
 * Two branches (Issue #386):
 * - Branch 1: `^[>❯]\s*$` -- bare prompt character (empty input line)
 * - Branch 2: `^\s*[>❯]\s+Type your message.*$` -- new-format prompt with placeholder text
 *   (e.g., " >   Type your message or @path/to/file"). Leading whitespace is allowed
 *   because tmux capture-pane output may include padding.
 *
 * Branch 2 requires "Type your message" after the indicator to avoid false positives
 * on quoted response lines (e.g., "> some quoted text").
 *
 * @see CLAUDE_PROMPT_PATTERN for similar dual-format matching approach
 */
// [S4-5] /g flag prohibited: would make test() stateful
export const GEMINI_PROMPT_PATTERN = /^[>❯]\s*$|^\s*[>❯]\s+Type your message.*$/m;

/**
 * Gemini thinking/processing pattern
 * Gemini CLI shows braille spinner characters and status text while processing.
 */
export const GEMINI_THINKING_PATTERN = /[\u2800-\u28FF]|Thinking\.\.\./;
