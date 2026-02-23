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
} from './tmux';
import {
  CLAUDE_PROMPT_PATTERN,
  CLAUDE_TRUST_DIALOG_PATTERN,
  CLAUDE_SESSION_ERROR_PATTERNS,
  CLAUDE_SESSION_ERROR_REGEX_PATTERNS,
  stripAnsi,
} from './cli-patterns';
import { detectAndResendIfPastedText } from './pasted-text-helper';
import { exec } from 'child_process';
import { promisify } from 'util';
import { access, constants } from 'fs/promises';

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
 * Shell prompt ending characters for detecting shell-only tmux sessions
 * Extensible array to support multiple shell types (MF-002: OCP)
 * Placed in claude-session.ts as private constant (SF-S2-002: ISP - used only by isSessionHealthy())
 * - '$': bash/sh default prompt
 * - '%': zsh default prompt
 * - '#': root prompt (bash/zsh)
 *
 * C-S2-002: False positive risk assessment:
 * These characters are checked only at the END of trimmed output. This limits false
 * positives to cases where Claude CLI output ends with one of these characters
 * (e.g., output containing "$" at end of a code block). The risk is acceptable because:
 * (1) Claude CLI output typically ends with a prompt (❯) or thinking indicator, not shell chars
 * (2) A false positive triggers session recreation, which is a safe recovery action
 * (3) The check is combined with error pattern detection for multiple signals
 */
const SHELL_PROMPT_ENDINGS: readonly string[] = ['$', '%', '#'] as const;

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
 * 15 seconds provides headroom for slower networks or cold starts.
 */
export const CLAUDE_INIT_TIMEOUT = 15000;

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
 * - CLAUDE_INIT_TIMEOUT (15000ms): Session initialization timeout
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
 * Maximum expected length of a shell prompt line (characters)
 *
 * Shell prompts are typically under 40 characters (e.g., "user@host:~/project$" ~30 chars).
 * Lines at or above this threshold are not considered shell prompts, preventing
 * false positives from Claude CLI output that happens to end with $, %, or #.
 *
 * Used by isSessionHealthy() to distinguish shell prompts from CLI output.
 * 40 is an empirical threshold with safety margin.
 */
const MAX_SHELL_PROMPT_LENGTH = 40;

/**
 * Number of tail lines used for error pattern detection in isSessionHealthy()
 *
 * Error patterns are only searched within the last N lines of pane output,
 * not the entire buffer. This prevents false negatives where historical
 * (already recovered) errors in the scrollback trigger unhealthy detection.
 *
 * 10 lines provides sufficient window to catch recent errors while ignoring
 * historical ones that have scrolled up.
 */
