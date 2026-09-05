/**
 * tmux session management
 * Provides functions to manage tmux sessions for Claude CLI integration
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { invalidateCache } from './tmux-capture-cache';
import { hasHumanClientAttached } from './geometry-delegation';
import { validateSessionName } from '@/lib/cli-tools/validation';
import { TMUX_HISTORY_LIMIT, TUI_PANE_HEIGHT, TUI_PANE_WIDTH } from '@/config/tmux-pane-config';
import { createLogger } from '@/lib/logger';
import { NAVIGATION_KEY_VALUES, type NavigationKey, type TerminalKey } from '@/types/terminal-keys';
import type { KeySequence } from '../../types/cli-tool-contracts';
import {
  keySequenceArgs,
  runKeySequence,
  type KeySequenceTransport,
} from './key-sequence';

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
  historyLimit?: number;  // scrollback バッファサイズ（デフォルト: TMUX_HISTORY_LIMIT）
  windowWidth?: number;   // ペイン幅（デフォルト: TUI_PANE_WIDTH）
  windowHeight?: number;  // ペイン高さ（デフォルト: TUI_PANE_HEIGHT、alternate screen TUIで十分な表示行数を確保。Issue #1163）
}

export interface SessionGeometryOptions {
  windowWidth?: number;
  windowHeight?: number;
  /**
   * Whether an attached human client vetoes the resize (Issue #2317, Phase D).
   *
   * Defaults to true, so every path that reconciles an EXISTING session — the
   * one a `--live` reader can be sitting in — stands down for them.
   * {@link createSession} passes false, and that is a fact rather than a
   * shortcut: the session is being created by this very call, so no client can
   * be attached to it yet and the probe could only ever answer "nobody".
   */
  respectAttachedClient?: boolean;
}

/**
 * Reconcile a session's window geometry without disrupting the running process.
 * Failures are intentionally non-fatal: geometry improves capture fidelity but
 * must never make an otherwise healthy CLI session unusable.
 *
 * ## It stands down while a human is attached (Issue #2317, Phase D)
 *
 * `commandmate attach --live` hands the window to the terminal looking at it so
 * the transcript is readable at all; every `send` to a running session reaches
 * here through `reconcileExistingSession()`, and snapping the canvas back to
 * 200x1000 mid-read would undo that under the reader's hands. So when the
 * geometry does NOT already match, this asks whether a NON-control-mode client
 * is attached and leaves the window alone if one is.
 *
 * Two properties of that ordering are load-bearing:
 *
 *  - the question is asked only on the path that would actually resize, so the
 *    overwhelmingly common "already correct" call still costs exactly the two
 *    tmux round-trips it always has;
 *  - it keys off a live client rather than off `@cm_delegated`, so a flag left
 *    behind by a CLI that was killed can never pin a window open forever — the
 *    next reconcile with nobody attached repairs it.
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

  // Issue #2317: a human is reading this pane at their terminal's size. See the
  // docblock — asked here, after the cheap match, so the ordinary call is
  // unchanged.
  if ((options.respectAttachedClient ?? true) && (await hasHumanClientAttached(sessionName))) {
    logger.info('session-geometry:delegated-to-client', { sessionName });
    return false;
  }

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
 * The directory a session was created in, or null (Issue #2070).
 *
 * `#{session_path}` rather than `#{pane_current_path}`: the two differ as soon
 * as anything types `cd`, and only the first one is still the worktree root the
 * session was opened on. Measured on tmux 3.5a — a session created with
 * `-c /private/tmp` whose shell then `cd /usr`'d reported
 * `session_path=/private/tmp`, `pane_current_path=/usr`.
 *
 * Read by `BaseCLITool.relaunchIfToolExited`, which needs the worktree path to
 * rebuild a launch line for a pane whose agent has died. The pane itself is the
 * right source for it: a worktree row could have been moved or deleted since,
 * while the directory the pane is actually sitting in is the directory the
 * relaunched agent will actually run in.
 *
 * @param sessionName - Target session name
 * @returns The session's working directory, or null when tmux cannot say
 */
