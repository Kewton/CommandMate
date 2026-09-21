/**
 * Claude CLI constants
 * Issue #2771: Model name validation for `claude --model <name>`.
 *
 * Like Antigravity's and unlike Copilot's, `--model` is a LAUNCH-time flag: it
 * is typed into the pane's shell before Claude Code starts, and there is no safe
 * in-session switch — the `/model` picker's Enter rewrites the operator's global
 * default in `~/.claude/settings.json` (#1495 / #2297).
 */

/**
 * Claude model name allowed pattern.
 *
 * Copilot's `MODEL_NAME_PATTERN` plus three characters Claude's own spellings
 * need: `[` and `]` for the context-window suffix (`opus[1m]`,
 * `claude-opus-5[1m]`), and `@` for Vertex ids (`claude-sonnet-5@20260101`).
 * `:` and `/` are already there for Bedrock ids and inference-profile ARNs.
 *
 * Leading character must be alphanumeric, so a value can never be read as a
 * flag. No whitespace, and no shell metacharacter other than `[` `]` — which are
 * inert inside the single quotes the launch command puts around the value.
 */
export const CLAUDE_MODEL_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9\-._/:@[\]]*$/;

/** Maximum length for Claude model names (same limit as Copilot and Antigravity). */
export const MAX_CLAUDE_MODEL_NAME_LENGTH = 128;