const HEALTH_CHECK_ERROR_TAIL_LINES = 10;

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
    console.log(`[claude-session] CLAUDE_PATH contains invalid characters, ignoring: ${claudePath.substring(0, 50)}`);
    return false;
  }

  // (2) Path traversal prevention: reject ../ sequences
  // SEC-MF-001: Prevents path traversal attacks
  if (claudePath.includes('..')) {
    console.log('[claude-session] CLAUDE_PATH contains path traversal sequence, ignoring');
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
        console.log(`[claude-session] CLAUDE_PATH is not executable: ${envClaudePath}`);
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
 * @internal Exported for testing purposes only.
 * Follows clearCachedClaudePath() precedent (L148-156).
 *
 * @param sessionName - tmux session name
 * @returns HealthCheckResult with healthy status and optional reason
 */
export async function isSessionHealthy(sessionName: string): Promise<HealthCheckResult> {
  try {
    // SF-001: Use shared helper instead of inline capturePane + stripAnsi
    const cleanOutput = await getCleanPaneOutput(sessionName);

    // MF-002: Check shell prompt endings from extensible array (OCP)
    const trimmed = cleanOutput.trim();

    // S2-F010: Empty output judgment (HealthCheckResult format)
    // C-S2-001: Empty output means tmux session exists but Claude CLI has no output.
    // This is treated as unhealthy because a properly running Claude CLI always
    // produces output (prompt, spinner, or response). An empty pane indicates
    // the CLI process has exited or failed to start.
    if (trimmed === '') {
      return { healthy: false, reason: 'empty output' };
    }

    // Active state detection: check for Claude prompt BEFORE error patterns.
    // This prevents false negatives where historical (recovered) errors in
    // the pane scrollback cause a currently-active session to be marked unhealthy.
    if (CLAUDE_PROMPT_PATTERN.test(trimmed)) {
      return { healthy: true };
    }

    // S2-F010: Error pattern detection - limited to tail lines only.
    // Only the last HEALTH_CHECK_ERROR_TAIL_LINES lines are searched, so
    // historical errors that have scrolled up do not trigger false negatives.
    const allLines = trimmed.split('\n').filter(line => line.trim() !== '');
    const tailLines = allLines.slice(-HEALTH_CHECK_ERROR_TAIL_LINES);
    const tailText = tailLines.join('\n');

    // MF-001: Check error patterns from cli-patterns.ts (SRP - pattern management centralized)
    for (const pattern of CLAUDE_SESSION_ERROR_PATTERNS) {
      if (tailText.includes(pattern)) {
        return { healthy: false, reason: `error pattern: ${pattern}` };
      }
    }
    for (const regex of CLAUDE_SESSION_ERROR_REGEX_PATTERNS) {
      if (regex.test(tailText)) {
        return { healthy: false, reason: `error pattern: ${regex.source}` };
      }
    }

    // S2-F002: Extract last line after empty line filtering
    const lastLine = allLines[allLines.length - 1]?.trim() ?? '';

    // F006: Line length check BEFORE SHELL_PROMPT_ENDINGS check (early return)
    if (lastLine.length >= MAX_SHELL_PROMPT_LENGTH) {
      // Long lines are not shell prompts -> treat as healthy (early return)
      return { healthy: true };
    }

    // F003: Individual pattern exclusions for SHELL_PROMPT_ENDINGS
    // NOTE(F003): If new false positive patterns are found in the future,
    // consider refactoring to a structure that associates exclusionPattern
    // with each SHELL_PROMPT_ENDINGS entry. Currently only % needs exclusion (YAGNI).
    if (SHELL_PROMPT_ENDINGS.some(ending => {
      if (!lastLine.endsWith(ending)) return false;
      // Exclude N% pattern (e.g., "Context left until auto-compact: 7%")
      if (ending === '%' && /\d+%$/.test(lastLine)) return false;
      return true;
    })) {
      return { healthy: false, reason: `shell prompt ending detected: ${lastLine}` };
    }

    return { healthy: true };
  } catch {
    // S3-F001: Catch block also returns HealthCheckResult format
    return { healthy: false, reason: 'capture error' };
  }
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
    console.warn(`[health-check] Session ${sessionName} unhealthy: ${result.reason}`);
    await killSession(sessionName);
    return false;
  }
  return true;
}

// ----- Environment Sanitization (Bug 3) -----

/**
 * Remove CLAUDECODE environment variable from tmux session environment
 * Prevents Claude Code from detecting nested session and refusing to start
 * (SF-002: SRP - environment sanitization separated from session creation)
 *
 * MF-S3-002: tmux set-environment -g -u operates on the global tmux environment.
 * Impact analysis:
 * - CLAUDECODE is a Claude Code-specific variable, so Codex/Gemini sessions
 *   (CLI_TOOL_IDS: ['claude', 'codex', 'gemini']) are NOT affected by its removal.
 * - Multiple Claude sessions concurrently calling unset (-g -u) is safe because
 *   the unset operation is idempotent (unsetting an already-unset variable is a no-op).
 *
 * SEC-SF-001: sessionName is validated by the caller chain:
 * ClaudeTool.startSession() -> BaseCLITool.getSessionName() -> validateSessionName()
 * This ensures sessionName contains only safe characters (alphanumeric + hyphen).
 *
 * SEC-SF-003: Migration trigger for session-scoped set-environment (without -g flag):
 * - When sanitization of additional environment variables (e.g., CODEX_*, GEMINI_*)
 *   is required, migrate to session-scoped operations to prevent cross-session side effects.
 * - Current scope (CLAUDECODE only) is safe with global scope due to idempotent unset.
 *
 * @param sessionName - tmux session name
 */
async function sanitizeSessionEnvironment(sessionName: string): Promise<void> {
  // 3-1: Remove from tmux global environment
  // MF-S3-002: -g flag affects global tmux environment.
  // Safe because: (1) CLAUDECODE is Claude-specific, (2) unset is idempotent.
  await execAsync('tmux set-environment -g -u CLAUDECODE 2>/dev/null || true');

  // 3-2: Unset inside the session shell (safety net)
  // 100ms wait: empirically determined time for sendKeys command to reach the shell
  // SF-S3-004: 100ms is 0.67% of CLAUDE_INIT_TIMEOUT (15000ms), acceptable overhead
  await sendKeys(sessionName, 'unset CLAUDECODE', true);
  await new Promise(resolve => setTimeout(resolve, 100));
}