export async function getSessionWorkingDirectory(sessionName: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'tmux',
      ['display-message', '-p', '-t', exactTarget(sessionName), '#{session_path}'],
      { timeout: DEFAULT_TIMEOUT }
    );
    const dir = stdout.trim();
    return dir === '' ? null : dir;
  } catch {
    return null;
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
 *   historyLimit: TMUX_HISTORY_LIMIT,
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
    historyLimit = TMUX_HISTORY_LIMIT;
    windowWidth = TUI_PANE_WIDTH;
    windowHeight = TUI_PANE_HEIGHT;
  } else {
    // New signature with options
    sessionName = sessionNameOrOptions.sessionName;
    workingDirectory = sessionNameOrOptions.workingDirectory;
    historyLimit = sessionNameOrOptions.historyLimit || TMUX_HISTORY_LIMIT;
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

    // Issue #1624: `history-limit` must be set BEFORE the pane that uses it exists.
    //
    // It is a session option, but a pane sizes its scrollback buffer ONCE, from
    // the value in effect at pane-creation time. `new-session` above already
    // created window 0 and its pane, so the old order (new-session → set-option)
    // left every pane on tmux's built-in 2000 lines while `show-options` happily
    // reported 50000 — the session option was set, and utterly inert. Measured on
    // tmux 3.5a: pane `#{history_limit}` stayed 2000, and a live
    // `mcbd-codex-*` session sat at 1977/2000 lines used, silently dropping the
    // oldest transcript. `respawn-pane -k` does NOT fix it either (the pane reuses
    // its existing buffer); only creating a NEW pane does.
    await execFileAsync(
      'tmux',
      ['set-option', '-t', exactTarget(sessionName), 'history-limit', String(historyLimit)],
      { timeout: DEFAULT_TIMEOUT }
    );

    // Rebuild window 0 IN PLACE so its pane is allocated against the option just
    // set. `-k` replaces the existing window at index 0 rather than appending,
    // which keeps `#{window_index}` at 0 and the session at exactly one window —
    // no call site has to care that the window was recreated.
    //
    // `-c` is REQUIRED and not redundant: a bare `new-window` does NOT inherit the
    // session's `-c` directory, it starts in the tmux CLIENT's cwd (verified: a
    // session created with `-c /usr/local` produced a pane in the server process's
    // cwd instead). Omitting it silently launches every agent in the wrong repo.
    //
    // Best-effort, matching the geometry step below: if this fails the session is
    // still usable, just with tmux's default 2000-line scrollback.
    try {
      await execFileAsync(
        'tmux',
        ['new-window', '-k', '-t', `${exactTarget(sessionName)}0`, '-c', workingDirectory],
        { timeout: DEFAULT_TIMEOUT }
      );
    } catch (error: unknown) {
      logger.warn('session-history-limit:window-rebuild-failed', {
        sessionName,
        historyLimit,
        error: error instanceof Error ? error.message : String(error),
      });
    }

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
    //
    // Issue #1624: this MUST stay AFTER the window rebuild above. A window created
    // by `new-window` does not inherit `window-size manual` from the window it
    // replaced (verified: `show-window-options -v window-size` came back empty),
    // so reconciling first would have the setting thrown away and leave the pane
    // tracking the latest client again.
    await reconcileSessionGeometry(sessionName, {
      windowWidth,
      windowHeight,
      // Nothing can be attached to a session this call is still creating, so the
      // Phase D client probe would be a round-trip with one possible answer.
      respectAttachedClient: false,
    });
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to create tmux session: ${errorMessage}`);
  }
}

/** Options for {@link sendKeys}. */
export interface SendKeysOptions {
  /**
   * Send `keys` as TEXT rather than letting tmux resolve it as a key name
   * (Issue #1933, 受入条件 S9).
   *
   * Required for anything a user typed. Without it `tmux send-keys` looks the
   * string up in the key table first, so a message body of exactly `Escape`
   * interrupts the agent (`1b`), `Enter` submits an empty composer (`0d`) and
   * `C-c` sends SIGINT — all measured on tmux 3.5a, see
   * `./key-sequence`. A body starting with `-` is worse still: getopt eats it
   * and `send-keys` returns 0 having sent nothing at all.
   *
   * Mutually exclusive with `sendEnter`: the literal argv carries no `C-m`,
   * because a `C-m` argument after `-l` would be typed as the three characters
   * `C`, `-`, `m`. Submit the message with a separate `sendSpecialKeys(…,
   * ['Enter'])`, which is what every caller in this repository already does —
   * body and Enter have been separate tmux commands since #1469.
   */
  literal?: boolean;
}

/**
 * Send keys to a tmux session
 *
 * @param sessionName - Target session name
 * @param keys - Keys to send (command text)
 * @param sendEnter - Whether to send Enter key after the command (default: true)
 * @param options - {@link SendKeysOptions}; pass `{ literal: true }` for text
 *
 * @throws {Error} If session doesn't exist, command fails, or `literal` is
 *   combined with `sendEnter`
 *
 * @example
 * ```typescript
 * await sendKeys('my-session', 'echo hello');
 * await sendKeys('my-session', 'ls -la', true);
 * await sendKeys('my-session', 'incomplete command', false);
 * // A message body the user typed — never resolved as a key name:
 * await sendKeys('my-session', userMessage, false, { literal: true });
 * ```
 */
export async function sendKeys(
  sessionName: string,
  keys: string,
  sendEnter: boolean = true,
  options?: SendKeysOptions
): Promise<void> {
  if (options?.literal && sendEnter) {
    throw new Error(
      'sendKeys: { literal: true } cannot be combined with sendEnter — a trailing C-m would be typed as text. Send Enter as a separate key.'
    );
  }

  // execFile() passes arguments directly without shell interpretation,
  // so no shell-level escaping is needed
  const args = options?.literal
    ? keySequenceArgs(exactTarget(sessionName), { kind: 'literal', text: keys })
    : sendEnter
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
 * Send a whole {@link KeySequence} to a session (Issue #1933).
 *
 * The executor half of `./key-sequence`, bound to this module's `execFile`
 * transport. Literal steps go out through `send-keys -l --`, key steps through
 * `send-keys --` after their name is re-validated, and each step is its own
 * tmux invocation so a TUI cannot read the whole sequence as one paste.
 *
 * ## Status: the runner for `GracefulExitSpec.keys`, not yet its caller
 *
 * `ICLITool.gracefulExitSequence()` returns a `KeySequence[]`, so something has
 * to be able to run one; this is that something, and
 * `tests/unit/lib/key-sequence-1933.test.ts` drives it against a stubbed
 * `execFile`. The seven `killSession()` implementations do **not** call it yet,
 * and that is a deliberate scope line rather than an oversight: rerouting them
 * changes the argv of calls that `tests/unit/api/kill-session-cli-tool-gateway-1905.test.ts`
 * pins by exact arity, a file Issue #1933 may not edit — and it would buy no
 * behaviour, because the exit strings (`/exit`, `/quit`) are tool-owned
 * constants rather than tmux key names, so `-l` changes not one byte for them.
 * The user-typed message body, which `-l` changes a great deal for, goes through
 * {@link sendKeys}' `literal` option in the same commit. The Issue that is
 * allowed to touch that gateway test owns the rest of the move;
 * `tests/unit/cli-tools/graceful-exit-conformance-1933.test.ts` holds the
 * declarations equal to the implementations until then.
 *
 * @param sessionName - Target session name
 * @param steps - The sequence, in order
 * @throws {Error} If a key name is not allowed, or a tmux command fails
 */
export async function sendKeySequence(
  sessionName: string,
  steps: readonly KeySequence[]
): Promise<void> {
  const transport: KeySequenceTransport = {
    async run(args: string[]): Promise<void> {
      await execFileAsync('tmux', args, { timeout: DEFAULT_TIMEOUT });
    },
  };

  try {
    await runKeySequence(exactTarget(sessionName), steps, transport);
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to send key sequence to tmux session: ${errorMessage}`);
  }
}

