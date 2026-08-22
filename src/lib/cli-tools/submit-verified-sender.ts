/**
 * Submit-verified message sender (Issues #1469, #1470, #1471).
 *
 * A single shared helper that replaces the seven near-identical
 * "type body -> press Enter -> maybe recover paste" sequences previously
 * duplicated across session-key-sender.ts and every cli-tools/*.ts sendMessage(),
 * plus the terminal API route's raw `sendKeys(command)` batch send.
 *
 * Why this exists (root cause):
 *   tmux `send-keys <body> C-m` batches the body and Enter into a SINGLE command.
 *   ink/React TUIs (Claude Code, Codex, ...) treat the injected body as a
 *   bracketed paste and swallow the trailing C-m as a newline inside the paste
 *   buffer, so the message is typed but never submitted. The recovery that used
 *   to guard this was gated on `message.includes('\n')` (single-line messages
 *   skipped entirely), keyed off Claude's version-specific `[Pasted text #\d+`
 *   string, and never verified that submit actually happened (fire-and-forget).
 *
 * This helper fixes all three:
 *   1. Body and Enter are ALWAYS sent as separate tmux commands with a delay
 *      between them (never a single body+C-m batch).
 *   2. Recovery + verification apply to EVERY message (no `\n` gate).
 *   3. After submit it reads the pane back and confirms the message actually
 *      left the input box (empty input line) or the tool began generating.
 *      If it is still pending it resends Enter, bounded; if it can never be
 *      confirmed it THROWS (callers must not report success on a stuck send).
 *
 * The verification is intentionally NOT keyed off the version-specific
 * `[Pasted text #\d+` placeholder. That placeholder is used only as one
 * "still pending" positive signal (broadened to be version-resilient); the
 * primary decision is "is the message still sitting on the input line?".
 *
 * Issue #1501 hardens the "still pending" branch. A TUI completion popup can
 * REPLACE the typed body with a different command (`/status` -> `/statusline`,
 * `/review` -> `/teamwork-preview`) when Enter selects a highlighted suggestion.
 * The old substring check misread the replacement as "still typed" and resent
 * Enter (executing the wrong command), or as "submitted" and left the residual
 * behind (detonating on the next send). The decision is now three-valued —
 * submitted / pending / replaced — and a `replaced` verdict clears the input
 * line and THROWS instead of resending Enter (see classifySubmit).
 *
 * Issue #1880 closes the hole on the OTHER side of the send. Everything above
 * verifies what happens after Enter; nothing looked at what was already in the
 * composer before the body was typed. `sendKeys` injects the body as plain
 * keystrokes at the TUI's CURRENT CURSOR POSITION, so residual text is spliced
 * into the body instead of being replaced by it. #1878 measured four shapes of
 * that damage: content mutation (`echo PREFILLED` + body), slash-command
 * demotion (a `/cost` body typed after residual is no longer `/`-initial),
 * order inversion when the cursor sat at column 0, and — worst — total loss of
 * the body when the RESIDUAL started with `/` (`/costZZTOP…` is an
 * `Unknown command`, so the message never reaches the model at all). All four
 * reported `exit 0` / `Message sent.` / `sessionStatus: ready`, i.e. they were
 * indistinguishable from a clean send by every signal a caller has. The
 * composer is therefore emptied and read back BEFORE the body is typed — see
 * {@link clearComposerBeforeSend}.
 */

import { sendKeys, sendSpecialKeys, capturePane, clearInputLine } from '../tmux/tmux';
import { invalidateCache } from '../tmux/tmux-capture-cache';
import {
  stripAnsi,
  detectThinking,
  findOpenCodeComposerRows,
  stripOpenCodeGutter,
  OPENCODE_IDLE_COMPOSER_PATTERN,
} from '../detection/cli-patterns';
import type { CLIToolType } from './types';
import {
  TUI_TEXT_INPUT_WAIT_MS,
  TUI_MESSAGE_PROCESSED_WAIT_MS,
} from '@/config/cli-tool-timing-config';
import { OPENCODE_PANE_HEIGHT } from '@/config/tmux-pane-config';
import { createLogger } from '@/lib/logger';
import { clearComposer } from '@/lib/session/composer-clear';

const logger = createLogger('cli-tools/submit-verified-sender');

