/**
 * Session facade barrel.
 *
 * Re-exports are **explicit** on purpose (Issue #1922, §4 D4 (d)).
 *
 * `src/lib/session/**` holds modules that are on the `no-restricted-imports`
 * allowlist for `src/lib/tmux/**`, so the ESLint rule is off inside them. A
 * `export * from './claude-session'` here would therefore mean that the day
 * `claude-session.ts` (or any other allowlisted module) re-exports a tmux
 * symbol, every consumer of `@/lib/session` could reach tmux with an import
 * path the guard cannot see — the star hides both the addition and the leak.
 * Naming every symbol makes such a leak a visible diff instead of a silent one,
 * and `tests/unit/guards/tmux-import-allowlist.test.ts` pins that no allowlisted
 * module re-exports from a tmux path.
 */

export {
  CLAUDE_INIT_TIMEOUT,
  CLAUDE_INIT_POLL_INTERVAL,
  CLAUDE_POST_PROMPT_DELAY,
  CLAUDE_PROMPT_WAIT_TIMEOUT,
  CLAUDE_SEND_PROMPT_WAIT_TIMEOUT,
  CLAUDE_PROMPT_POLL_INTERVAL,
  clearCachedClaudePath,
  isSessionHealthy,
  getSessionName,
  isClaudeInstalled,
  isClaudeRunning,
  getClaudeSessionState,
  waitForPrompt,
  startClaudeSession,
  sendMessageToClaude,
  captureClaudeOutput,
  stopClaudeSession,
  restartClaudeSession,
} from './claude-session'
export type {
  HealthCheckResult,
  ClaudeSessionOptions,
  ClaudeSessionState,
} from './claude-session'

// cli-session.ts: getSessionName conflicts with claude-session.ts, use direct import
export {
  captureSessionOutput,
  captureSessionOutputFresh,
  isSessionRunning,
  getSessionName as getCliSessionName,
} from './cli-session'

export { detectWorktreeSessionStatus } from './worktree-status-helper'
export type { CliToolSessionStatus, WorktreeSessionStatus } from './worktree-status-helper'

export {
  MAX_OUTPUT_SIZE,
  MAX_STORED_OUTPUT_SIZE,
  EXECUTION_TIMEOUT_MS,
  MAX_MESSAGE_LENGTH,
  ALLOWED_CLI_TOOLS,
  getCommandForTool,
  truncateOutput,
  buildCliArgs,
  executeClaudeCommand,
  getActiveProcesses,
} from './claude-executor'
export type { ExecuteCommandOptions, ExecutionResult } from './claude-executor'