/**
 * Options for starting a Claude session
 */
export interface ClaudeSessionOptions {
  worktreeId: string;
  worktreePath: string;
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
 * @param worktreeId - Worktree ID
 * @returns tmux session name
 *
 * @example
 * ```typescript
 * getSessionName('feature-foo') // => 'mcbd-claude-feature-foo'
 * ```
 */
export function getSessionName(worktreeId: string): string {
  return `mcbd-claude-${worktreeId}`;
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
export async function isClaudeRunning(worktreeId: string): Promise<boolean> {
  const sessionName = getSessionName(worktreeId);
  const exists = await hasSession(sessionName);
  if (!exists) {
    return false;
  }
  // MF-S3-001: Verify session health to avoid reporting broken sessions as running
  // S2-F001: await + extract .healthy to maintain boolean return type
  const result = await isSessionHealthy(sessionName);
  if (!result.healthy) {
    console.warn(`[isClaudeRunning] Session ${sessionName} unhealthy: ${result.reason}`);
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
  worktreeId: string
): Promise<ClaudeSessionState> {
  const sessionName = getSessionName(worktreeId);
  const isRunning = await hasSession(sessionName);

  return {
    sessionName,
    isRunning,
    lastActivity: new Date(),
  };
}

/**
 * Wait for session to be at prompt state
 * Polls for prompt detection using CLAUDE_PROMPT_PATTERN (DRY-001)
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
  const startTime = Date.now();
  const pollInterval = CLAUDE_PROMPT_POLL_INTERVAL;

  while (Date.now() - startTime < timeout) {
    // SF-001: Use getCleanPaneOutput helper (DRY)
    const cleanOutput = await getCleanPaneOutput(sessionName);
    // DRY-001: Use CLAUDE_PROMPT_PATTERN from cli-patterns.ts
    if (CLAUDE_PROMPT_PATTERN.test(cleanOutput)) {
      return; // Prompt detected
    }
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  throw new Error(`Prompt detection timeout (${timeout}ms)`);
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
  const { worktreeId, worktreePath } = options;

  // Check if Claude is installed
  const claudeAvailable = await isClaudeInstalled();
  if (!claudeAvailable) {
    throw new Error('Claude CLI is not installed or not in PATH');
  }

  const sessionName = getSessionName(worktreeId);

  // Check if session already exists
  const exists = await hasSession(sessionName);
  if (exists) {
    // SF-S2-004: Health check on existing session
    const healthy = await ensureHealthySession(sessionName);
    if (healthy) {
      console.log(`Claude session ${sessionName} already exists and is healthy`);
      return;
    }
    // If not healthy, ensureHealthySession() already killed the session.
    // Fall through to the session creation logic below.
    // (SF-S2-004: Explicit fall-through instead of hidden re-entry)
  }

  try {
    // Create tmux session with large history buffer for Claude output
    await createSession({
      sessionName,
      workingDirectory: worktreePath,
      historyLimit: 50000,
    });

    // SF-S2-003: Sanitize environment after createSession, before launching Claude CLI
    await sanitizeSessionEnvironment(sessionName);

    // Get Claude CLI path dynamically
    const claudePath = await getClaudePath();

    // Start Claude CLI in interactive mode using dynamically resolved path
    await sendKeys(sessionName, claudePath, true);

    // Wait for Claude to initialize with dynamic detection (OCP-001)
    // Use constants instead of hardcoded values
    const maxWaitTime = CLAUDE_INIT_TIMEOUT;
    const pollInterval = CLAUDE_INIT_POLL_INTERVAL;
    const startTime = Date.now();

    let initialized = false;
    let trustDialogHandled = false;
    while (Date.now() - startTime < maxWaitTime) {
      await new Promise((resolve) => setTimeout(resolve, pollInterval));

      try {
        // SF-001: Use getCleanPaneOutput helper (DRY)
        const cleanOutput = await getCleanPaneOutput(sessionName);
        // Claude is ready when we see the prompt (DRY-001)
        // Use CLAUDE_PROMPT_PATTERN from cli-patterns.ts for consistency
        // Note: CLAUDE_SEPARATOR_PATTERN was removed from initialization check (Issue #187, P1-1)
        if (CLAUDE_PROMPT_PATTERN.test(cleanOutput)) {
          // Wait for stability after prompt detection (CONS-007, DOC-001)
          await new Promise((resolve) => setTimeout(resolve, CLAUDE_POST_PROMPT_DELAY));
          console.log(`Claude initialized in ${Date.now() - startTime}ms`);
          initialized = true;
          break;
        }

        // Issue #201: Detect trust dialog and auto-respond with Enter
        // Condition order: CLAUDE_PROMPT_PATTERN (above) is checked first for shortest path
        if (!trustDialogHandled && CLAUDE_TRUST_DIALOG_PATTERN.test(cleanOutput)) {
          await sendKeys(sessionName, '', true);
          trustDialogHandled = true;
          console.log('Trust dialog detected, sending Enter to confirm');
          // Continue polling to wait for prompt detection
        }
      } catch {
        // Ignore capture errors during initialization
      }
    }

    // Throw error on timeout instead of silently continuing (CONS-005, IMP-001)
    if (!initialized) {
      throw new Error(`Claude initialization timeout (${CLAUDE_INIT_TIMEOUT}ms)`);
    }

    console.log(`Started Claude session: ${sessionName}`);
  } catch (error: unknown) {
    // MF-S2-002: Clear cached path on all failures (harmless for non-path failures)
    clearCachedClaudePath();
    // SEC-SF-002: Log detailed error server-side, throw generic message to client
    console.log(`[claude-session] Session start failed: ${getErrorMessage(error)}`);
    throw new Error('Failed to start Claude session');
  }
}

/**
 * Send a message to Claude CLI
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
  message: string
): Promise<void> {
  const sessionName = getSessionName(worktreeId);

  // Check if session exists
  const exists = await hasSession(sessionName);
  if (!exists) {
    throw new Error(
      `Claude session ${sessionName} does not exist. Start the session first.`
    );
  }

  // Verify prompt state before sending (CONS-006, DRY-001)
  // SF-001: Use getCleanPaneOutput helper (DRY)
  const cleanOutput = await getCleanPaneOutput(sessionName);
  if (!CLAUDE_PROMPT_PATTERN.test(cleanOutput)) {
    // Path B: Prompt not detected - wait for it (P1: throw on timeout)
    await waitForPrompt(sessionName, CLAUDE_SEND_PROMPT_WAIT_TIMEOUT);
  }

  // P0: Stability delay after prompt detection (both Path A and Path B)
  await new Promise((resolve) => setTimeout(resolve, CLAUDE_POST_PROMPT_DELAY));

  // Send message using sendKeys consistently (CONS-001)
  await sendKeys(sessionName, message, false);
  await sendKeys(sessionName, '', true);

  // Issue #212: Detect [Pasted text] and resend Enter for multi-line messages
  // MF-001: Single-line messages skip detection (+0ms overhead)
  if (message.includes('\n')) {
    await detectAndResendIfPastedText(sessionName);
  }

  console.log(`Sent message to Claude session: ${sessionName}`);
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
  lines: number = 1000
): Promise<string> {
  const sessionName = getSessionName(worktreeId);

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
 *
 * @param worktreeId - Worktree ID
 * @returns True if session was stopped, false if it didn't exist
 *
 * @example
 * ```typescript
 * await stopClaudeSession('feature-foo');
 * ```
 */
export async function stopClaudeSession(worktreeId: string): Promise<boolean> {
  const sessionName = getSessionName(worktreeId);

  try {
    // Send Ctrl+D to exit Claude gracefully
    const exists = await hasSession(sessionName);
    if (exists) {
      await sendKeys(sessionName, '', false);
      // Send Ctrl+D (ASCII 4)
      await execAsync(`tmux send-keys -t "${sessionName}" C-d`);

      // Wait a moment for Claude to exit
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    // Kill the tmux session
    const killed = await killSession(sessionName);

    if (killed) {
      console.log(`Stopped Claude session: ${sessionName}`);
    }

    return killed;
  } catch (error: unknown) {
    console.error(`Error stopping Claude session: ${getErrorMessage(error)}`);
    return false;
  }
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
  const { worktreeId } = options;

  // Stop existing session
  await stopClaudeSession(worktreeId);

  // Wait a moment before restarting
  await new Promise((resolve) => setTimeout(resolve, 1000));

  // Start new session
  await startClaudeSession(options);
}