/**
 * Allowed tmux special key names for sendSpecialKeys() (multi-key TUI navigation).
 * Used for cursor-based navigation sequences (e.g., ['Down', 'Down', 'Enter']).
 * Restricts input to prevent command injection via arbitrary tmux key names.
 *
 * Separate from ALLOWED_SINGLE_SPECIAL_KEYS which covers control keys for sendSpecialKey().
 *
 * INVARIANT (Issue #2032): `NAVIGATION_KEY_VALUES` ⊆ this set. The special-keys API
 * publishes `NAVIGATION_KEY_VALUES` as its accepted vocabulary, and every key it
 * accepts must be deliverable here — otherwise the route validates a request and
 * then throws while sending it. The relation is one-way containment, NOT equality:
 * `Space` / `BSpace` / `DC` are sendable but deliberately absent from the navigation
 * vocabulary, so asserting set equality would be wrong.
 * Pinned by tests/unit/tmux/special-keys-allowlist-2032.test.ts.
 */
const ALLOWED_SPECIAL_KEYS = new Set([
  'Up', 'Down', 'Left', 'Right',
  'Enter', 'Space', 'Tab', 'Escape',
  // Issue #2032: BTab (back-tab / Shift-Tab) has been part of the special-keys API
  // vocabulary since Issue #473 but was never added here, so `POST
  // /api/worktrees/[id]/special-keys` with `["BTab"]` passed validation and then
  // threw `Invalid special key: BTab` inside sendSpecialKeys() → HTTP 500.
  'BTab',
  'BSpace', 'DC',  // Backspace, Delete
  // Issue #1017: Codex pager / edit-previous mode navigation. PageUp/PageDown/Home/End
  // are tmux named keys; 'q' is the pager's literal "quit" character (sent verbatim by
  // `tmux send-keys`, no injection risk — single fixed char via execFile, not a shell).
  'PageUp', 'PageDown', 'Home', 'End', 'q',
  // Issue #2254: the answer characters `1`-`9` / `y` / `n`, so a dialog nobody
  // could parse can be answered from the chat surface's dialog card instead of
  // only from the terminal. Literal characters on the wire like `q` above.
  // `n` was already deliverable as an opencode chord letter and is not repeated.
  '1', '2', '3', '4', '5', '6', '7', '8', '9', 'y',
  // Issue #2297: claude's "use this session only" key. Its `/model` footer reads
  // `Enter to set as default · s to use this session only · Esc to cancel`, and
  // `Enter` there rewrites `model` in ~/.claude/settings.json (#1495) — so
  // without this the chat surface could deliver the destructive half of that
  // footer and not the safe half. A literal character like `q` / `y` above.
  // Deliverable here for every session; only claude and Command Code DECLARE it
  // (`CLAUDE_NAVIGATION_KEY_VALUES`), so the route answers 400 for anyone else —
  // which matters, because `s` is `sort:relevance` on copilot's session picker.
  's',
  // Issue #2046: opencode's own chords. `C-x` is its leader prefix (measured
  // default of 1.18.22, 2000 ms window), `C-p` opens the command palette and
  // `C-t` cycles the model variant. The lower-case letters complete a leader
  // chord and are LITERAL characters on the wire, exactly like `q` above —
  // `tmux send-keys -- a` types an `a`.
  //
  // Widening the transport does NOT widen what any pane can be sent: since
  // #2046 the special-keys route validates each key against the requested
  // tool's own `navigationKeys()` declaration, so `a` is deliverable here but
  // only opencode declares it. Every other caller of `sendSpecialKeys()`
  // (`prompt-answer-sender`, the submit-verified sender, the tool classes)
  // passes fixed key names it wrote itself, so nothing here becomes reachable
  // from user-controlled text.
  'C-x', 'C-p', 'C-t',
  'a', 'l', 'n', 't', 'm', 'g', 'u', 'r', 'c',
]);

