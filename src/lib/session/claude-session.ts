/**
 * Claude CLI session management
 * Manages Claude CLI sessions within tmux for each worktree
 */

import {
  hasSession,
  createSession,
  sendKeys,
  capturePane,
  killSession,
  reconcileSessionGeometry,
} from '@/lib/tmux/tmux';
import {
  CLAUDE_PROMPT_PATTERN,
  CLAUDE_TRUST_DIALOG_PATTERN,
  stripAnsi,
} from '@/lib/detection/cli-patterns';
import { findFatalPattern } from '@/lib/detection/tool-liveness';
import { resolveLivenessSpec } from '@/lib/cli-tools/liveness-spec';
import { probeSessionLiveness } from '@/lib/cli-tools/session-liveness';
import {
  sanitizeSessionEnvironment,
  waitForPrompt as waitForPromptInternal,
  sendMessageToSession,
  stopSession,
} from '@/lib/session-key-sender';
import { exec } from 'child_process';
import { promisify } from 'util';
import { access, constants } from 'fs/promises';
import { createLogger } from '@/lib/logger';
import { CLAUDE_RESTART_DELAY_MS } from '@/config/cli-tool-timing-config';
import { deriveSessionSuffix } from '@/lib/cli-tools/types';
import { CLAUDE_CLI_TOOL_ID } from '@/lib/hooks/sources';
import {
  beginAgentSession,
  buildAgentLaunchCommandLine,
} from '@/lib/session/agent-session-lifecycle';
import { discardAgentEventState } from '@/lib/session/agent-event-state';
import {
  SessionStartFailedError,
  SessionStartTimeoutError,
  SessionStartUnavailableError,
  isSafeSessionStartError,
} from '@/lib/session/session-start-error';

const logger = createLogger('claude-session');

const execAsync = promisify(exec);

// ----- Helper Functions -----

/**
 * Extract error message from unknown error type
 * Provides consistent error message extraction across the module (DRY)
 *
 * @param error - Unknown error object
 * @returns Error message string
 */
function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ----- Shell Prompt Detection Constants -----

/**
 * Issue #2070: the shell-prompt endings, the 40-character gate and the
 * error-pattern tail this module used to declare privately are now
 * `SHELL_PROMPT_ENDINGS` / `MAX_SHELL_PROMPT_LENGTH` / `FATAL_PATTERN_TAIL_LINES`
 * in `lib/detection/tool-liveness`, and claude's use of them is
 * `resolveLivenessSpec('claude')`.
 *
 * They moved because the rule they describe was never claude-specific — only
 * these values were. A tmux session that outlives its agent looks the same for
 * codex, copilot, opencode and gemini, and every one of them reported `running`
 * for a pane that had fallen back to the shell, because the only check for it
 * sat behind `cliToolId === 'claude'`. The values themselves are unchanged, and
 * `tests/unit/lib/claude-session.test.ts` still pins every verdict this
 * function reaches.

// ----- Timeout and Polling Constants (OCP-001) -----
// These constants are exported to allow configuration and testing.
// Changing these values affects Claude CLI session startup behavior.

/**
 * Claude CLI initialization max wait time (milliseconds)
 *
 * This timeout allows sufficient time for Claude CLI to:
 * - Load and initialize its internal state
 * - Authenticate with Anthropic servers (if needed)
 * - Display the interactive prompt
 *
 * This timeout also covers trust dialog auto-response time (typically <1s).
 * When reducing this value, consider dialog response overhead.
 *
 * Issue #1637: raised from 15s to 60s. Measured on the reporter's machine
 * (macOS, Claude Code v2, private tmux socket, the same detection predicates
 * this module uses — `Yes, I trust this folder` for the dialog and
 * CLAUDE_PROMPT_PATTERN for readiness):
 *
 *   - idle, already-trusted repository worktree : 1443 / 1470 ms
 *   - idle, fresh directory (trust dialog shown): 1885 / 1896 / 1902 ms
 *     (dialog visible at ~940 ms, prompt ~950 ms after it is answered)
 *   - six cold starts launched concurrently     : 2845 / 3450 / 3488 / 4206 /
 *                                                 4215 / 4850 ms
 *
 * So a healthy cold start costs ~2s idle and ~5s at six-way concurrency, and
 * 15s left under 4x headroom over the concurrent case. That is what the six
 * production failures spent: the machine was running an orchestration (several
 * agent sessions plus test suites and builds), and the Issue's own reproduction
 * — re-send ~30s later succeeds — puts the real ready time in that run above
 * 15s and at or below ~45s. 60s covers it with margin and is the same order of
 * magnitude as the window Codex already allows (3s + 30 x 1s polls ≈ 33s).
 *
 * Waiting longer costs nothing on the healthy path (the loop exits as soon as
 * the prompt appears) and a session whose output already shows a terminal error
 * fails immediately rather than consuming the budget — see the error-pattern
 * check in startClaudeSession().
 *
 * This is the *first start* budget only. Sending to a session that already
 * exists is bounded separately by CLAUDE_SEND_PROMPT_WAIT_TIMEOUT (10s), which
 * is unchanged.
 */
