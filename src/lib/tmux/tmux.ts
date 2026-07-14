/**
 * tmux session management
 * Provides functions to manage tmux sessions for Claude CLI integration
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { invalidateCache } from './tmux-capture-cache';
import { TUI_PANE_HEIGHT, TUI_PANE_WIDTH } from '@/config/tmux-pane-config';
import { createLogger } from '@/lib/logger';

const execFileAsync = promisify(execFile);
const logger = createLogger('tmux');

/**
 * Default timeout for tmux commands (5 seconds)
 */
const DEFAULT_TIMEOUT = 5000;

/**
 * Build an exact-match tmux target specifier (Issue #1156).
 *
 * tmux resolves a bare `-t <name>` target with prefix/fnmatch matching whenever
 * no session matches `<name>` exactly. Because instance session names are
 * prefixes of one another (`mcbd-<cli>-<wt>` is a prefix of `mcbd-<cli>-<wt>-2`),
 * an operation on the primary session silently leaks to the `-2` instance while
 * the primary is not running: `has-session` reports it "running", `capture-pane`
 * shows the wrong pane, `send-keys` delivers to the wrong instance, and
 * `kill-session` can kill the wrong session.
 *
 * Prefixing the target with `=` disables that fuzzy matching and forces an exact
 * session-name match. EVERY `-t` target in this module (and the control-mode
 * attach in tmux-control-client.ts) MUST go through this helper so no call site
 * can regress to prefix matching.
 *
 * The trailing `:` is REQUIRED, not cosmetic. tmux accepts a bare `=name` only
 * where a session target is expected (has-session/kill-session/set-option). For
 * commands that take a window/pane target (capture-pane/send-keys, and
 * resize-window in opencode.ts), `=name` is parsed as a pane spec and tmux fails
 * with `can't find pane: =name` — which broke ALL session display/send after the
 * initial #1156 fix. `=name:` (session `name`, unspecified window → active) is a
 * valid target for BOTH session and window/pane commands, and still forces exact
 * session matching (a non-existent `=primary:` yields `can't find session`, so it
 * never leaks to the prefix-colliding `-2` instance).
 *
 * @param sessionName - Exact tmux session name to target
 * @returns Target specifier with the `=` exact-match prefix and `:` session terminator
 */
export function exactTarget(sessionName: string): string {
  return `=${sessionName}:`;
}

/**
 * tmux session information
 */
export interface TmuxSession {
  name: string;
  windows: number;
  attached: boolean;
}

/**
 * Options for creating a tmux session
 */
export interface CreateSessionOptions {
  sessionName: string;
  workingDirectory: string;
  historyLimit?: number;  // scrollback バッファサイズ（デフォルト: 50000）
  windowWidth?: number;   // ペイン幅（デフォルト: TUI_PANE_WIDTH）
  windowHeight?: number;  // ペイン高さ（デフォルト: TUI_PANE_HEIGHT、alternate screen TUIで十分な表示行数を確保。Issue #1163）
}

export interface SessionGeometryOptions {
  windowWidth?: number;
  windowHeight?: number;
}

/**
 * Reconcile a session's window geometry without disrupting the running process.
 * Failures are intentionally non-fatal: geometry improves capture fidelity but
 * must never make an otherwise healthy CLI session unusable.
 *
 * @returns true when at least one tmux option was changed.
 */
