/**
 * The vocabulary an `ICLITool` uses to describe its own TUI (Issue #1933).
 *
 * 設計方針書 §4 D4 / §6.3 / §10.12 / §13.2. Three questions used to be answered
 * by tables keyed on `CLIToolType` scattered outside the tool classes — "where
 * is this tool's composer?", "how does it quit?", "how many rows must a status
 * capture ask for?" — and each table had to be found and edited by anybody
 * adding a tool. They are declarations now, and a tool answers its own.
 *
 * This module lives in `src/types/**` for the same reason `./terminal-keys`
 * does: `src/lib/tmux/**` and `src/lib/cli-tools/**` both need the vocabulary,
 * and putting it in either one would make the other import across a boundary
 * `.eslintrc.json`'s `no-restricted-imports` rule exists to keep closed. Values
 * and types only — nothing here touches a process.
 */

// ---------------------------------------------------------------------------
// Key sequences (受入条件 S9)
// ---------------------------------------------------------------------------

/**
 * The key names a {@link KeySequence} step may name.
 *
 * Deliberately the same five values as `SPECIAL_KEY_VALUES` in
 * `src/lib/tmux/tmux.ts` — `tests/unit/lib/key-sequence-1933.test.ts` pins the
 * two lists equal. The list is duplicated rather than imported because this
 * module must stay free of `src/lib/tmux/**` (see the module docblock); the
 * pin is what keeps the duplication from drifting.
 */
export const KEY_SEQUENCE_KEY_NAMES = ['Escape', 'C-c', 'C-d', 'C-m', 'Enter'] as const;

/** A tmux key name a {@link KeySequence} step may send. */
export type KeySequenceKeyName = typeof KEY_SEQUENCE_KEY_NAMES[number];

/**
 * One step of a keystroke sequence — a *key*, or *text*.
 *
 * ## Why this is a discriminated union and not a string
 *
 * `tmux send-keys` looks its argument up in the key table before it sends
 * anything, so the SAME string means two different things depending on a flag
 * nobody was passing. Measured on tmux 3.5a against a private socket, with a
 * pane running `cat` on a raw pty so the bytes are the bytes the TUI receives:
 *
 * ```
 * send-keys -t X    'Escape'   -> 1b                    (the ESC key)
 * send-keys -t X -l 'Escape'   -> 45 73 63 61 70 65     ("Escape")
 * send-keys -t X    'Enter'    -> 0d                    (CR)
 * send-keys -t X -l 'Enter'    -> 45 6e 74 65 72        ("Enter")
 * ```
 *
 * `grep -n "'-l'" src/lib/tmux/*.ts` returned **zero** hits before this Issue,
 * and `sendMessageWithSubmitVerification` types the user's message body with
 * `sendKeys(sessionName, message, false)`. So a message whose body was exactly
 * `Escape` interrupted the agent instead of being typed, `Enter` submitted an
 * empty composer, and `C-c` sent SIGINT — none of which produced an error, or
 * even a differing log line.
 *
 * The same probe found a second, worse shape. tmux parses its arguments with
 * getopt, and the body is positional:
 *
 * ```
 * send-keys -t X '-l'         -> rc 0, NOTHING sent   (parsed as the -l flag)
 * send-keys -t X '-N hello'   -> rc 1, "repeat count invalid"
 * send-keys -t X -l -- '-l'   -> 2d 6c                ("-l")
 * ```
 *
 * i.e. a body starting with `-` was silently swallowed and reported as a
 * successful send. Both halves are why a literal step must reach tmux as
 * `send-keys -l -- <text>` and a key step as `send-keys -- <name>`; see
 * `keySequenceArgs` in `src/lib/tmux/key-sequence.ts`, which is the only place
 * that mapping is written.
 *
 * `delayAfterMs` is optional and carries what a sequence's own measurements
 * say has to elapse before the next step (opencode's 100 ms between `/exit`
 * and its Enter, gemini's 300 ms after `C-c`). It is metadata about the step,
 * not a third member of the union: every step is still a key or a literal.
 */
export type KeySequence =
  | {
      readonly kind: 'key';
      readonly name: KeySequenceKeyName;
      /** ms to pause after this keystroke before the next step. */
      readonly delayAfterMs?: number;
    }
  | {
      readonly kind: 'literal';
      readonly text: string;
      /** ms to pause after this text before the next step. */
      readonly delayAfterMs?: number;
    };

/** Build a key step. */
export function keyStep(
  name: KeySequenceKeyName,
  delayAfterMs?: number
): Extract<KeySequence, { kind: 'key' }> {
  return delayAfterMs === undefined ? { kind: 'key', name } : { kind: 'key', name, delayAfterMs };
}

/** Build a literal-text step. Text is always sent verbatim, never as a key. */
export function literalStep(
  text: string,
  delayAfterMs?: number
): Extract<KeySequence, { kind: 'literal' }> {
  return delayAfterMs === undefined
    ? { kind: 'literal', text }
    : { kind: 'literal', text, delayAfterMs };
}

/** Whether a step sends text rather than a key. */
export function isLiteralStep(
  step: KeySequence
): step is Extract<KeySequence, { kind: 'literal' }> {
  return step.kind === 'literal';
}

/** Whether a step sends a named key rather than text. */
export function isKeyStep(step: KeySequence): step is Extract<KeySequence, { kind: 'key' }> {
  return step.kind === 'key';
}

/**
 * Whether `name` is a key name a {@link KeySequence} step may carry.
 *
 * Defense in depth against a JavaScript caller or an `as` cast: the executor
 * refuses anything else rather than handing an unvalidated string to tmux.
 */
export function isKeySequenceKeyName(name: string): name is KeySequenceKeyName {
  return (KEY_SEQUENCE_KEY_NAMES as readonly string[]).includes(name);
}