export const CLAUDE_INIT_TIMEOUT = 60000;

/**
 * Initialization polling interval (milliseconds)
 *
 * How frequently we check if Claude CLI has finished initializing.
 * 300ms balances responsiveness with avoiding excessive polling overhead.
 */
export const CLAUDE_INIT_POLL_INTERVAL = 300;

/**
 * Stability delay after prompt detection (milliseconds)
 *
 * This delay is necessary because Claude CLI renders its UI progressively:
 * 1. The prompt character (> or U+276F) appears first
 * 2. Additional UI elements (tips, suggestions) may render afterward
 * 3. Sending input too quickly can interrupt this rendering process
 *
 * The 500ms value was empirically determined to provide sufficient buffer
 * for Claude CLI to complete its initialization rendering while maintaining
 * responsive user experience. (DOC-001)
 *
 * @see Issue #152 - First message not being sent after session start
 */
export const CLAUDE_POST_PROMPT_DELAY = 500;

/**
 * Prompt wait timeout before message send (milliseconds)
 *
 * When sending a message, we first verify Claude is at a prompt state.
 * This timeout limits how long we wait for Claude to return to prompt
 * if it's still processing a previous request.
 */
export const CLAUDE_PROMPT_WAIT_TIMEOUT = 5000;

/**
 * Prompt wait timeout before message send (milliseconds).
 *
 * Used exclusively by sendMessageToClaude() to limit how long we wait
 * for Claude to return to a prompt state before sending a user message.
 * This is separate from CLAUDE_PROMPT_WAIT_TIMEOUT (5000ms, the default
 * for waitForPrompt()) because sendMessageToClaude() may be called
 * shortly after session initialization, where Claude CLI needs additional
 * time to become ready.
 *
 * Relationship to other timeout constants:
 * - CLAUDE_PROMPT_WAIT_TIMEOUT (5000ms): Default for waitForPrompt()
 * - CLAUDE_SEND_PROMPT_WAIT_TIMEOUT (10000ms): sendMessageToClaude() specific
 * - CLAUDE_INIT_TIMEOUT (60000ms): first-start initialization budget (Issue #1637)
 *
 * @see Issue #187 - Constant unification for sendMessageToClaude timeout
 */
export const CLAUDE_SEND_PROMPT_WAIT_TIMEOUT = 10000;

/**
 * Prompt wait polling interval (milliseconds)
 *
 * How frequently we check for prompt state before sending messages.
 * 200ms provides quick response while minimizing CPU usage.
 */
export const CLAUDE_PROMPT_POLL_INTERVAL = 200;

/**
 * Issue #2070: `MAX_SHELL_PROMPT_LENGTH` and `HEALTH_CHECK_ERROR_TAIL_LINES`
 * moved to `lib/detection/tool-liveness` with the rule that reads them. Their
 * values are unchanged and claude reaches them through
 * `resolveLivenessSpec('claude')`.
 */