export async function reconcileSessionGeometry(
  sessionName: string,
  options: SessionGeometryOptions = {},
): Promise<boolean> {
  const windowWidth = options.windowWidth ?? TUI_PANE_WIDTH;
  const windowHeight = options.windowHeight ?? TUI_PANE_HEIGHT;
  const target = exactTarget(sessionName);

  let currentMode: string | undefined;
  let currentWidth: number | undefined;
  let currentHeight: number | undefined;

  try {
    const modeResult = await execFileAsync(
      'tmux',
      ['show-window-options', '-v', '-t', target, 'window-size'],
      { timeout: DEFAULT_TIMEOUT },
    );
    currentMode = modeResult.stdout.trim();

    const sizeResult = await execFileAsync(
      'tmux',
      ['display-message', '-p', '-t', target, '#{window_width}|#{window_height}'],
      { timeout: DEFAULT_TIMEOUT },
    );
    const [width, height] = sizeResult.stdout.trim().split('|').map(Number);
    if (Number.isFinite(width)) currentWidth = width;
    if (Number.isFinite(height)) currentHeight = height;
  } catch {
    // Query failure is not decisive. Attempt the idempotent set/resize below.
  }

  const modeMatches = currentMode === 'manual';
  const sizeMatches = currentWidth === windowWidth && currentHeight === windowHeight;
  if (modeMatches && sizeMatches) return false;

  try {
    if (!modeMatches) {
      await execFileAsync(
        'tmux',
        ['set-window-option', '-t', target, 'window-size', 'manual'],
        { timeout: DEFAULT_TIMEOUT },
      );
    }
    if (!sizeMatches) {
      await execFileAsync(
        'tmux',
        ['resize-window', '-t', target, '-x', String(windowWidth), '-y', String(windowHeight)],
        { timeout: DEFAULT_TIMEOUT },
      );
    }
    return true;
  } catch (error: unknown) {
    logger.warn('session-geometry:reconcile-failed', {
      sessionName,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Options for capturing pane output
 */
export interface CapturePaneOptions {
  startLine?: number;  // -S オプション（デフォルト: -10000）
  endLine?: number;    // -E オプション（デフォルト: -）
}

/**
 * Check if tmux is installed and available
 */
export async function isTmuxAvailable(): Promise<boolean> {
  try {
    await execFileAsync('tmux', ['-V'], { timeout: DEFAULT_TIMEOUT });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a tmux session exists
 *
 * @param sessionName - Name of the tmux session
 * @returns True if session exists, false otherwise
 *
 * @example
 * ```typescript
 * const exists = await hasSession('my-session');
 * if (exists) {
 *   console.log('Session is running');
 * }
 * ```
 */
export async function hasSession(sessionName: string): Promise<boolean> {
  try {
    await execFileAsync('tmux', ['has-session', '-t', exactTarget(sessionName)], { timeout: DEFAULT_TIMEOUT });
    return true;
  } catch {
    // tmux has-session returns non-zero exit code if session doesn't exist
    return false;
  }
}

/**
 * List all tmux sessions
 *
 * @returns Array of tmux session information
 *
 * @example
 * ```typescript
 * const sessions = await listSessions();
 * sessions.forEach(s => console.log(`${s.name}: ${s.windows} windows`));
 * ```
 */
export async function listSessions(): Promise<TmuxSession[]> {
  try {
    const { stdout } = await execFileAsync(
      'tmux',
      ['list-sessions', '-F', '#{session_name}|#{session_windows}|#{session_attached}'],
      { timeout: DEFAULT_TIMEOUT }
    );

    if (!stdout || stdout.trim() === '') {
      return [];
    }

    return stdout
      .trim()
      .split('\n')
      .map(line => {
        const [name, windows, attached] = line.split('|');
        return {
          name,
          windows: parseInt(windows, 10) || 0,
          attached: attached === '1',
        };
      });
  } catch {
    // No sessions exist or tmux not running
    return [];
  }
}

/**
 * Create a new tmux session (legacy signature)
 */
export async function createSession(
  sessionName: string,
  cwd: string
): Promise<void>;

/**
 * Create a new tmux session with options
 */
export async function createSession(
  options: CreateSessionOptions
): Promise<void>;

/**
 * Create a new tmux session
 *
 * @param sessionNameOrOptions - Session name or options object
 * @param cwd - Working directory (when using legacy signature)
 *
 * @throws {Error} If session creation fails
 *
 * @example
 * ```typescript
 * // Legacy usage
 * await createSession('my-session', '/path/to/project');
 *
 * // New usage with options
 * await createSession({
 *   sessionName: 'my-session',
 *   workingDirectory: '/path/to/project',
 *   historyLimit: 50000,
 * });
 * ```
 */
export async function createSession(
  sessionNameOrOptions: string | CreateSessionOptions,
  cwd?: string
): Promise<void> {
  let sessionName: string;
  let workingDirectory: string;
  let historyLimit: number;
  let windowWidth: number;
  let windowHeight: number;

  if (typeof sessionNameOrOptions === 'string') {
    // Legacy signature
    sessionName = sessionNameOrOptions;
    workingDirectory = cwd!;
    historyLimit = 50000;
    windowWidth = TUI_PANE_WIDTH;
    windowHeight = TUI_PANE_HEIGHT;
  } else {
    // New signature with options
    sessionName = sessionNameOrOptions.sessionName;
    workingDirectory = sessionNameOrOptions.workingDirectory;
    historyLimit = sessionNameOrOptions.historyLimit || 50000;
    windowWidth = sessionNameOrOptions.windowWidth || TUI_PANE_WIDTH;
    windowHeight = sessionNameOrOptions.windowHeight || TUI_PANE_HEIGHT;
  }

  try {
    // Create session with explicit window size to avoid 80x24 default
    // This is critical for TUI tools (Copilot, OpenCode) that use alternate screen
    await execFileAsync(
      'tmux',
      ['new-session', '-d', '-s', sessionName, '-c', workingDirectory, '-x', String(windowWidth), '-y', String(windowHeight)],
      { timeout: DEFAULT_TIMEOUT }
    );

    // Issue #1163: Pin the pane to a fixed height so alternate-screen TUIs
    // (Claude/Codex/etc.) keep enough visible rows for capture-pane.
    //
    // The `-x`/`-y` passed to `new-session` do NOT survive on their own: the
    // server-global `window-size latest` immediately resizes a detached window
    // to the most recently active client, so a small terminal that later attaches
    // (or is already attached) shrinks the pane — and the capturable row count
    // shrinks with it. Setting `window-size manual` PER SESSION disables that
    // tracking (the global option is never touched), and an explicit
    // `resize-window` then locks in the intended geometry. Best-effort: a failure
    // here must not abort session creation (some environments restrict resize).
    await reconcileSessionGeometry(sessionName, { windowWidth, windowHeight });

    // Set history limit
    await execFileAsync(
      'tmux',
      ['set-option', '-t', exactTarget(sessionName), 'history-limit', String(historyLimit)],
      { timeout: DEFAULT_TIMEOUT }
    );
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to create tmux session: ${errorMessage}`);
  }
}

/**
 * Send keys to a tmux session
 *
 * @param sessionName - Target session name
 * @param keys - Keys to send (command text)
 * @param sendEnter - Whether to send Enter key after the command (default: true)
 *
 * @throws {Error} If session doesn't exist or command fails
 *
 * @example
 * ```typescript
 * await sendKeys('my-session', 'echo hello');
 * await sendKeys('my-session', 'ls -la', true);
 * await sendKeys('my-session', 'incomplete command', false);
 * ```
 */
export async function sendKeys(
  sessionName: string,
  keys: string,
  sendEnter: boolean = true
): Promise<void> {
  // execFile() passes arguments directly without shell interpretation,
  // so no shell-level escaping is needed
  const args = sendEnter
    ? ['send-keys', '-t', exactTarget(sessionName), keys, 'C-m']
    : ['send-keys', '-t', exactTarget(sessionName), keys];

  try {
    await execFileAsync('tmux', args, { timeout: DEFAULT_TIMEOUT });
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to send keys to tmux session: ${errorMessage}`);
  }
}

/**
 * Allowed tmux special key names for sendSpecialKeys() (multi-key TUI navigation).
 * Used for cursor-based navigation sequences (e.g., ['Down', 'Down', 'Enter']).
 * Restricts input to prevent command injection via arbitrary tmux key names.
 *
 * Separate from ALLOWED_SINGLE_SPECIAL_KEYS which covers control keys for sendSpecialKey().
 */
const ALLOWED_SPECIAL_KEYS = new Set([
  'Up', 'Down', 'Left', 'Right',
  'Enter', 'Space', 'Tab', 'Escape',
  'BSpace', 'DC',  // Backspace, Delete
  // Issue #1017: Codex pager / edit-previous mode navigation. PageUp/PageDown/Home/End
  // are tmux named keys; 'q' is the pager's literal "quit" character (sent verbatim by
  // `tmux send-keys`, no injection risk — single fixed char via execFile, not a shell).
  'PageUp', 'PageDown', 'Home', 'End', 'q',
]);

/** Delay between individual key presses for TUI apps that need processing time (ms). */
const SPECIAL_KEY_DELAY_MS = 100;

/**
 * Send tmux special keys (unquoted key names like Down, Up, Enter, Space).
 * Used for cursor-based navigation in CLI tool prompts (e.g., Claude Code AskUserQuestion).
 *
 * Keys are sent one at a time with a short delay between each press,
 * because ink-based TUI apps (like Claude Code) need time to process
 * each keystroke before the next one arrives.
 *
 * @param sessionName - Target session name
 * @param keys - Array of tmux special key names (e.g., ['Down', 'Down', 'Space', 'Enter'])
 * @throws {Error} If any key name is not in the allowed set, or if tmux command fails
 */
export async function sendSpecialKeys(
  sessionName: string,
  keys: string[]
): Promise<void> {
  if (keys.length === 0) return;

  // Validate all keys are in the allowed set (command injection prevention)
  for (const key of keys) {
    if (!ALLOWED_SPECIAL_KEYS.has(key)) {
      throw new Error(`Invalid special key: ${key}`);
    }
  }

  try {
    for (let i = 0; i < keys.length; i++) {
      await execFileAsync('tmux', ['send-keys', '-t', exactTarget(sessionName), keys[i]], { timeout: DEFAULT_TIMEOUT });
      // Delay between key presses (skip after the last key)
      if (i < keys.length - 1) {
        await new Promise(resolve => setTimeout(resolve, SPECIAL_KEY_DELAY_MS));
      }
    }
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to send special keys to tmux session: ${errorMessage}`);
  }
}

/**
 * Capture pane output from a tmux session (legacy signature)
 */
export async function capturePane(
  sessionName: string,
  lines?: number
): Promise<string>;

/**
 * Capture pane output from a tmux session with options
 */
export async function capturePane(
  sessionName: string,
  options?: CapturePaneOptions
): Promise<string>;

/**
 * Capture pane output from a tmux session
 *
 * @param sessionName - Target session name
 * @param linesOrOptions - Number of lines or options object
 * @returns Captured output as string
 *
 * @example
 * ```typescript
 * // Legacy usage
 * const output = await capturePane('my-session');
 * const recent = await capturePane('my-session', 100);
 *
 * // New usage with options
 * const full = await capturePane('my-session', {
 *   startLine: -10000,
 *   endLine: -1,
 * });
 * ```
 */
export async function capturePane(
  sessionName: string,
  linesOrOptions?: number | CapturePaneOptions
): Promise<string> {
  let startLine: number;
  let endLine: number | string;

  if (typeof linesOrOptions === 'number') {
    // Legacy signature
    startLine = -linesOrOptions;
    endLine = '-';
  } else if (linesOrOptions) {
    // New signature with options
    startLine = linesOrOptions.startLine ?? -10000;
    endLine = linesOrOptions.endLine ?? '-';
  } else {
    // Default
    startLine = -1000;
    endLine = '-';
  }

  try {
    const { stdout } = await execFileAsync(
      'tmux',
      ['capture-pane', '-t', exactTarget(sessionName), '-p', '-e', '-S', String(startLine), '-E', String(endLine)],
      {
        timeout: DEFAULT_TIMEOUT,
        maxBuffer: 10 * 1024 * 1024  // 10MB buffer for large Claude outputs
      }
    );
    return stdout;
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to capture pane: ${errorMessage}`);
  }
}

/**
 * Kill a tmux session
 *
 * @param sessionName - Session name to kill
 * @returns True if session was killed, false if session didn't exist
 *
 * @example
 * ```typescript
 * const killed = await killSession('my-session');
 * if (killed) {
 *   console.log('Session terminated');
 * }
 * ```
 */
export async function killSession(sessionName: string): Promise<boolean> {
  try {
    await execFileAsync('tmux', ['kill-session', '-t', exactTarget(sessionName)], {
      timeout: DEFAULT_TIMEOUT,
    });
    return true;
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    // Session doesn't exist or already killed
    if (
      errorMessage?.includes('no server running') ||
      errorMessage?.includes("can't find session")
    ) {
      return false;
    }
    // Re-throw unexpected errors
    throw new Error(`Failed to kill tmux session: ${errorMessage}`);
  }
}

/**
 * Ensure a tmux session exists, creating it if necessary
 *
 * @param sessionName - Session name
 * @param cwd - Working directory for the session
 *
 * @example
 * ```typescript
 * // Will create session if it doesn't exist
 * await ensureSession('my-session', '/path/to/project');
 *
 * // Safe to call multiple times
 * await ensureSession('my-session', '/path/to/project');
 * ```
 */
export async function ensureSession(
  sessionName: string,
  cwd: string
): Promise<void> {
  const exists = await hasSession(sessionName);

  if (!exists) {
    await createSession(sessionName, cwd);
  }
}

/**
 * Allowed values for sendSpecialKey() (single control key).
 * Used for individual control keys (Escape, Ctrl combinations, Enter).
 * Separate from ALLOWED_SPECIAL_KEYS which covers TUI navigation keys for sendSpecialKeys().
 *
 * SpecialKey type is derived from this array to ensure compile-time and runtime sync.
 */
export const SPECIAL_KEY_VALUES = ['Escape', 'C-c', 'C-d', 'C-m', 'Enter'] as const;

/**
 * Special key type for tmux send-keys.
 * Derived from SPECIAL_KEY_VALUES for type safety and runtime sync.
 * Note: C-m is equivalent to Enter in tmux.
 */
export type SpecialKey = typeof SPECIAL_KEY_VALUES[number];

/**
 * Runtime whitelist for sendSpecialKey() (defense-in-depth).
 * Derived from SPECIAL_KEY_VALUES to stay in sync.
 * Prevents bypass via `as any` casts or JavaScript callers.
 */
const ALLOWED_SINGLE_SPECIAL_KEYS = new Set<string>(SPECIAL_KEY_VALUES);

/**
 * Send a special key to a tmux session
 *
 * @param sessionName - Target session name
 * @param key - Special key to send (Escape, C-c, C-d, C-m, Enter)
 *
 * @throws {Error} If key is not in the allowed set or tmux command fails
 *
 * @example
 * ```typescript
 * // Send Escape key to interrupt CLI processing
 * await sendSpecialKey('my-session', 'Escape');
 *
 * // Send Ctrl+C for SIGINT
 * await sendSpecialKey('my-session', 'C-c');
 * ```
 */
export async function sendSpecialKey(
  sessionName: string,
  key: SpecialKey
): Promise<void> {
  // Runtime validation (defense-in-depth against as-any casts)
  if (!ALLOWED_SINGLE_SPECIAL_KEYS.has(key)) {
    throw new Error(`Invalid special key: ${key}`);
  }

  try {
    await execFileAsync('tmux', ['send-keys', '-t', exactTarget(sessionName), key], { timeout: DEFAULT_TIMEOUT });
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to send special key: ${errorMessage}`);
  }
}

/**
 * Allowed navigation key names for special-keys API validation.
 * Used for TUI navigation sequences (e.g., Up/Down cursor, Enter/Escape selection).
 *
 * Separate from SPECIAL_KEY_VALUES (sendSpecialKey() control keys) and
 * ALLOWED_SPECIAL_KEYS (sendSpecialKeys() broader TUI key set).
 * This as const array is exported for route-level validation (immutable, DRY).
 *
 * [DR3-001] Named NAVIGATION_KEY_VALUES to avoid collision with existing SPECIAL_KEY_VALUES.
 * [DR2-004] Exported as as const array + type guard (not Set) for immutability guarantee.
 */
export const NAVIGATION_KEY_VALUES = [
  'Up', 'Down', 'Left', 'Right', 'Enter', 'Escape', 'Tab', 'BTab',
  // Issue #1017: Codex pager / edit-previous mode keys surfaced by NavigationButtons.
  // 'q' is the pager quit key (literal char). PageUp/PageDown/Home/End are tmux named keys.
  'PageUp', 'PageDown', 'Home', 'End', 'q',
] as const;

/**
 * Navigation key type derived from NAVIGATION_KEY_VALUES.
 */
export type NavigationKey = typeof NAVIGATION_KEY_VALUES[number];

/**
 * Type guard for navigation key validation (special-keys API).
 * Returns true if the key is in the NAVIGATION_KEY_VALUES set.
 * Named "SpecialKey" to align with the special-keys API route that calls it,
 * though it validates NavigationKey (a subset of all special keys).
 *
 * @param key - String to validate
 * @returns True if key is a valid NavigationKey
 */
export function isAllowedSpecialKey(key: string): key is NavigationKey {
  return (NAVIGATION_KEY_VALUES as readonly string[]).includes(key);
}

/**
 * Send special keys to a tmux session and invalidate the capture cache.
 * Wrapper combining sendSpecialKeys() + invalidateCache() for DRY (DR1-003).
 *
 * @param sessionName - Target tmux session name
 * @param keys - Array of tmux special key names
 */
export async function sendSpecialKeysAndInvalidate(
  sessionName: string,
  keys: string[]
): Promise<void> {
  await sendSpecialKeys(sessionName, keys);
  invalidateCache(sessionName);
}
