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

import type { TerminalKey } from './terminal-keys';

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
// Navigation keys (Issue #2046)
// ---------------------------------------------------------------------------

/**
 * The keys one tool's UI may ask the special-keys API to deliver.
 *
 * Returned by `ICLITool.navigationKeys()`. Before Issue #2046 this was a single
 * module-level list (`NAVIGATION_KEY_VALUES`) that `POST
 * /api/worktrees/[id]/special-keys` validated EVERY request against, regardless
 * of which tool the request named. That worked only while every tool wanted the
 * same twelve keys. opencode does not: its TUI is driven by a `ctrl+x` leader
 * plus a bare letter, and a bare letter is a character — `a` sent to claude's
 * pane is an `a` typed into claude's composer, not a command.
 *
 * So the vocabulary moved into the tool, and the route now asks the tool it was
 * given. 設計方針書 §6 ("tool-specific behaviour belongs in the tool class") is
 * the same reason `describeComposer()` / `captureSpec()` / `gracefulExitSequence()`
 * exist.
 *
 * ## The invariant this must not break (Issue #2032)
 *
 * Every key a tool declares must be one `sendSpecialKeys()` will actually hand
 * to tmux. When the vocabulary was global that was stated as
 * `NAVIGATION_KEY_VALUES` ⊆ `ALLOWED_SPECIAL_KEYS`; per tool it is the same
 * statement quantified over the registry, and it is checked the same way —
 * `isSendableSpecialKey()`. Breaking it restores exactly the #2032 failure: the
 * route validates a request, answers nothing, and then throws inside the
 * transport and reports 500.
 */