const CLAUDE_LIVENESS_SPEC = resolveLivenessSpec('claude');

/**
 * Cached Claude CLI path
 */
let cachedClaudePath: string | null = null;

/**
 * Clear cached Claude CLI path
 * Called when session start fails to allow path re-resolution
 * on next attempt (e.g., after CLI update or path change)
 * @internal Exported for testing purposes only.
 * Follows the same pattern as version-checker.ts resetCacheForTesting().
 * Function name clearCachedClaudePath() is retained (without ForTesting suffix)
 * because it is also called in production code (catch block), not only in tests.
 * (SF-S2-005: Consistent @internal usage with version-checker.ts precedent)
 */
export function clearCachedClaudePath(): void {
  cachedClaudePath = null;
}

/**
 * Validate CLAUDE_PATH environment variable to prevent command injection
 * SEC-MF-001: OWASP A03:2021 - Injection prevention
 *
 * @param claudePath - Value from process.env.CLAUDE_PATH
 * @returns true if the path is safe to use
 */
function isValidClaudePath(claudePath: string): boolean {
  // (1) Whitelist validation: only allow alphanumeric, path separators, dots, hyphens, underscores
  // SEC-MF-001: Rejects shell metacharacters (;, |, &, $, `, newlines, spaces in dangerous positions, etc.)
  const SAFE_PATH_PATTERN = /^[/a-zA-Z0-9._-]+$/;
  if (!SAFE_PATH_PATTERN.test(claudePath)) {
    logger.info('claudepath-contains-invalid-characters-i');
    return false;
  }

  // (2) Path traversal prevention: reject ../ sequences
  // SEC-MF-001: Prevents path traversal attacks
  if (claudePath.includes('..')) {
    logger.info('claudepath-contains-path');
    return false;
  }

  return true;
}

/**
 * Get Claude CLI path dynamically
 * Uses CLAUDE_PATH environment variable if set, otherwise finds via 'which'
 * SEC-MF-001: Validates CLAUDE_PATH before caching
 */
async function getClaudePath(): Promise<string> {
  // Return cached path if available
  if (cachedClaudePath) {
    return cachedClaudePath;
  }

  // Check environment variable first with validation (SEC-MF-001)
  const envClaudePath = process.env.CLAUDE_PATH;
  if (envClaudePath) {
    if (isValidClaudePath(envClaudePath)) {
      try {
        await access(envClaudePath, constants.X_OK);
        cachedClaudePath = envClaudePath;
        return cachedClaudePath;
      } catch {
        logger.info('claudepath-is-not-executable:envclaudepa');
        // Fall through to fallback paths
      }
    }
    // If validation fails, ignore CLAUDE_PATH and proceed with fallback resolution
  }

  // Find claude via 'which' command
  try {
    const { stdout } = await execAsync('which claude', { timeout: 5000 });
    cachedClaudePath = stdout.trim();
    return cachedClaudePath;
  } catch {
    // Fallback to common paths
    const fallbackPaths = [
      '/opt/homebrew/bin/claude',  // macOS Homebrew (Apple Silicon)
      '/usr/local/bin/claude',     // macOS Homebrew (Intel) / Linux
      '/usr/bin/claude',           // Linux system install
    ];

    for (const path of fallbackPaths) {
      try {
        await execAsync(`test -x "${path}"`, { timeout: 1000 });
        cachedClaudePath = path;
        return cachedClaudePath;
      } catch {
        // Path not found, try next
      }
    }

    throw new Error('Claude CLI not found. Set CLAUDE_PATH environment variable or install Claude CLI.');
  }
}

// ----- Common Helper Functions (SF-001) -----

/**
 * Capture tmux pane output and strip ANSI escape sequences
 * Consolidates the common capturePane + stripAnsi pattern (SF-001: DRY)
 *
 * @param sessionName - tmux session name
 * @param lines - Number of lines to capture (default: 50, captures from -lines)
 * @returns Clean pane output with ANSI codes removed
 */