/**
 * Type guard for "sendSpecialKeys() will actually deliver this key" (Issue #2032).
 *
 * Exported so callers can pre-flight a key against the transport's allow-list
 * instead of discovering the rejection as a thrown error mid-send, and so the
 * `NAVIGATION_KEY_VALUES` ⊆ `ALLOWED_SPECIAL_KEYS` invariant is observable from a
 * test without exposing the mutable Set itself.
 *
 * @param key - String to validate
 * @returns True if sendSpecialKeys() accepts the key
 */
export function isSendableSpecialKey(key: string): boolean {
  return ALLOWED_SPECIAL_KEYS.has(key);
}

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
 * Rename a running tmux session, keeping its processes and scrollback intact.
 *
 * This is what lets a worktree ID move without killing the agent underneath it.
 * Session names are a *derived* value (`mcbd-{cli}-{worktreeId}[-{suffix}]`), so
 * the moment the ID behind a directory changes, every session named after the
 * old ID becomes unreachable through the app while the process keeps running —
 * the UI shows nothing and a second agent can be started on the same directory
 * (Issue #1621 (a)). Renaming re-attaches the name to the process instead.
 *
 * Measured on a throwaway session (Issue #1621): the pane PID is unchanged
 * across the rename, scrollback survives, an attached client follows the
 * session, and the old name stops resolving immediately.
 *
 * Both names are validated: `oldName` because it is interpolated into a tmux
 * target, `newName` because tmux would otherwise happily create a session whose
 * name contains `:` or `.` — characters tmux itself uses as target separators,
 * which would make the session permanently unaddressable.
 *
 * The `-t` target goes through {@link exactTarget} like every other target in
 * this module: `mcbd-claude-<wt>` is a prefix of `mcbd-claude-<wt>-2`, and a
 * fuzzy match here would rename the wrong instance's session (Issue #1156).
 *
 * @param oldName - Current session name (exact)
 * @param newName - New session name
 * @returns true when the session was renamed; false when `oldName` does not
 *          exist (or tmux is not running), which is not an error for a
 *          reconciliation pass over sessions that may or may not be up
 * @throws Error when the rename fails for any other reason — notably when
 *         `newName` is already taken, which the caller must not silently ignore
 */
export async function renameSession(oldName: string, newName: string): Promise<boolean> {
  validateSessionName(oldName);
  validateSessionName(newName);

  if (oldName === newName) return false;

  try {
    await execFileAsync('tmux', ['rename-session', '-t', exactTarget(oldName), newName], {
      timeout: DEFAULT_TIMEOUT,
    });
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (
      errorMessage?.includes('no server running') ||
      errorMessage?.includes("can't find session")
    ) {
      return false;
    }
    throw new Error(`Failed to rename tmux session: ${errorMessage}`);
  }

  // Capture output is cached per session NAME (TTL 5s). Both keys are now lies:
  // the old one names a session that no longer exists, and the new one may hold
  // a stale entry from a session that used to have this name. Dropping them is
  // enough — the next capture repopulates (Issue #1621 says the capture cache
  // may simply be discarded).
  invalidateCache(oldName);
  invalidateCache(newName);

  logger.info('session:renamed', { oldName, newName });
  return true;
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
 * Clear whatever text is currently sitting on the TUI input line (Issue #1501).
 *
 * Sends a single `C-u` (kill-line-before-cursor) so the prompt is wiped. Used by
 * the submit-verified sender when it detects that a TUI popup autocompleted the
 * typed command into a DIFFERENT one (e.g. `/status` -> `/statusline`): the
 * residual text must be removed so it can neither be executed by a stray Enter
 * nor detonate on the next send.
 *
 * `C-u` is a fixed literal passed via execFile (no shell, no injection) and is
 * intentionally NOT added to ALLOWED_SPECIAL_KEYS / NAVIGATION_KEY_VALUES — it is
 * an internal recovery primitive, never exposed through the special-keys API.
 *
 * @param sessionName - Target session name
 * @throws {Error} If the tmux command fails
 */
export async function clearInputLine(sessionName: string): Promise<void> {
  try {
    await execFileAsync('tmux', ['send-keys', '-t', exactTarget(sessionName), 'C-u'], { timeout: DEFAULT_TIMEOUT });
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to clear tmux input line: ${errorMessage}`);
  }
}

/**
 * Send one `C-e` + `C-u` pass over the TUI input line (Issue #1879).
 *
 * `C-u` alone is kill-line-*before-cursor*, so it deletes nothing at all when the
 * cursor sits at column 0 — the state a human leaves behind after pressing Home
 * and walking away, measured live in #1878 §5-1. Moving to end-of-line first is
 * what makes the kill unconditional. Both keys go in one `send-keys` so they
 * cannot be interleaved with anything else the session receives.
 *
 * One pass clears one row. A multi-row composer needs several (also measured in
 * #1878 §5-1: up to `2N-1` for N rows), which is why callers drive this from
 * {@link module:lib/session/composer-clear}'s read-back loop rather than firing
 * it once and declaring victory.
 *
 * Like {@link clearInputLine}, the keys are fixed literals passed through
 * execFile (no shell, no injection) and are deliberately NOT added to
 * `ALLOWED_SPECIAL_KEYS` / `NAVIGATION_KEY_VALUES`: the special-keys API stays a
 * navigation surface, and clearing the composer is its own endpoint with its own
 * verification.
 *
 * @param sessionName - Target session name
 * @throws {Error} If the tmux command fails
 */
export async function clearComposerLine(sessionName: string): Promise<void> {
  try {
    await execFileAsync(
      'tmux',
      ['send-keys', '-t', exactTarget(sessionName), 'C-e', 'C-u'],
      { timeout: DEFAULT_TIMEOUT },
    );
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to clear tmux composer line: ${errorMessage}`);
  }
}

/**
 * Allowed navigation key names for special-keys API validation.
 * Used for TUI navigation sequences (e.g., Up/Down cursor, Enter/Escape selection).
 *
 * Declared in `@/types/terminal-keys` and re-exported here so server-side callers
 * keep their existing import path. The declaration moved out of this module in
 * Issue #1922: the two client components that type their key props with
 * `NavigationKey` must not import from `src/lib/tmux/**` (§4 D4).
 *
 * Separate from SPECIAL_KEY_VALUES (sendSpecialKey() control keys) and
 * ALLOWED_SPECIAL_KEYS (sendSpecialKeys() broader TUI key set).
 */
export { NAVIGATION_KEY_VALUES };
export type { NavigationKey };

/**
 * Type guard for navigation key validation (special-keys API).
 * Returns true if the key is in the NAVIGATION_KEY_VALUES set AND sendSpecialKeys()
 * can actually deliver it.
 * Named "SpecialKey" to align with the special-keys API route that calls it,
 * though it validates NavigationKey (a subset of all special keys).
 *
 * Issue #2046 — `vocabulary` is the *declaring tool's* key list
 * (`ICLITool.navigationKeys().keys`), which the route passes in. It defaults to
 * `NAVIGATION_KEY_VALUES` so a caller that has no tool in hand keeps the exact
 * pre-#2046 behaviour, and so the #2032 pin below still reads as it was written.
 * The transport half (`isSendableSpecialKey`) is unconditional either way: the
 * invariant is "everything a tool declares is deliverable", quantified over the
 * registry instead of over one global list.
 *
 * Issue #2032 — why the transport check lives in the *input validation* guard, i.e.
 * why a vocabulary/transport divergence answers 400 and not 500:
 *
 * - The caller-visible contract of the endpoint is "the keys I may send". A key the
 *   transport refuses is, from the caller's side, a key that cannot be sent — the
 *   only actionable response is "send a different key", which is exactly what 4xx
 *   means. 500 tells the caller "retry later, the server broke", and retrying a
 *   `BTab` that will never be deliverable is not actionable.
 * - Letting it reach sendSpecialKeys() converts the same condition into a thrown
 *   error that the route can only report as an opaque 500, i.e. the divergence is
 *   laundered into "server fault" and shows up in error dashboards as an outage.
 * - The divergence really *is* a server-side configuration bug, but it is one the
 *   build must catch, not production: the `NAVIGATION_KEY_VALUES` ⊆
 *   `ALLOWED_SPECIAL_KEYS` invariant is pinned by
 *   tests/unit/tmux/special-keys-allowlist-2032.test.ts, so this branch is a
 *   defense-in-depth backstop that cannot fire in a green build.
 *
 * @param key - String to validate
 * @param vocabulary - The declaring tool's key list (defaults to `NAVIGATION_KEY_VALUES`)
 * @returns True if key is in `vocabulary` AND sendSpecialKeys() can deliver it
 */
export function isAllowedSpecialKey(
  key: string,
  vocabulary: readonly string[] = NAVIGATION_KEY_VALUES
): key is TerminalKey {
  return vocabulary.includes(key) && isSendableSpecialKey(key);
}

/**
 * How long after a key lands the TUI is still allowed to be repainting
 * (Issue #2297).
 *
 * `invalidateCache()` fires the instant `tmux send-keys` returns, which is
 * BEFORE the CLI has drawn the consequence of the key. The next capture — the
 * chat surface's own `onKeysSent` refresh, or any of the pollers that share this
 * cache (the sidebar status probe, the global session poller) — therefore has a
 * good chance of storing the PRE-repaint frame, and {@link CACHE_TTL_MS} then
 * serves that stale frame for five seconds. That is the "the highlight does not
 * move" report in Issue #2297: the send worked, the cache was invalidated, and
 * the surface still drew the old dialog.
 *
 * 250 ms is comfortably past an ink/bubbletea repaint (`SPECIAL_KEY_DELAY_MS`,
 * the gap this transport already leaves BETWEEN keys of one chord, is 100 ms)
 * and comfortably inside the 1-second budget the Issue sets for seeing the
 * highlight move.
 */
export const REPAINT_INVALIDATE_DELAY_MS = 250;

/**
 * Drop the cached frame again once the TUI has had time to repaint.
 *
 * Fire-and-forget on purpose: the route must not wait 250 ms to answer, and the
 * work is one `Map.delete`. The timer is `unref()`ed where the runtime supports
 * it so a pending invalidation can never hold a process (or a test runner) open.
 */
function scheduleRepaintInvalidation(sessionName: string): void {
  const timer = setTimeout(() => invalidateCache(sessionName), REPAINT_INVALIDATE_DELAY_MS);
  (timer as unknown as { unref?: () => void }).unref?.();
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
  scheduleRepaintInvalidation(sessionName);
}
