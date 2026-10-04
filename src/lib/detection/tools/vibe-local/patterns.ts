/**
 * Vibe Local pattern constants moved out of `../../cli-patterns.ts`
 * (Issue #3217). `cli-patterns.ts` re-exports every public name.
 */

/**
 * Vibe Local prompt pattern
 * vibe-local (vibe-coder) shows `ctx:N% ❯` prompt when waiting for user input.
 * The prompt line includes a context usage percentage prefix.
 * Examples: "ctx:9% ❯", "ctx:30% ❯", "ctx:9% ❯ /model"
 */
export const VIBE_LOCAL_PROMPT_PATTERN = /ctx:\d+%\s*[>❯]/m;

/**
 * Vibe Local thinking/processing pattern
 * vibe-local shows spinner characters and status text while processing.
 * Matches braille spinners, "Thinking", and tool execution indicators.
 */
export const VIBE_LOCAL_THINKING_PATTERN = /[\u2800-\u28FF]|Thinking|⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏|Running|Executing/;