export interface NavigationKeySpec {
  /**
   * Every key name this tool's UI may send, including the leader prefix and any
   * literal characters that complete a chord.
   */
  readonly keys: readonly TerminalKey[];
  /**
   * The prefix key of this tool's two-step chord, or `null` when it has none.
   *
   * opencode alone today (`C-x`, measured default of 1.18.22). The UI reads this
   * instead of writing `C-x` next to every chord, so a tool whose leader differs
   * — or a future opencode that renames it — changes one declaration.
   *
   * A chord is delivered as TWO array entries in one special-keys request
   * (`['C-x', 'b']`), which `sendSpecialKeys()` sends one at a time with
   * `SPECIAL_KEY_DELAY_MS` between them. That is the same sequential-step
   * discipline `runKeySequence` applies to `KeySequence`, minus the literal/key
   * distinction the special-keys transport does not have.
   */
  readonly leaderKey: TerminalKey | null;
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

// ---------------------------------------------------------------------------
// Liveness — "did the tool itself exit and leave a bare shell?" (Issue #2070)
// ---------------------------------------------------------------------------

/**
 * How one tool's pane is read for the question "is the TOOL still there?".
 *
 * ## Why this is a declaration and not one function per tool
 *
 * A tmux session outliving the process it was created for is not an exotic
 * state: codex's own "1. Update now" replaces itself with `npm install` and
 * exits, `Ctrl+C` twice quits it, and a crash does the same thing more
 * abruptly. In every case the pane falls back to the login shell and
 * `has-session` keeps answering yes — so `isRunning` stays true, the sidebar
 * keeps a green dot, and the next `send` times out in `waitForPrompt` with no
 * recovery but a manual `kill-session`.
 *
 * CommandMate has always had a check for this, and it was **claude's alone** —
 * `isSessionHealthy`, reached from exactly one `cliToolId === 'claude'` branch
 * in `worktree-status-helper`. The rule inside it is not claude-specific,
 * though; what is claude-specific are the two patterns it is written in terms
 * of. So the rule became shared code and the patterns became this declaration,
 * one per tool, which is the same §4 D4 shape {@link ComposerSpec} /
 * {@link CaptureSpec} / {@link GracefulExitSpec} already take.
 *
 * ## The rule the fields spell out
 *
 * "The tool exited" is the conjunction of a negative and a positive:
 *
 *   1. **none of {@link alivePatterns} matches** the bottom of the frame — the
 *      tool's own composer, dialog chrome or working indicator is not there; and
 *   2. **the last content row positively reads as a shell prompt** — either it
 *      matches one of {@link shellPromptPatterns}, or it is short enough to be a
 *      prompt ({@link maxShellPromptLength}) and ends with one of
 *      {@link shellPromptEndings}.
 *
 * Both halves are load-bearing, and (1) alone is not enough: a tool that is
 * mid-launch, painting, or showing a screen nobody has measured also matches no
 * alive pattern, and relaunching into a live pane would type the launch command
 * into the agent's composer. A verdict is only ever reached on evidence that the
 * SHELL is what is drawing the row.
 *
 * @see `resolveLivenessSpec` in `lib/cli-tools/liveness-spec` for the table.
 */
export interface ToolLivenessSpec {
  /**
   * Rows of pane tail the liveness probe asks tmux for.
   *
   * Deliberately small. The probe is looking at the BOTTOM of the pane — what
   * is on screen now — and a deep capture only drags more scrollback into
   * range, which is the one thing {@link aliveTailLines} then has to undo.
   */
  readonly probeCaptureLines: number;
  /**
   * Patterns whose presence proves this tool's own TUI is drawing the pane:
   * its prompt-ready rule, plus whatever else it draws while busy or while
   * sitting on a dialog. Matching any one of them ends the probe with "alive".
   */
  readonly alivePatterns: readonly RegExp[];
  /**
   * How many content rows from the bottom {@link alivePatterns} may look at, or
   * `null` for the whole frame.
   *
   * A window rather than the frame, because a tool's own chrome does not
   * disappear when it quits — it scrolls up. Measured on codex 0.149.1: the
   * pane of an exited session still holds `› 1. Yes, continue` from the trust
   * dialog it was launched through, 1000 rows above the shell prompt. A
   * whole-frame test therefore says "alive" forever, which is the same
   * false-negative shape claude's own check has always had.
   *
   * `null` is claude's, and only claude's: `isSessionHealthy` has tested the
   * whole frame since it was written, and Issue #2070's acceptance condition is
   * that claude's verdicts do not move.
   */
  readonly aliveTailLines: number | null;
  /**
   * Whole-line patterns that positively identify a shell prompt, checked
   * against the last content row BEFORE {@link maxShellPromptLength}.
   *
   * Empty for claude — its rule is the length gate and the endings alone, and
   * that is what must not change. For every other tool this carries the
   * `user@host … %` form, because the length gate alone is not enough: the
   * zsh default prompt of the machine Issue #2070 was measured on renders as
   * `maenokota@MAENOnoMac-Studio work-codex %` — exactly 40 characters, i.e.
   * one character past claude's own cut-off.
   */
  readonly shellPromptPatterns: readonly RegExp[];
  /** Trailing characters that make a short last row a shell prompt. */
  readonly shellPromptEndings: readonly string[];
  /**
   * A last row this long or longer is never treated as a shell prompt by the
   * endings rule. Guards TUI content that happens to end in `$` / `%` / `#`.
   */
  readonly maxShellPromptLength: number;
  /** Literal strings in the frame's tail that condemn the session outright. */
  readonly fatalPatterns: readonly string[];
  /** Regexes in the frame's tail that condemn the session outright. */
  readonly fatalRegexPatterns: readonly RegExp[];
  /**
   * Whether a frame nobody could read — an empty pane, or a capture that threw
   * — counts as "the tool is gone".
   *
   * True for claude, which has judged both that way since it was written. False
   * for every tool this Issue adds, and the asymmetry is deliberate: those two
   * frames carry no evidence either way, and Issue #2070 puts a RELAUNCH behind
   * this verdict. "No evidence" must not be able to fire it.
   */
  readonly unreadableIsExited: boolean;
}

/**
 * What a liveness probe concluded (Issue #2070).
 *
 * `alive: true` carries no reason: there is nothing to say beyond "the tool is
 * there". `alive: false` always carries one, and it is the string that reaches
 * the operator — through `HealthCheckResult.reason`, the `exited` status reason
 * the sidebar and `commandmate ls` publish, and the relaunch log line.
 */
export type ToolLivenessVerdict =
  | { readonly alive: true }
  | { readonly alive: false; readonly reason: string };

// ---------------------------------------------------------------------------
// Permission / approval mode cycling (Issue #2592)
// ---------------------------------------------------------------------------

/**
 * Every permission-mode name CommandMate can name, across every tool.
 *
 * A **union of measured vocabularies**, not a model of one tool's state machine.
 * Six of the eight supported CLIs put a mode on `shift+tab`, and no two spell
 * their modes the same way or cycle the same members — claude has four and no
 * "default", codex has two, Command Code cycles three but can *sit* in two more
 * that its cycle skips. So the ids here are the superset, and which of them a
 * given tool can be in is that tool's own {@link AgentModeSpec.cycle}.
 *
 * Measured 2026-09-16 across all eight tools at the production 200x60 geometry
 * (Issue #2592), plus the footer tables #1927 (claude 2.1.240) and #2250
 * (Command Code 1.40.1 / 1.49.0) already carried:
 *
 * | id              | who prints it                    | spelling on the pane            |
 * |-----------------|----------------------------------|---------------------------------|
 * | `manual`        | claude                           | `⏸ manual mode on`              |
 * | `auto`          | claude                           | `⏵⏵ auto mode on`               |
 * | `accept-edits`  | claude / Command Code / agy      | `⏵⏵ accept edits on`, `» accept edits on`, `accept-edits ·` |
 * | `plan`          | all five                         | `⏸ plan mode on`, `plan mode`, `Plan mode (shift+tab to cycle)`, `plan` |
 * | `autopilot`     | copilot                          | `autopilot` in the hint bar     |
 * | `bypass`        | Command Code (NOT in its cycle)  | `» permission bypass on`        |
 * | `dont-ask`      | Command Code (NOT in its cycle)  | `» don't-ask on`                |
 * | `default`       | Command Code                     | `? for shortcuts` (its own row) |
 *
 * `bypass` and `dont-ask` are declared even though `shift+tab` cannot REACH
 * them, and that is the point: a user who put Command Code in one of those from
 * the terminal is in a state the pane can be read for, and leaving them out
 * would make the reader fall through to whichever indicator matched next — on
 * 1.53.1, where `? for shortcuts` is drawn in every mode, that fall-through is
 * a chip that says `default` while the agent bypasses permissions.
 */
export const AGENT_MODE_IDS = [
  'default',
  'manual',
  'accept-edits',
  'plan',
  'auto',
  'autopilot',
  'bypass',
  'dont-ask',
] as const;

/** One permission mode a supported CLI can be in. */
export type AgentModeId = typeof AGENT_MODE_IDS[number];

/**
 * The verdict for a frame nothing in {@link AgentModeSpec.indicators} matched.
 *
 * **Not a mode.** It is the reader declining to answer, and every consumer must
 * treat it that way: the chip is not drawn, `capture --json` publishes the
 * string rather than a guess, and nothing anywhere maps it to `default`.
 *
 * The distinction is load-bearing because four of the five tools draw NOTHING in
 * their base mode (Issue #2592 §「設計に効く事実」3). If "no row" meant `default`
 * then every frame captured mid-repaint, every frame whose footer scrolled out
 * of the read window, and every future build that renames a row would publish a
 * confident `default` for a pane that might be in `plan`. A missing chip is a
 * question the operator can answer by looking at the terminal; a wrong chip is
 * one they have no reason to ask.
 */
export const AGENT_MODE_UNKNOWN = 'unknown';

/** What {@link AgentModeSpec.indicators} can be read to say about a frame. */
export type AgentMode = AgentModeId | typeof AGENT_MODE_UNKNOWN;

/** Whether `value` is a mode id (as opposed to {@link AGENT_MODE_UNKNOWN}). */
export function isAgentModeId(value: string): value is AgentModeId {
  return (AGENT_MODE_IDS as readonly string[]).includes(value);
}

/**
 * One "this frame is in mode X" reading.
 *
 * `pattern` is applied to a **stripAnsi-ed** row. Every measured indicator lives
 * inside SGR sequences on the wire — claude's footer arrives as
 * `\x1b[38;5;220m⏵⏵ auto mode on\x1b[38;5;246m (shift+tab to cycle)` — so a
 * pattern run against raw bytes matches nothing at all. `tests/fixtures/
 * agent-mode-2592/` keeps ANSI-bearing frames so that regression fails a test
 * rather than a user's screen.
 */
export interface AgentModeIndicator {
  /** The mode this row proves the tool is in. */
  readonly mode: AgentModeId;
  /**
   * Whole-row pattern, matched against the stripped row.
   *
   * No `/g` (keeps `.test()` stateless) and no nested quantifiers (ReDoS-safe),
   * the same rule `cli-patterns.ts` documents for every pattern in this repo.
   */
  readonly pattern: RegExp;
}

/**
 * A translator key for a caution the UI must print next to the mode button.
 *
 * A token rather than prose because the sentence is user-facing and has to be
 * translated (`.eslintrc.json`'s i18n rule, Issue #1271), and because the tool
 * declaring it has no way to call `useTranslations()`.
 */
export const AGENT_MODE_NOTE_IDS = ['codexModelCoupled'] as const;

/** Which caution one tool's mode button carries, if any. */
export type AgentModeNoteId = typeof AGENT_MODE_NOTE_IDS[number];

/**
 * How one tool cycles permission modes, and how its current mode is read
 * (Issue #2592).
 *
 * Returned by `ICLITool.agentModeSpec()`, `null` for a tool that has no mode on
 * `shift+tab`. The §4 D4 shape {@link ComposerSpec} / {@link CaptureSpec} /
 * {@link ToolLivenessSpec} / {@link NavigationKeySpec} already take: the tool
 * answers for itself and nothing outside `src/lib/cli-tools/**` branches on a
 * `CLIToolType`.
 *
 * ## Why the mode is READ and not remembered
 *
 * CommandMate is not the only thing pressing this key. `commandmate attach`
 * puts the operator in the same pane, the agent's own `/permissions` command
 * moves the mode, and a restart of the CommandMate server forgets everything.
 * A counter incremented per button press would be wrong after any of those and
 * would stay wrong silently, which is exactly the failure #2592's B half exists
 * to prevent ("B 無しの A は盲打ちになって使えない"). So the tool's own footer is
 * the only source, and when it cannot be read the answer is
 * {@link AGENT_MODE_UNKNOWN}.
 *
 * ## The #2032 invariant, restated
 *
 * {@link key} must be a key `sendSpecialKeys()` will actually deliver AND one
 * this tool's {@link NavigationKeySpec} publishes, or the button draws a request
 * the route answers 400 for (or, worse, validates and then throws mid-send —
 * Issue #2032's exact shape). `tests/unit/lib/cli-tools/agent-mode-declaration-2592.test.ts`
 * pins both halves against the real registry.
 */
export interface AgentModeSpec {
  /**
   * The key that advances the cycle — `BTab` for all five declaring tools.
   *
   * Declared rather than hard-coded so the invariant above is checkable, and so
   * a tool that moves its binding changes one line.
   */
  readonly key: TerminalKey;
  /**
   * The cycle, in the order measured by pressing {@link key} repeatedly.
   *
   * The first element is where the measurement started, not a "default": claude
   * has no default mode at all. A mode this tool can SIT in but cannot reach
   * with {@link key} (Command Code's `bypass` / `dont-ask`) is deliberately
   * absent here and present in {@link indicators} — the cycle is what the button
   * does, the indicators are what the pane can say.
   */
  readonly cycle: readonly AgentModeId[];
  /**
   * How a mode is recognised, most specific FIRST.
   *
   * The reader returns the first match, so an indicator that is drawn in every
   * mode (Command Code's `? for shortcuts` on 1.53.1) must come last or it wins
   * over the row that actually names the mode.
   */
  readonly indicators: readonly AgentModeIndicator[];
  /**
   * How many non-blank rows from the bottom of the frame {@link indicators} may
   * look at.
   *
   * A window, not the frame, for the reason `ToolLivenessSpec.aliveTailLines`
   * is one: a mode row does not disappear when the mode changes, it scrolls up.
   * Command Code renders INLINE (#2250 measured `alternate_on` 0), so a 1000-row
   * capture of its pane holds every footer it has ever drawn, and a whole-frame
   * test would answer with the oldest one forever.
   */
  readonly tailRows: number;
  /**
   * A caution this tool's button must carry, or `null`.
   *
   * codex alone today: its modes are coupled to the model and reasoning effort
   * (`xhigh` ⇄ `medium`, measured 2026-09-16), so one press of a button labelled
   * "mode" also moves the model tier. Issue #2592 §「設計に効く事実」4 requires
   * that be visible rather than discovered.
   */
  readonly noteId: AgentModeNoteId | null;
}