/**
 * Version-resilient pasted-text placeholder.
 *
 * Broader than PASTED_TEXT_PATTERN (`/\[Pasted text #\d+/`) so it still matches
 * when a CLI version drops the `#N` and renders `[Pasted text +46 lines]`
 * (Issue #1469 condition 2). Used ONLY as a positive "still in the input box"
 * signal — never as the sole submit gate — so applying it to every tool is safe:
 * a tool that never renders it simply never matches.
 */
const PASTE_PLACEHOLDER_PATTERN = /\[Pasted text[\s#]/;

/**
 * A slash-command sitting on the input line (Issue #1501).
 *
 * TUI completion popups replace a typed slash command with a highlighted menu
 * item (`/status` -> `/statusline`, `/review` -> `/teamwork-preview`); the
 * result is always another slash command. Scoping the "replaced" verdict to
 * `/…` text keeps idle-prompt placeholders that some TUIs paint on an empty
 * composer (gemini's "Type your message or @path", claude's hints, "? for
 * shortcuts") — none of which start with `/` — from being mistaken for a
 * substitution, so a genuinely-submitted message never fails spuriously.
 */
const REPLACEMENT_COMMAND_PATTERN = /^\/[A-Za-z]/;

/**
 * Prompt input-line markers across the marker-drawing TUIs.
 * claude/gemini/copilot: `>` or `❯`; codex: `›`; antigravity: `>`;
 * vibe-local: `ctx:N% ❯`. Leading whitespace is tolerated (tmux padding).
 *
 * Issue #1906 scopes this to {@link INPUT_LINE_MARKER_TOOLS}. opencode draws no
 * marker at all, so applying it there was wrong in both directions — see
 * {@link readComposer}.
 */
const INPUT_LINE_MARKER = /^\s*(?:ctx:\d+%\s*)?[>❯›]/;

/**
 * The tools whose composer is a marked input line (Issue #1906).
 *
 * Every supported TUI except opencode. Listed rather than written as
 * "not opencode" so adding a tool is a decision someone makes with its frames in
 * front of them: a tool that draws no marker silently gets `submitted` for every
 * send, which is the exact defect this set exists to close.
 */
const INPUT_LINE_MARKER_TOOLS: ReadonlySet<CLIToolType> = new Set<CLIToolType>([
  'claude',
  'codex',
  'gemini',
  'copilot',
  'vibe-local',
  'antigravity',
]);

/** Lines of pane tail to inspect when verifying submit. */
const VERIFY_WINDOW_LINES = 12;

/**
 * How many rows of pane to read back when verifying a submit (Issue #1906).
 *
 * {@link VERIFY_WINDOW_LINES} for the marker tools, whose composer is the last
 * thing on the pane. opencode needs the WHOLE pane: it centres its input box
 * under the banner until the first turn is answered, roughly 100 rows above the
 * bottom of a 200-row pane, so a 12-row tail read of a first send contains
 * nothing but blank padding and the cwd footer — no composer, therefore
 * "submitted", every time (measured live on opencode 1.18.21).
 *
 * `OPENCODE_PANE_HEIGHT` is exactly the height opencode's sessions are created
 * at, and opencode runs in the alternate screen with no scrollback, so this
 * reads the visible frame and nothing more. Taken from `@/config` rather than
 * from `./opencode`: that module imports THIS one, and importing it back pulled
 * its `child_process` use into every consumer of the sender — which broke a
 * codex suite whose partial `child_process` mock has no `execFile` (measured).
 */
function verifyCaptureLines(cliToolId: CLIToolType): number {
  return cliToolId === 'opencode' ? OPENCODE_PANE_HEIGHT : VERIFY_WINDOW_LINES;
}

/**
 * What the composer holds, read in whichever way the tool's TUI allows
 * (Issue #1906).
 *
 *   absent - no composer on screen: the prompt scrolled away, a dialog replaced
 *            it, or the session is still starting. Never a failure verdict.
 *   empty  - the composer is on screen and holds nothing.
 *   text   - the composer holds something; `text` is its first non-blank row and
 *            `rows` every raw row it occupies.
 */
type ComposerRead =
  | { kind: 'absent' }
  | { kind: 'empty' }
  | { kind: 'text'; text: string; rows: string[] };

/**
 * Read the composer out of a captured frame.
 *
 * Two readers, because the two families of TUI say "this is the input line" in
 * incompatible ways:
 *
 * - **marker tools** ({@link INPUT_LINE_MARKER_TOOLS}) draw a `>` / `❯` / `›` at
 *   the start of the row. Scanned bottom-up over the tail window so a status bar
 *   below the box does not hide it.
 * - **opencode** draws a box with a gutter and no marker anywhere. Its buffer
 *   rows are located structurally by {@link findOpenCodeComposerRows} (#1911's
 *   chrome walk), and `Ask anything...` inside that box is opencode's own way of
 *   saying the buffer is empty (#1883) rather than a row of text.
 *
 * Before this split, opencode went through the marker reader, which is wrong
 * both ways round. It never matched opencode's composer, so EVERY opencode send
 * was classified `submitted` without evidence — #1471's "the Enter was
 * swallowed" recovery has never once run on opencode. And when a `>` did land in
 * the window from somewhere else (a Markdown quote in a reply), the reader
 * treated that row as the input line and answered from it.
 */
function readComposer(
  cliToolId: CLIToolType,
  lines: string[],
  windowLines: string[]
): ComposerRead {
  if (cliToolId === 'opencode') {
    const rows = findOpenCodeComposerRows(lines);
    if (rows === null) return { kind: 'absent' };
    // The placeholder is painted only while the buffer is empty, and only
    // inside the box — hence matched on the raw, still-guttered row (#1883).
    if (rows.some((row) => OPENCODE_IDLE_COMPOSER_PATTERN.test(row))) return { kind: 'empty' };
    const first = rows.map(stripOpenCodeGutter).find((row) => row.length > 0);
    if (first === undefined) return { kind: 'empty' };
    return { kind: 'text', text: first, rows };
  }

  if (!INPUT_LINE_MARKER_TOOLS.has(cliToolId)) return { kind: 'absent' };

  const inputLine = findInputLine(windowLines);
  if (inputLine === null) return { kind: 'absent' };
  const stripped = stripInputMarker(inputLine);
  if (stripped.length === 0) return { kind: 'empty' };
  return { kind: 'text', text: stripped, rows: [inputLine] };
}

/** Default bounded read-back attempts before giving up (throwing). */
const DEFAULT_VERIFY_ATTEMPTS = 4;

/**
 * Three-valued classification of the read-back pane (Issue #1501).
 *
 *   submitted - the message left the input box (or the tool is generating).
 *   pending   - the message is still verbatim on the input line -> resend Enter.
 *   replaced  - the input line holds DIFFERENT text than we typed (a TUI popup
 *               autocompleted/replaced the command) -> clear the line and throw,
 *               never resend Enter.
 */
export type SubmitState = 'submitted' | 'pending' | 'replaced';

export interface SubmitVerifiedSendParams {
  /** tmux session name (already validated by the caller chain). */
  sessionName: string;
  /** Message body to type (sent verbatim, without a trailing newline). */
  message: string;
  /** CLI tool id — selects the tool-specific "generating" detector. */
  cliToolId: CLIToolType;
  /**
   * ms to wait after typing the body before pressing Enter, so the TUI
   * registers the input first. Default: TUI_TEXT_INPUT_WAIT_MS (100).
   */
  textInputWaitMs?: number;
  /**
   * Number of Enter presses for the INITIAL submit. Default 1.
   * vibe-local uses 2 (IME mode: first Enter inserts a newline, the second
   * submits) — see VIBE_LOCAL_DOUBLE_ENTER_WAIT_MS.
   */
  submitEnterCount?: number;
  /** ms between the initial Enter presses when submitEnterCount > 1. */
  interEnterWaitMs?: number;
  /** Bounded read-back attempts. Default DEFAULT_VERIFY_ATTEMPTS (4). */
  verifyAttempts?: number;
  /**
   * ms to wait before each read-back capture. Default
   * TUI_MESSAGE_PROCESSED_WAIT_MS (200). Callers that must stay snappy
   * (terminal route) can lower the attempts/delay to keep the total bounded.
   */
  verifyDelayMs?: number;
}

/**
 * First non-blank line of the message, trimmed. This is what a TUI shows on the
 * prompt line before the body folds into a paste placeholder. NOT truncated:
 * the replacement check (inputMatchesBody) needs the full first line so that a
 * completion suffix (`/status` -> `/statusline`) is not mistaken for the body.
 */
function firstNonBlankLine(message: string): string {
  const line = message
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return line ?? '';
}

/**
 * Locate the active input line within the pane tail: the last line that begins
 * with a prompt marker. Scanned bottom-up so a status-bar/footer line rendered
 * BELOW the input box (antigravity's "? for shortcuts", vibe-local's status bar)
 * does not hide the real input line above it.
 */
function findInputLine(windowLines: string[]): string | null {
  for (let i = windowLines.length - 1; i >= 0; i--) {
    if (INPUT_LINE_MARKER.test(windowLines[i])) {
      return windowLines[i];
    }
  }
  return null;
}

/** Input line text with the prompt marker stripped and surrounding space trimmed. */
function stripInputMarker(inputLine: string): string {
  return inputLine.replace(INPUT_LINE_MARKER, '').trim();
}

/**
 * Whether the (marker-stripped, non-empty) input-line text is still our
 * unsent body rather than a TUI-substituted command.
 *
 * The still-unsent body appears verbatim on the input line. Line wrapping can
 * visually truncate it to a PREFIX of the first line, but a completion popup
 * always produces a DIFFERENT string — the body plus a completion suffix
 * (`/status` -> `/statusline`) or an unrelated command (`/review` ->
 * `/teamwork-preview`) — which is never a prefix of the body. So the body is
 * "still there" iff the input text is a prefix of (or equals) the body's first
 * line. This deliberately rejects `/statusline` for a `/status` body: the safe
 * rule is "input text that is not the body (or a prefix of it) is NOT resent".
 */
function inputMatchesBody(strippedInput: string, message: string): boolean {
  const bodyFirstLine = firstNonBlankLine(message);
  if (bodyFirstLine.length === 0) return false;
  return bodyFirstLine.startsWith(strippedInput);
}

/**
 * Classify a captured pane into submitted / pending / replaced (Issue #1501).
 *
 * Version-independent by design — does NOT require the paste placeholder:
 *   A. The tool is generating a response              -> submitted.
 *   B. No composer, or the composer is empty           -> submitted.
 *   C. A paste placeholder is folded in the composer   -> pending (Enter eaten).
 *   D. The body is still verbatim in the composer      -> pending (resend Enter).
 *   E. A DIFFERENT slash command is in the composer    -> replaced (TUI popup
 *      autocompleted the command; clear the line and throw, never resend Enter).
 *   F. Any other non-empty text (idle placeholder/hint) -> submitted (unchanged
 *      pre-#1501 permissive default, so normal sends never spuriously fail).
 *
 * C–F are scoped to the composer only, so the user-message echo that a TUI
 * prints into its history above the prompt never causes a false verdict.
 *
 * Issue #1906: "the composer" is read per tool by {@link readComposer} rather
 * than by looking for a `>` in the last twelve rows. For opencode — which draws
 * no marker — that read was unreachable, so every send reached F (in fact B) and
 * this function has never returned anything but `submitted` for it.
 *
 * @param output - Captured pane, ANSI intact. For opencode this must be the
 *   whole pane; {@link verifyCaptureLines} is what asks tmux for it.
 */
export function classifySubmit(
  output: string,
  cliToolId: CLIToolType,
  message: string
): SubmitState {
  const clean = stripAnsi(output);
  const lines = clean.split('\n');
  const windowLines = lines.slice(-VERIFY_WINDOW_LINES);
  const windowStr = windowLines.join('\n');

  // A. Actively generating a response => the message was accepted. Read from the
  //    tail window for every tool: each one's busy marker lives in a status bar
  //    pinned to the bottom of the pane, and widening it to opencode's whole
  //    frame would match `esc interrupt` printed inside a reply.
  if (detectThinking(cliToolId, windowStr)) {
    return 'submitted';
  }

  const composer = readComposer(cliToolId, lines, windowLines);

  // B. No composer visible (scrolled off / dialog / still starting), or the
  //    composer is empty => the message left the box => submitted.
  if (composer.kind !== 'text') {
    return 'submitted';
  }

  // C. A paste placeholder is still folded into the composer => body is there.
  if (composer.rows.some((row) => PASTE_PLACEHOLDER_PATTERN.test(row))) {
    return 'pending';
  }

  // D. The typed body is still sitting in the composer => resend Enter.
  if (inputMatchesBody(composer.text, message)) {
    return 'pending';
  }

  // E. A different slash command is in the composer => a completion popup
  //    replaced what we typed. (Scoped to `/…` so idle-prompt placeholders that
  //    some TUIs paint on an empty composer are never mistaken for this.)
  if (REPLACEMENT_COMMAND_PATTERN.test(composer.text)) {
    return 'replaced';
  }

  // F. Non-empty, non-command steady-state text (idle placeholder / hint) =>
  //    submitted, preserving the pre-#1501 permissive default.
  return 'submitted';
}

/**
 * Backward-compatible boolean view of {@link classifySubmit}: submitted vs not.
 * A `replaced` verdict is NOT "submitted", so this returns false for it too.
 */
export function isSubmitted(output: string, cliToolId: CLIToolType, message: string): boolean {
  return classifySubmit(output, cliToolId, message) === 'submitted';
}

/**
 * CLIs whose composer this layer is allowed to empty before typing (Issue #1880).
 *
 * The gate is `extractComposerText`'s reach, not a preference: it short-circuits
 * every unmeasured tool to `unsupported_tool`, so for gemini/copilot/opencode/
 * vibe-local/antigravity {@link clearComposer} can never observe an empty box and
 * always returns `cleared: false`. Reading that as "the clear failed" and
 * refusing to send would take every one of those tools offline while claude kept
 * working and the unit tests stayed green — so those tools do not enter the clear
 * path at all: no read-back capture, no `C-e`+`C-u`, no new failure mode.
 * Byte-for-byte the pre-#1880 send.
 *
 * codex joined in Issue #1890, which is the reason this set is not simply
 * `SUPPORTED_COMPOSER_TOOLS`: shipping #1880 claude-only left codex measurably
 * broken (its ケース7 reproduced the splice verbatim), and the fix was to measure
 * codex's input box, not to relax the gate. Adding the next tool means the same
 * work — a live 200x1000 capture of its box, its idle placeholder and its
 * dialogs, pinned as fixtures. Blind `C-u` into an input line nobody has measured
 * is how the residual problem gets replaced with a data-loss problem.
 */
const COMPOSER_CLEAR_SUPPORTED_TOOLS: ReadonlySet<string> = new Set<CLIToolType>([
  'claude',
  'codex',
]);

/**
 * Empty the composer before the body is typed into it (Issue #1880).
 *
 * Delegates the how to {@link clearComposer} (#1879), which already sends
 * `C-e`+`C-u` — the `C-e` is what makes a column-0 cursor clearable — in a
 * read-back-verified loop, so a multi-row residual is not left half-eaten and
 * claude's dim ghost suggestions do not spin it to its cap. This function is the
 * policy layer on top: which tools take part, and which outcomes are failures.
 *
 * Exactly one outcome is a failure: **a participating tool still reporting
 * `content` after the pass cap**. That is a composer this code demonstrably
 * could not empty, so typing into it would splice the body into whatever is
 * there and then report success — the defect #1880 exists to remove. Everything
 * else proceeds:
 *
 *   - `unsupported_tool` — never reached (see COMPOSER_CLEAR_SUPPORTED_TOOLS),
 *     but it means "this layer cannot read that box", not "the box is dirty".
 *   - `no_composer` — the input box is not on screen (a full-screen dialog, a
 *     pager, a session still starting). Nothing was inspected and nothing was
 *     sent; refusing here would invent a second way for sends to stall, on a
 *     frame that carries no evidence of residual text. On codex this is also the
 *     verdict for every dialog frame, which is what keeps a `C-e`+`C-u` volley
 *     off an approval screen (Issue #1890).
 *   - `empty` / `ghost` — verified clean, with or without passes.
 *
 * A throw from {@link clearComposer} itself is a tmux failure (`capture-pane` or
 * `send-keys` returned non-zero) and is deliberately NOT caught: the very next
 * thing this module does is drive the same tmux binary against the same session,
 * and swallowing it would mean typing into a composer whose contents are
 * unknown while still reporting success.
 *
 * @throws Error when the composer still holds text after the pass cap.
 */
export async function clearComposerBeforeSend(
  sessionName: string,
  cliToolId: CLIToolType
): Promise<void> {
  if (!COMPOSER_CLEAR_SUPPORTED_TOOLS.has(cliToolId)) return;

  const result = await clearComposer(sessionName, cliToolId);

  if (result.state === 'content') {
    logger.error('pre-send-composer-clear-failed', {
      sessionName,
      cliToolId,
      passes: result.passes,
      remainingLength: result.remainingText.length,
      remainingText: result.remainingText,
    });
    throw new Error(
      `Composer for session ${sessionName} still holds unsent text after ${result.passes} clear passes; ` +
        'refusing to type the message, which would be concatenated with it (Issue #1880).'
    );
  }

  if (result.passes > 0) {
    // The only record of what was thrown away. `remainingText` is the FINAL
    // read and is empty on this path by definition, which is why clearComposer
    // reports `discardedText` separately.
    logger.warn('pre-send-composer-cleared', {
      sessionName,
      cliToolId,
      passes: result.passes,
      state: result.state,
      discardedLength: result.discardedText.length,
      discardedText: result.discardedText,
    });
  }
}

/**
 * Type a message body and submit it, then verify the submit actually happened.
 *
 * The body and Enter are always separate tmux commands (never batched), so the
 * TUI cannot swallow the Enter inside a bracketed-paste buffer. After the
 * initial submit the pane is read back up to `verifyAttempts` times; each time
 * it is still pending an extra Enter is sent. If submit can never be confirmed
 * the function THROWS — callers must surface that as a failure, never as
 * success (Issues #1469/#1470/#1471).
 *
 * @throws Error when submit cannot be confirmed within the bounded attempts.
 */
export async function sendMessageWithSubmitVerification(
  params: SubmitVerifiedSendParams
): Promise<void> {
  const {
    sessionName,
    message,
    cliToolId,
    textInputWaitMs = TUI_TEXT_INPUT_WAIT_MS,
    submitEnterCount = 1,
    interEnterWaitMs = TUI_TEXT_INPUT_WAIT_MS,
    verifyAttempts = DEFAULT_VERIFY_ATTEMPTS,
    verifyDelayMs = TUI_MESSAGE_PROCESSED_WAIT_MS,
  } = params;

  // 0. Empty the composer first (Issue #1880). The body below is typed at the
  //    TUI's current cursor position, so anything already in the box would be
  //    spliced into it. Throws for a claude composer that could not be emptied.
  await clearComposerBeforeSend(sessionName, cliToolId);

  // 1. Type the body only — never send Enter in the same tmux command.
  await sendKeys(sessionName, message, false);

  // 2. Let the TUI register the input before pressing Enter.
  await new Promise((resolve) => setTimeout(resolve, textInputWaitMs));

  // 3. Submit as a separate command (double Enter for vibe-local's IME mode).
  for (let i = 0; i < Math.max(1, submitEnterCount); i++) {
    await sendSpecialKeys(sessionName, ['Enter']);
    if (i < submitEnterCount - 1) {
      await new Promise((resolve) => setTimeout(resolve, interEnterWaitMs));
    }
  }

  // 4. Read-back verification: confirm the message left the input box, resend
  //    Enter while it is still pending, and throw if it never submits.
  const attempts = Math.max(1, verifyAttempts);
  for (let attempt = 0; attempt < attempts; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, verifyDelayMs));

    const output = await capturePane(sessionName, { startLine: -verifyCaptureLines(cliToolId) });
    const state = classifySubmit(output, cliToolId, message);

    if (state === 'submitted') {
      invalidateCache(sessionName);
      return;
    }

    if (state === 'replaced') {
      // A TUI completion popup replaced our command with a different one.
      // Resending Enter would EXECUTE that command (Issue #1501 flavor A);
      // leaving it in place lets the residual detonate on the next send
      // (flavor B). Clear the input line (best-effort) and surface the failure
      // to the caller instead of ever resending Enter.
      try {
        await clearInputLine(sessionName);
      } catch (clearError: unknown) {
        logger.error('submit-clear-input-failed', {
          sessionName,
          cliToolId,
          error: clearError instanceof Error ? clearError.message : String(clearError),
        });
      }
      invalidateCache(sessionName);
      logger.error('submit-replaced-by-tui-completion', { sessionName, cliToolId, attempt });
      throw new Error(
        `Message was replaced by a TUI autocompletion for session ${sessionName}; the input no longer matches the sent text. Cleared the input line without submitting to avoid executing a different command.`
      );
    }

    // state === 'pending' — still typed-but-unsent, resend a single Enter and re-check.
    logger.warn('submit-not-confirmed:resending-enter', {
      sessionName,
      cliToolId,
      attempt,
    });
    await sendSpecialKeys(sessionName, ['Enter']);
  }

  invalidateCache(sessionName);
  logger.error('submit-verification-failed', { sessionName, cliToolId, attempts });
  throw new Error(
    `Message submit could not be confirmed for session ${sessionName} after ${attempts} attempts (typed but unsent)`
  );
}