async function getCleanPaneOutput(sessionName: string, lines: number = 50): Promise<string> {
  const output = await capturePane(sessionName, { startLine: -lines });
  return stripAnsi(output);
}

/**
 * The terminal error pattern visible in the tail of `cleanOutput`, or null.
 *
 * Extracted from isSessionHealthy() so the initialization loop can apply the
 * same judgement (Issue #1637): with a 60s start budget, a session that has
 * already printed "Claude Code cannot be launched inside another Claude Code
 * session" must not sit there burning the whole budget before saying so.
 *
 * Only the last `FATAL_PATTERN_TAIL_LINES` lines are searched, so a historical
 * error that has scrolled up cannot condemn a session that recovered.
 *
 * Issue #2070: the search itself is `findFatalPattern`, shared with every other
 * tool's liveness probe; claude's patterns ride in its `ToolLivenessSpec`.
 *
 * @param cleanOutput - ANSI-stripped pane output
 * @returns The matched pattern (or regex source) for the log, or null
 */
function findSessionErrorPattern(cleanOutput: string): string | null {
  return findFatalPattern(cleanOutput, CLAUDE_LIVENESS_SPEC);
}

// ----- Health Check Functions (Bug 2) -----

/**
 * @internal Exported for testing purposes only.
 * Enables type-safe reason validation in unit tests.
 */
export interface HealthCheckResult {
  healthy: boolean;
  reason?: string;
}

/**
 * Verify that Claude CLI is actually running inside a tmux session
 * Detects broken sessions where tmux exists but Claude failed to start
 *
 * Issue #405: Promoted from @internal to production export.
 * Used by worktrees/route.ts and worktrees/[id]/route.ts for
 * health-aware session status with listSessions() batch optimization.
 *
 * Issue #2070: the algorithm moved to `judgeToolLiveness`, which is the same
 * rule read through claude's `ToolLivenessSpec`. Every branch, every reason
 * string and every ordering decision this function used to spell inline is
 * preserved there — the empty-output verdict, the whole-frame
 * `CLAUDE_PROMPT_PATTERN` check BEFORE the error patterns (so a recovered
 * session is not condemned by scrollback), the 40-character gate, and the
 * `\d+%$` carve-out that keeps `Context left until auto-compact: 7%` from
 * reading as a zsh prompt. What changed is that six other tools can now be
 * asked the same question; see `lib/cli-tools/liveness-spec`.
 *
 * @param sessionName - tmux session name
 * @returns HealthCheckResult with healthy status and optional reason
 */
export async function isSessionHealthy(sessionName: string): Promise<HealthCheckResult> {
  const verdict = await probeSessionLiveness(sessionName, CLAUDE_LIVENESS_SPEC);
  return verdict.alive ? { healthy: true } : { healthy: false, reason: verdict.reason };
}

/**
 * Ensure the existing tmux session has a healthy Claude CLI process
 * If unhealthy, kill the session so it can be recreated
 * (SF-002: SRP - session health management separated from session creation)
 *
 * @param sessionName - tmux session name
 * @returns true if session is healthy and can be reused, false if it was killed
 */
async function ensureHealthySession(sessionName: string): Promise<boolean> {
  const result = await isSessionHealthy(sessionName);
  if (!result.healthy) {
    logger.warn('session-sessionname-unhealthy:resultreas');
    await killSession(sessionName);
    return false;
  }
  return true;
}

/**
 * Options for starting a Claude session
 */
export interface ClaudeSessionOptions {
  worktreeId: string;
  worktreePath: string;
  /** Optional agent instance ID (Issue #868). Defaults to the primary instance. */
  instanceId?: string;
}

/**
 * Claude session state
 */
export interface ClaudeSessionState {
  sessionName: string;
  isRunning: boolean;
  lastActivity: Date;
}