// ---------------------------------------------------------------------------
// Composer (§6.3)
// ---------------------------------------------------------------------------

/**
 * How a tool's input box is located on a captured frame.
 *
 *   `input-line-marker` - the composer is a row that starts with a prompt
 *      marker (`>` / `❯` / `›`, optionally behind vibe-local's `ctx:N%`).
 *      Every supported tool except opencode.
 *   `opencode-box` - a bordered box with a gutter and no marker anywhere, whose
 *      rows are found structurally (#1911's chrome walk) and whose emptiness is
 *      said by its own `Ask anything...` placeholder (#1883).
 *   `unreadable` - nobody has measured this tool's box. Every send is then
 *      classified `submitted` without evidence, which is what #1906 found
 *      opencode had been doing since #1471 — so this is a state to declare
 *      knowingly, never a default to fall into.
 */
export type ComposerReader = 'input-line-marker' | 'opencode-box' | 'unreadable';

/**
 * What the submit-verified sender needs to know about one tool's composer.
 *
 * Returned by `ICLITool.describeComposer()`; `sendMessageWithSubmitVerification`
 * takes one so the sender no longer keys three separate module-level tables on
 * `CLIToolType`.
 */
export interface ComposerSpec {
  /** How the composer is found on a frame. */
  readonly reader: ComposerReader;
  /**
   * Rows of pane to ask tmux for when reading the submit back.
   *
   * A tail window for the marker tools, whose composer is the last thing on the
   * pane. opencode needs the whole visible frame: it centres its box under the
   * banner until the first turn is answered, roughly 100 rows above the bottom
   * of a 200-row pane (measured live on opencode 1.18.21 in #1906).
   */
  readonly verifyCaptureLines: number;
  /**
   * Whether this layer may empty the composer before typing into it (#1880).
   *
   * True only for a tool whose input box has been captured at the production
   * geometry, placeholder and dialogs included. Blind `C-e`+`C-u` into a box
   * nobody has measured replaces a residual-text problem with a data-loss one.
   */
  readonly clearBeforeSend: boolean;
  /**
   * Enter presses for the INITIAL submit.
   *
   * 2 for vibe-local, whose IME mode makes the first Enter insert a newline.
   */
  readonly submitEnterCount: number;
}

// ---------------------------------------------------------------------------
// Capture (§10.12)
// ---------------------------------------------------------------------------

/**
 * What a status probe must ask tmux for, per tool.
 *
 * Returned by `ICLITool.captureSpec()`. Replaces the `if (cliToolId === …)`
 * ladder that `src/lib/session/worktree-status-helper.ts` carried, which is
 * outside `src/lib/cli-tools/**` and therefore had to import two tool modules
 * for their pane heights.
 */
export interface CaptureSpec {
  /**
   * Rows of pane the status DETECTION path captures.
   *
   * A tool that paints a fixed-height alternate screen asks for exactly its own
   * pane height, because that is all `capture-pane` can ever return for it.
   */
  readonly statusLines: number;
  /**
   * Whether the tool renders in the terminal's alternate screen (#1268).
   *
   * When true tmux keeps no scrollback, every capture returns exactly
   * `pane_height` rows, and a captured line COUNT is a screen-row count rather
   * than a monotonic cursor — so it must never be used to decide "have I
   * already read this?".
   */
  readonly usesAlternateScreen: boolean;
}

// ---------------------------------------------------------------------------
// Graceful exit (受入条件 S10)
// ---------------------------------------------------------------------------

/**
 * How a tool is asked to quit, and what must be true afterwards.
 *
 * Returned by `ICLITool.gracefulExitSequence()`.
 */
export interface GracefulExitSpec {
  /** The keystrokes that ask the TUI to quit, in order. */
  readonly keys: readonly KeySequence[];
  /**
   * ms to wait after the last keystroke before the postcondition is checked.
   *
   * Per tool because the shutdowns differ by an order of magnitude: copilot
   * 1.0.80 was measured between 1.006 s and 2.193 s (#1905), opencode 1.18.21
   * at ~0.45 s, and the Ctrl-D tools inside the generic 500 ms.
   */
  readonly exitWaitMs: number;
  /**
   * Whether this tool owns a loopback HTTP server whose port is handed back on
   * exit — opencode alone, whose TUI *is* an HTTP server once it is given
   * `--port` (#1758 §5.1.2).
   *
   * When true, "the pane is gone" is not the whole postcondition: the assigned
   * port must also stop answering `/global/health` before it may be handed to
   * the next instance. See {@link GracefulExitFailureReason}.
   */
  readonly ownsLoopbackServer: boolean;
}

/**
 * Why a graceful exit's postcondition was not met.
 *
 *   `graceful_exit_timeout` - the tmux session still existed after the tool's
 *      own exit window. The TUI did not quit; the pane must be force-killed.
 *   `port_orphaned` - the pane is gone but the port it was allocated is still
 *      answering `/global/health` as opencode. Handing that number to the next
 *      instance makes two owners of one port: the new instance's subscription
 *      attaches to the old server and files its events against the wrong
 *      worktree, silently. The number must not be reused until it goes quiet.
 */
export const GRACEFUL_EXIT_FAILURE_REASONS = ['graceful_exit_timeout', 'port_orphaned'] as const;

/** Reason token for a graceful exit that did not meet its postcondition. */
export type GracefulExitFailureReason = typeof GRACEFUL_EXIT_FAILURE_REASONS[number];

/**
 * The postcondition's verdict.
 *
 * `ok: false` always carries a reason, and the reason is always one a caller can
 * act on: both of them mean "force kill", and `port_orphaned` additionally means
 * "do not hand this port out yet".
 */
export type GracefulExitVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: GracefulExitFailureReason };