/**
 * Get tmux session name for a worktree
 *
 * Issue #868: Supports additional agent instances. The primary instance
 * (instanceId omitted or equal to 'claude') keeps the original
 * `mcbd-claude-{worktreeId}` name for backward compatibility. Additional
 * instances append a suffix derived from the instance ID.
 *
 * @param worktreeId - Worktree ID
 * @param instanceId - Optional agent instance ID (defaults to primary)
 * @returns tmux session name
 *
 * @example
 * ```typescript
 * getSessionName('feature-foo') // => 'mcbd-claude-feature-foo'
 * getSessionName('feature-foo', 'claude-2') // => 'mcbd-claude-feature-foo-2'
 * ```
 */
export function getSessionName(worktreeId: string, instanceId?: string): string {
  const base = `mcbd-claude-${worktreeId}`;
  if (!instanceId || instanceId === 'claude') {
    return base;
  }
  const suffix = deriveSessionSuffix(instanceId, 'claude');
  return suffix ? `${base}-${suffix}` : base;
}

/**
 * Check if Claude is installed and available
 *
 * @returns True if Claude CLI is available
 */
export async function isClaudeInstalled(): Promise<boolean> {
  try {
    await execAsync('which claude', { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if Claude session is running
 * MF-S3-001: Includes health check to prevent reporting broken sessions as running.
 * Without this, API routes (especially send/route.ts) would skip startSession()
 * for broken sessions and attempt to send messages to a non-functional CLI.
 *
 * Performance: adds ~50ms overhead (capturePane + pattern match) per call.
 * This is acceptable given that API route response times are typically 100-500ms.
 *
 * @param worktreeId - Worktree ID
 * @returns True if Claude session exists AND Claude CLI is healthy
 *
 * @example
 * ```typescript
 * const running = await isClaudeRunning('feature-foo');
 * if (running) {
 *   console.log('Claude is ready');
 * }
 * ```
 */
export async function isClaudeRunning(worktreeId: string, instanceId?: string): Promise<boolean> {
  const sessionName = getSessionName(worktreeId, instanceId);
  const exists = await hasSession(sessionName);
  if (!exists) {
    return false;
  }
  // MF-S3-001: Verify session health to avoid reporting broken sessions as running
  // S2-F001: await + extract .healthy to maintain boolean return type
  const result = await isSessionHealthy(sessionName);
  if (!result.healthy) {
    logger.warn('session-sessionname-unhealthy:resultreas');
    return false;
  }
  return true;
}

/**
 * Get Claude session state
 *
 * C-S3-002: This function checks tmux session existence via hasSession() but
 * does NOT perform health checks (unlike isClaudeRunning()). This is intentional:
 * getClaudeSessionState() is a lightweight status query for UI display purposes,
 * while isClaudeRunning() performs the more expensive health check for operational
 * decisions (e.g., whether to recreate a session).
 *
 * If health-aware state is needed, callers should use isClaudeRunning() instead
 * or call ensureHealthySession() separately.
 *
 * @param worktreeId - Worktree ID
 * @returns Session state information (existence-based, not health-based)
 */
export async function getClaudeSessionState(
  worktreeId: string,
  instanceId?: string
): Promise<ClaudeSessionState> {
  const sessionName = getSessionName(worktreeId, instanceId);
  const isRunning = await hasSession(sessionName);

  return {
    sessionName,
    isRunning,
    lastActivity: new Date(),
  };
}

/**
 * Wait for session to be at prompt state
 * Delegates to session-key-sender.ts (Issue #479: SRP split)
 *
 * @param sessionName - tmux session name
 * @param timeout - Timeout in milliseconds (default: CLAUDE_PROMPT_WAIT_TIMEOUT)
 * @throws {Error} If prompt is not detected within timeout
 *
 * @example
 * ```typescript
 * await waitForPrompt('mcbd-claude-feature-foo');
 * // Session is now ready to receive input
 * ```
 */
export async function waitForPrompt(
  sessionName: string,
  timeout: number = CLAUDE_PROMPT_WAIT_TIMEOUT
): Promise<void> {
  return waitForPromptInternal(sessionName, timeout);
}

/**
 * Start a Claude CLI session in tmux
 *
 * @param options - Session options
 * @throws {Error} If Claude CLI is not installed or session creation fails
 *
 * @example
 * ```typescript
 * await startClaudeSession({
 *   worktreeId: 'feature-foo',
 *   worktreePath: '/path/to/worktree',
 * });
 * ```
 */
export async function startClaudeSession(
  options: ClaudeSessionOptions
): Promise<void> {
  const { worktreeId, worktreePath, instanceId } = options;

  // Check if Claude is installed
  const claudeAvailable = await isClaudeInstalled();
  if (!claudeAvailable) {
    throw new SessionStartUnavailableError('Claude Code', 'Claude CLI is not installed or not in PATH');
  }

  const sessionName = getSessionName(worktreeId, instanceId);

  // Check if session already exists
  const exists = await hasSession(sessionName);
  if (exists) {
    // SF-S2-004: Health check on existing session
    const healthy = await ensureHealthySession(sessionName);
    if (healthy) {
      await reconcileSessionGeometry(sessionName);
      logger.info('claude-session-sessionname');
      return;
    }
    // If not healthy, ensureHealthySession() already killed the session.
    // Fall through to the session creation logic below.
    // (SF-S2-004: Explicit fall-through instead of hidden re-entry)
  }

  // Issue #1723: everything the previous agent process reported through this
  // (worktreeId, instanceId) belongs to a session that no longer exists. The
  // key is reused verbatim by the session about to be created, so without this
  // fence the last `user_prompt_submit` of the old process would be read as the
  // new one's and a brand-new session would publish `running` before anyone had
  // typed into it.
  //
  // Placed on the creation path only — the reuse branch above has already
  // returned — and before `createSession`, so there is no window in which a
  // live pane is matched against a stale generation. Bumped even if the start
  // then fails: falling back to the scraper is always safe, trusting a dead
  // session's events is not.
  // Issue #1759: through the shared helper, which is the one call every
  // tool's `startSession` makes. Claude's was the only fence in the codebase;
  // making it the helper's job is what lets Phase 4-2…4-5 have one too.
  beginAgentSession({ worktreeId, cliToolId: CLAUDE_CLI_TOOL_ID, instanceId });

  try {
    // Create tmux session. Scrollback depth comes from the shared
    // TMUX_HISTORY_LIMIT default (Issue #1624) — do not re-hardcode it here.
    // (Claude itself renders in the alternate screen and keeps history_size at 0,
    // so the limit is inert for this tool; it still applies to the bare shell.)
    await createSession({
      sessionName,
      workingDirectory: worktreePath,
    });

    // SF-S2-003: Sanitize environment after createSession, before launching Claude CLI
    await sanitizeSessionEnvironment(sessionName);

    // Get Claude CLI path dynamically
    const claudePath = await getClaudePath();

    // Issue #1722: hand this session its own hooks config, so structured
    // lifecycle events exist without the operator having edited
    // ~/.claude/settings.json (which is never written — `--settings` is
    // concatenated with it, and leaves it byte-identical).
    //
    // Only on the creation path. The reuse branch above has already returned,
    // so the injected generation and the tmux session generation are the same
    // generation by construction. A running session *can* be re-hooked — Claude
    // hot-reloads settings without asking (Issue #1721, D8) — but that would
    // make "which config is this pane running?" a question with a time-varying
    // answer, and the events are not load-bearing enough to buy that.
    //
    // Falls back to the bare path on any failure; a session that starts without
    // hooks is the pre-#1722 status quo, and a session that fails to start is not.
    // Issue #1759: which config file gets written, and whether one is written
    // at all, belongs to the tool's `AgentEventSource` (S3/S4). Claude's
    // delegates to `buildClaudeLaunchCommand`, unchanged.
    const launchCommand = buildAgentLaunchCommandLine({
      target: { worktreeId, cliToolId: CLAUDE_CLI_TOOL_ID, instanceId },
      executablePath: claudePath,
      worktreePath,
    });

    // Start Claude CLI in interactive mode using dynamically resolved path
    await sendKeys(sessionName, launchCommand, true);

    // Wait for Claude to initialize with dynamic detection (OCP-001)
    // Use constants instead of hardcoded values
    const maxWaitTime = CLAUDE_INIT_TIMEOUT;
    const pollInterval = CLAUDE_INIT_POLL_INTERVAL;
    const startTime = Date.now();

    let initialized = false;
    let trustDialogHandled = false;
    while (Date.now() - startTime < maxWaitTime) {
      await new Promise((resolve) => setTimeout(resolve, pollInterval));

      // SF-001: Use getCleanPaneOutput helper (DRY)
      let cleanOutput: string | null = null;
      try {
        cleanOutput = await getCleanPaneOutput(sessionName);
      } catch {
        // Ignore capture errors during initialization
      }
      if (cleanOutput === null) {
        continue;
      }

      // Claude is ready when we see the prompt (DRY-001)
      // Use CLAUDE_PROMPT_PATTERN from cli-patterns.ts for consistency
      // Note: CLAUDE_SEPARATOR_PATTERN was removed from initialization check (Issue #187, P1-1)
      if (CLAUDE_PROMPT_PATTERN.test(cleanOutput)) {
        // Wait for stability after prompt detection (CONS-007, DOC-001)
        await new Promise((resolve) => setTimeout(resolve, CLAUDE_POST_PROMPT_DELAY));
        logger.info('claude-initialized-in');
        initialized = true;
        break;
      }

      // Issue #201: Detect trust dialog and auto-respond with Enter
      // Condition order: CLAUDE_PROMPT_PATTERN (above) is checked first for shortest path
      if (!trustDialogHandled && CLAUDE_TRUST_DIALOG_PATTERN.test(cleanOutput)) {
        try {
          await sendKeys(sessionName, '', true);
          trustDialogHandled = true;
          logger.info('trust-dialog-detected');
        } catch {
          // Left unhandled so the next poll answers the dialog again
        }
        // Continue polling to wait for prompt detection
      }

      // Issue #1637: fail fast on a start that cannot succeed. The budget is
      // 60s of patience for a *slow* start; a session already showing a
      // terminal error is not slow, and waiting out the budget would only
      // delay the same answer by 45 more seconds. Checked after the trust
      // dialog so a dialog still on screen is answered first.
      const errorPattern = findSessionErrorPattern(cleanOutput);
      if (errorPattern !== null) {
        // Issue #2000 raised the push notification on this line. Issue #2009
        // moved it up to `BaseCLITool.startSession`, which is the one method
        // every tool inherits: six of the seven had no such line at all, and a
        // seventh copy is how "only claude rings" happened in the first place.
        // Nothing about what the reader receives changed — the error carries the
        // tool name and the detected pattern, which is everything the
        // notification was ever built from — and the sibling
        // `SessionStartTimeoutError` below still deliberately does NOT notify
        // (#1637: the session and its process are alive and the documented
        // advice is to retry in a few seconds).
        throw new SessionStartFailedError('Claude Code', sessionName, errorPattern);
      }
    }

    // Issue #1637: not "failed to start" — the session and the CLI process both
    // exist and are still initializing, and they are deliberately left running
    // so the retry the caller is about to make is cheap. The distinction is
    // carried to the caller by the error type rather than lost in a generic
    // message (CONS-005, IMP-001).
    if (!initialized) {
      throw new SessionStartTimeoutError('Claude Code', sessionName, CLAUDE_INIT_TIMEOUT);
    }

    logger.info('started-claude-session:sessionname');
  } catch (error: unknown) {
    // MF-S2-002: Clear cached path on all failures (harmless for non-path failures)
    clearCachedClaudePath();
    // SEC-SF-002: Log detailed error server-side, throw generic message to client
    logger.error('session:start-failed', { error: error instanceof Error ? error.message : String(error) });
    // Issue #1637: the one exception to SEC-SF-002. These two messages are
    // assembled from a tool name, the tmux session name, a fixed pattern string
    // and a number — no filesystem path, no captured CLI output — so they are
    // safe to hand to the caller, and they are the whole reason the caller can
    // tell "still starting" from "broken" instead of being told to read a log
    // it may not have.
    if (isSafeSessionStartError(error)) {
      throw error;
    }
    throw new Error('Failed to start Claude session');
  }
}

/**
 * Send a message to Claude CLI
 * Delegates to session-key-sender.ts sendMessageToSession() (Issue #479: SRP split)
 *
 * @param worktreeId - Worktree ID
 * @param message - Message content to send
 * @throws {Error} If session doesn't exist
 *
 * @example
 * ```typescript
 * await sendMessageToClaude('feature-foo', 'Explain this code');
 * ```
 */
export async function sendMessageToClaude(
  worktreeId: string,
  message: string,
  instanceId?: string
): Promise<void> {
  const sessionName = getSessionName(worktreeId, instanceId);
  await sendMessageToSession(
    sessionName,
    message,
    CLAUDE_POST_PROMPT_DELAY,
    CLAUDE_SEND_PROMPT_WAIT_TIMEOUT,
  );
}

/**
 * Capture Claude session output
 *
 * @param worktreeId - Worktree ID
 * @param lines - Number of lines to capture (default: 1000)
 * @returns Captured output
 *
 * @example
 * ```typescript
 * const output = await captureClaudeOutput('feature-foo');
 * console.log(output);
 * ```
 */
export async function captureClaudeOutput(
  worktreeId: string,
  lines: number = 1000,
  instanceId?: string
): Promise<string> {
  const sessionName = getSessionName(worktreeId, instanceId);

  // Check if session exists
  const exists = await hasSession(sessionName);
  if (!exists) {
    throw new Error(`Claude session ${sessionName} does not exist`);
  }

  try {
    return await capturePane(sessionName, { startLine: -lines });
  } catch (error: unknown) {
    throw new Error(`Failed to capture Claude output: ${getErrorMessage(error)}`);
  }
}

/**
 * Stop a Claude session
 * Delegates to session-key-sender.ts stopSession() (Issue #479: SRP split)
 *
 * @param worktreeId - Worktree ID
 * @returns True if session was stopped, false if it didn't exist
 *
 * @example
 * ```typescript
 * await stopClaudeSession('feature-foo');
 * ```
 */
export async function stopClaudeSession(worktreeId: string, instanceId?: string): Promise<boolean> {
  const sessionName = getSessionName(worktreeId, instanceId);
  const stopped = await stopSession(sessionName);
  // Issue #1723: the session this instance's structured state described is
  // gone. Belt and braces rather than the load-bearing guard — a stopped
  // session makes `buildCurrentOutput` return `session_not_running` before it
  // ever asks, and a restart opens a new generation — but the state is about a
  // live pane and should not outlive one. Unconditional: `stopSession` answers
  // false for a session that was already gone, which is not a reason to keep
  // state about it.
  discardAgentEventState(worktreeId, 'claude', instanceId);
  return stopped;
}

/**
 * Restart a Claude session
 *
 * @param options - Session options
 *
 * @example
 * ```typescript
 * await restartClaudeSession({
 *   worktreeId: 'feature-foo',
 *   worktreePath: '/path/to/worktree',
 * });
 * ```
 */
export async function restartClaudeSession(
  options: ClaudeSessionOptions
): Promise<void> {
  const { worktreeId, instanceId } = options;

  // Stop existing session
  await stopClaudeSession(worktreeId, instanceId);

  // Wait a moment before restarting
  await new Promise((resolve) => setTimeout(resolve, CLAUDE_RESTART_DELAY_MS));

  // Start new session
  await startClaudeSession(options);
}
