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
 *
 * Issue #2464 is the body itself going missing on the way in. A body longer
 * than one pty read reaches the TUI as several reads — tmux delivers every byte
 * (12,288 of 12,288 measured on a raw pane), but the reader gets them 1,022
 * bytes at a time on macOS — and Claude Code 2.1.268 reassembles unbracketed
 * input read by read and keeps only the LAST one. A 1 KB brief arrived as its
 * final 2 bytes, a 4 KB one as its final 8, and the send still said `Message
 * sent.`: the tail sits in the composer as ordinary text, Enter submits it, and
 * nothing downstream can tell a tail from a message. Neither the #1880 clear nor
 * the Enter timing is involved — both were switched off in controls and the
 * loss was unchanged. So a long body is now PASTED ({@link pasteBody}: one
 * bracketed paste, which the TUI reads as a unit), and Enter is withheld until
 * the composer shows the whole of it ({@link classifyPasteLanded}). The
 * measurements are in `docs/design/2464-long-body-repro-matrix.md`.
 */

import * as childProcess from 'child_process';
import { sendKeys, sendSpecialKeys, capturePane, clearInputLine, exactTarget } from '../tmux/tmux';
import { invalidateCache } from '../tmux/tmux-capture-cache';
import { resolveComposerSpec } from './composer-spec';
import type { ComposerSpec } from '../../types/cli-tool-contracts';
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
 * Largest body typed as keystrokes (`send-keys -l`); anything longer is pasted
 * (Issue #2464).
 *
 * The limit is the pty's, not tmux's. tmux hands the pane the whole argv —
 * 16,320 bytes arrived intact on tmux 3.5a, and past ~16.3 KB `send-keys`
 * refuses with `command too long`, loudly — but the TUI reads it back in
 * pty-sized pieces, 1,022 bytes each on macOS. Claude Code keeps only the last
 * piece of unbracketed input (`12288 mod 1022` = the 24 bytes that arrived of a
 * 12 KB brief), so a body is only safe as keystrokes while it fits in a single
 * read. Half the smallest read measured leaves room for multi-byte text and for
 * a platform whose reads are shorter.
 */
export const LITERAL_SEND_MAX_BYTES = 512;

/**
 * How often the composer is read while a pasted body is expected to appear in
 * it. Claude, codex, Command Code and agy all drew the pasted body within
 * 60 ms of `paste-buffer` on a 12 KB brief.
 */
const PASTE_LANDED_POLL_MS = 100;

/** Composer reads before a paste that has not fully appeared is abandoned (2 s). */
const DEFAULT_PASTE_LANDED_ATTEMPTS = 20;

/** Per-command timeout for `load-buffer` / `paste-buffer`, as for every other tmux call. */
const PASTE_COMMAND_TIMEOUT_MS = 5000;

/** Makes each send's tmux paste buffer name unique within this process. */
let pasteBufferSeq = 0;

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
 * Issue #1906 scopes this to the tools whose {@link ComposerSpec.reader} is
 * `input-line-marker`. opencode draws no marker at all, so applying it there was
 * wrong in both directions — see {@link readComposer}.
 */
const INPUT_LINE_MARKER = /^\s*(?:ctx:\d+%\s*)?[>❯›]/;

/**
 * Lines of pane tail to inspect for the "is the tool generating?" signal.
 *
 * Distinct from `ComposerSpec.verifyCaptureLines`, which sizes the tmux
 * capture: the busy marker of every tool lives in a status bar pinned to the
 * bottom of the pane, so it is read from a short tail even when the capture
 * itself is opencode's whole 200-row frame. Widening it to that frame would
 * match `esc interrupt` printed inside a reply.
 *
 * "The bottom" is the last row that holds anything (Issue #2464). codex,
 * Command Code and agy draw inline from the TOP of the 1000-row pane, so the
 * last twelve rows of the capture are blank padding — measured at rows 306,
 * 297 and 286 of 1,002 — and reading them found no composer on any send to
 * those three tools. See {@link withoutTrailingBlankRows}.
 */
const VERIFY_WINDOW_LINES = 12;

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
 * - **marker tools** (`reader: 'input-line-marker'`) draw a `>` / `❯` / `›` at
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
 *
 * Issue #1933 turned "which reader" from a `cliToolId === 'opencode'` test plus
 * a set membership test into {@link ComposerSpec.reader}, so the answer is one
 * declaration the tool owns rather than two tables a new tool has to be added
 * to. `unreadable` is the third arm, and it is the one #1906 found opencode
 * silently occupying: it means every send is classified `submitted` without
 * evidence, so it is a state to declare knowingly, never to fall into.
 */
function readComposer(
  reader: ComposerSpec['reader'],
  lines: string[],
  windowLines: string[]
): ComposerRead {
  if (reader === 'opencode-box') {
    const rows = findOpenCodeComposerRows(lines);
    if (rows === null) return { kind: 'absent' };
    // The placeholder is painted only while the buffer is empty, and only
    // inside the box — hence matched on the raw, still-guttered row (#1883).
    if (rows.some((row) => OPENCODE_IDLE_COMPOSER_PATTERN.test(row))) return { kind: 'empty' };
    const first = rows.map(stripOpenCodeGutter).find((row) => row.length > 0);
    if (first === undefined) return { kind: 'empty' };
    return { kind: 'text', text: first, rows };
  }

  if (reader !== 'input-line-marker') return { kind: 'absent' };

  const inputLine = findInputLine(windowLines);
  if (inputLine === null) return { kind: 'absent' };
  const stripped = stripInputMarker(inputLine);
  if (stripped.length === 0) return { kind: 'empty' };
  return { kind: 'text', text: stripped, rows: [inputLine] };
}

/**
 * The captured rows without the blank rows under the last drawn one
 * (Issue #2464).
 *
 * `capture-pane` returns every row of the pane, and a TUI that renders inline
 * from the top (codex, Command Code, agy) fills only the first few hundred of
 * the 1000 rows the session is created with. The composer is the last thing
 * such a TUI draws, so "the tail of the pane" has to mean "the tail of what is
 * drawn" — otherwise the tail window is all padding, no composer is ever found,
 * and every send to those tools classifies as `submitted` whatever the
 * composer actually holds. A bottom-anchored TUI (claude) has no trailing blank
 * rows, so for it this is the identity.
 */
function withoutTrailingBlankRows(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === '') end--;
  return lines.slice(0, end);
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

/**
 * How much of a PASTED body the composer shows, read before Enter (Issue #2464).
 *
 *   landed   - the composer holds the body and nothing else: its placeholder
 *              counts as many lines / characters as the body has, or its first
 *              row is the start of the body.
 *   pasting  - a placeholder counting FEWER lines / characters than the body:
 *              the paste is still arriving. Enter must wait.
 *   mismatch - the composer holds something that is not the body as sent: part
 *              of the body that is not its beginning (the #2464 tail), more than
 *              one placeholder, a placeholder plus other text, or a count larger
 *              than the body's. Enter must never be pressed on it.
 *   unseen   - nothing of the body is visible: no composer, an empty one, or
 *              the TUI's idle placeholder text.
 */
export type PasteLandedState = 'landed' | 'pasting' | 'mismatch' | 'unseen';

export interface SubmitVerifiedSendParams {
  /** tmux session name (already validated by the caller chain). */
  sessionName: string;
  /** Message body to type (sent verbatim, without a trailing newline). */
  message: string;
  /** CLI tool id — selects the tool-specific "generating" detector. */
  cliToolId: CLIToolType;
  /**
   * ms to wait after typing the body before pressing Enter, so the TUI
   * registers the input first. Default: TUI_TEXT_INPUT_WAIT_MS (100). A pasted
   * body waits at least this long too, counted from the paste.
   */
  textInputWaitMs?: number;
  /**
   * The tool's composer description (Issue #1933). Defaults to the tool's own
   * (`resolveComposerSpec`), so every existing call site is unchanged; a tool
   * passes `this.describeComposer()` when it wants its override honoured.
   */
  composer?: ComposerSpec;
  /**
   * Number of Enter presses for the INITIAL submit. Defaults to the composer
   * spec's `submitEnterCount` (1 for every tool but vibe-local, whose IME mode
   * makes the first Enter insert a newline) — see VIBE_LOCAL_DOUBLE_ENTER_WAIT_MS.
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
  /**
   * Composer reads while waiting for a pasted body (longer than
   * {@link LITERAL_SEND_MAX_BYTES}) to appear in full before Enter.
   * Default DEFAULT_PASTE_LANDED_ATTEMPTS (20, i.e. 2 s at the poll interval).
   */
  pasteLandedAttempts?: number;
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
 * What a collapsed paste placeholder says it holds (Issue #2464).
 *
 * Only the counts a TUI actually prints are filled in, and each is compared in
 * the unit that TUI counts in (see {@link comparePasteToken}).
 */
interface PasteToken {
  /** `+M lines` (claude, agy). claude counts newlines, agy counts lines. */
  lines?: number;
  /** `N chars` (codex, and agy for a single-line paste). */
  chars?: number;
  /** `+NL` (Command Code), which counts lines. */
  lineTotal?: number;
  /** The leading text Command Code prints inside its token, before the `…`. */
  head?: string;
}

/**
 * Collapsed-paste placeholders, as measured at the production 200x1000
 * geometry (Issue #2464, `tests/fixtures/long-body-2464/`):
 *
 *   claude 2.1.268  `[Pasted text #86 +59 lines]` for 60 lines, `[Pasted text #87]` for one
 *   agy 1.2.0       `[Pasted text #5 +60 lines]` for 60 lines, `[Pasted text #6 12288 chars]` for one
 *   codex 0.154.0   `[Pasted Content 12288 chars]`
 *   Command Code 1.53.0  `[PROBE P12k… +60L]` — the first ten characters, then the line count
 *
 * The `#N` stays optional for #1469's version drift (`[Pasted text +46 lines]`).
 */
const PASTE_TOKEN_PATTERNS: ReadonlyArray<{ pattern: RegExp; read: (m: RegExpExecArray) => PasteToken }> = [
  {
    pattern: /\[Pasted text(?: #\d+)?(?: \+(\d+) lines?| (\d+) chars?)?\]/g,
    read: (m) =>
      m[1] !== undefined ? { lines: Number(m[1]) } : m[2] !== undefined ? { chars: Number(m[2]) } : {},
  },
  { pattern: /\[Pasted Content (\d+) chars?\]/g, read: (m) => ({ chars: Number(m[1]) }) },
  { pattern: /\[([^\]\n]*?)… \+(\d+)L\]/g, read: (m) => ({ head: m[1], lineTotal: Number(m[2]) }) },
];

/** Every paste placeholder on a composer row, and the text left around them. */
function findPasteTokens(text: string): { tokens: PasteToken[]; rest: string } {
  const tokens: PasteToken[] = [];
  let rest = text;
  for (const { pattern, read } of PASTE_TOKEN_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      tokens.push(read(match as RegExpExecArray));
      rest = rest.replace(match[0], '');
    }
  }
  return { tokens, rest: rest.trim() };
}

/**
 * Does one placeholder account for the whole body?
 *
 * Counts below the body's mean the paste is still arriving; counts above it mean
 * the composer holds more than the body. The two units that differ between
 * tools for the same `+M lines` wording (claude: 59 for a 60-line body, agy: 60)
 * are both accepted — a bracketed paste arrives as one unit, so the failure this
 * guards against is a count that is wildly short (the 24-byte tail of #2464),
 * not one that is off by one line.
 */
function comparePasteToken(token: PasteToken, message: string): PasteLandedState {
  const newlines = (message.match(/\n/g) ?? []).length;
  if (token.head !== undefined) {
    const normalizedHead = token.head.replace(/\s+/g, ' ').trim();
    if (!message.replace(/\s+/g, ' ').startsWith(normalizedHead)) return 'mismatch';
  }

  let observed: number;
  let accepted: number[];
  if (token.chars !== undefined) {
    observed = token.chars;
    accepted = [[...message].length, message.length];
  } else if (token.lineTotal !== undefined) {
    observed = token.lineTotal;
    accepted = [newlines + 1];
  } else if (token.lines !== undefined) {
    observed = token.lines;
    accepted = [newlines, newlines + 1];
  } else {
    // claude's bare `[Pasted text #N]` is what it draws for a single line.
    return newlines === 0 ? 'landed' : 'pasting';
  }

  if (accepted.includes(observed)) return 'landed';
  return observed < Math.min(...accepted) ? 'pasting' : 'mismatch';
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
 * Issue #2464: the tail window starts at the last drawn row, not at the last row
 * of the pane ({@link withoutTrailingBlankRows}), and C recognises every tool's
 * paste placeholder ({@link findPasteTokens}), not only claude's.
 *
 * @param output - Captured pane, ANSI intact. For opencode this must be the
 *   whole pane; {@link ComposerSpec.verifyCaptureLines} is what asks tmux for it.
 * @param cliToolId - CLI tool id, for the "generating" detector
 * @param message - The body that was typed
 * @param composer - The tool's composer description (Issue #1933). Defaults to
 *   the tool's own, so every existing three-argument caller is unchanged.
 */
export function classifySubmit(
  output: string,
  cliToolId: CLIToolType,
  message: string,
  composerSpec: ComposerSpec = resolveComposerSpec(cliToolId)
): SubmitState {
  const clean = stripAnsi(output);
  const lines = withoutTrailingBlankRows(clean.split('\n'));
  const windowLines = lines.slice(-VERIFY_WINDOW_LINES);
  const windowStr = windowLines.join('\n');

  // A. Actively generating a response => the message was accepted. Read from the
  //    tail window for every tool: each one's busy marker lives in a status bar
  //    pinned to the bottom of the pane, and widening it to opencode's whole
  //    frame would match `esc interrupt` printed inside a reply.
  if (detectThinking(cliToolId, windowStr)) {
    return 'submitted';
  }

  const composer = readComposer(composerSpec.reader, lines, windowLines);

  // B. No composer visible (scrolled off / dialog / still starting), or the
  //    composer is empty => the message left the box => submitted.
  if (composer.kind !== 'text') {
    return 'submitted';
  }

  // C. A paste placeholder is still folded into the composer => body is there.
  if (composer.rows.some((row) => PASTE_PLACEHOLDER_PATTERN.test(row) || findPasteTokens(row).tokens.length > 0)) {
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
export function isSubmitted(
  output: string,
  cliToolId: CLIToolType,
  message: string,
  composerSpec: ComposerSpec = resolveComposerSpec(cliToolId)
): boolean {
  return classifySubmit(output, cliToolId, message, composerSpec) === 'submitted';
}

/**
 * How much of a pasted body the composer shows, read BEFORE Enter (Issue #2464).
 *
 * The question #2464 needs answered is not "did Enter work" but "is what Enter
 * would submit the message we sent". Claude kept the last 24 bytes of a 12 KB
 * brief as ordinary composer text; every check that runs after Enter saw an
 * empty box and a generating model, i.e. a perfect send. So the composer is
 * judged here, while pressing Enter can still be withheld:
 *
 *   1. A collapsed placeholder is compared by the count the TUI prints — lines
 *      for claude, agy and Command Code, characters for codex and agy's
 *      single-line form ({@link comparePasteToken}).
 *   2. Plain text is the body only if it is the body's BEGINNING. Text that
 *      occurs in the body but not at its start is exactly the #2464 tail, and is
 *      a mismatch rather than "not drawn yet".
 *   3. Anything else — the idle placeholder, a ghost suggestion, no composer —
 *      shows nothing of the body. `unseen`, which the caller decides about.
 *
 * Reads the same tail window as {@link classifySubmit}, so a history echo of an
 * earlier message above the composer is never mistaken for this one.
 */
export function classifyPasteLanded(
  output: string,
  cliToolId: CLIToolType,
  message: string,
  composerSpec: ComposerSpec = resolveComposerSpec(cliToolId)
): PasteLandedState {
  const lines = withoutTrailingBlankRows(stripAnsi(output).split('\n'));
  const composer = readComposer(composerSpec.reader, lines, lines.slice(-VERIFY_WINDOW_LINES));
  if (composer.kind !== 'text') return 'unseen';

  const { tokens, rest } = findPasteTokens(composer.text);
  if (tokens.length === 0) {
    if (inputMatchesBody(composer.text, message)) return 'landed';
    if (message.includes(composer.text)) return 'mismatch';
    return 'unseen';
  }
  if (tokens.length > 1 || rest !== '') return 'mismatch';
  return comparePasteToken(tokens[0], message);
}

/** Run one tmux command, optionally feeding it `input` on stdin. */
function runTmux(args: string[], input?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = childProcess.execFile('tmux', args, { timeout: PASTE_COMMAND_TIMEOUT_MS }, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
    if (input !== undefined) child.stdin?.end(input);
  });
}

/**
 * Put a body into the pane as ONE bracketed paste (Issue #2464).
 *
 * `load-buffer -` takes the body on stdin, so there is no argv ceiling (20 KB
 * went through where `send-keys` refuses past ~16.3 KB). `paste-buffer -p`
 * wraps it in `ESC[200~ … ESC[201~` when — and only when — the application
 * has asked for bracketed paste; a TUI that has not receives exactly the bytes
 * `send-keys -l` would have typed (both measured byte-for-byte on a raw pane).
 * `-r` keeps LF as LF instead of tmux's default LF→CR, which would be an Enter
 * per line for a TUI that did not ask for brackets. `-d` drops the buffer on
 * success; a failure drops it here, so no body is left behind in the server.
 *
 * @throws Error when either tmux command fails
 */
async function pasteBody(sessionName: string, message: string): Promise<void> {
  const bufferName = `cm-send-${process.pid}-${++pasteBufferSeq}`;
  try {
    await runTmux(['load-buffer', '-b', bufferName, '-'], message);
    await runTmux(['paste-buffer', '-p', '-r', '-d', '-b', bufferName, '-t', exactTarget(sessionName)]);
  } catch (error: unknown) {
    await runTmux(['delete-buffer', '-b', bufferName]).catch(() => undefined);
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to paste message into tmux session: ${errorMessage}`);
  }
}

/** The composer's first row, for an error message a person has to act on. */
function describeComposer(output: string, composerSpec: ComposerSpec): string {
  const lines = withoutTrailingBlankRows(stripAnsi(output).split('\n'));
  const composer = readComposer(composerSpec.reader, lines, lines.slice(-VERIFY_WINDOW_LINES));
  if (composer.kind === 'absent') return 'no composer on screen';
  if (composer.kind === 'empty') return 'an empty composer';
  const text = composer.text.length > 80 ? `${composer.text.slice(0, 80)}…` : composer.text;
  return JSON.stringify(text);
}

/**
 * Take a body that did not arrive intact back out of the composer, best effort.
 *
 * Leaving it would put the fragment in front of the next message. claude and
 * codex go through the verified #1879 loop (a paste can span rows); the rest
 * get the single `C-u` the #1501 path already sends to them.
 */
async function withdrawUnsentBody(
  sessionName: string,
  cliToolId: CLIToolType,
  composerSpec: ComposerSpec
): Promise<void> {
  try {
    if (composerSpec.clearBeforeSend) {
      await clearComposer(sessionName, cliToolId);
    } else {
      await clearInputLine(sessionName);
    }
  } catch (clearError: unknown) {
    logger.error('paste-withdraw-failed', {
      sessionName,
      cliToolId,
      error: clearError instanceof Error ? clearError.message : String(clearError),
    });
  }
}

/**
 * Wait until the composer shows the whole pasted body; decide whether Enter
 * may be pressed (Issue #2464).
 *
 * `pasting` keeps waiting — this is the "a placeholder is not a stuck body"
 * branch: `[Pasted text #3 +20 lines]` for a 60-line brief is a paste still
 * coming in, and Enter pressed now would submit twenty lines. `landed` returns.
 * Everything else ends in a throw WITHOUT Enter, after taking the body back out:
 *
 *   - `mismatch`, at once — no amount of waiting turns a tail into a message;
 *   - `pasting` that never completes within the attempts;
 *   - `unseen` for a tool whose composer this module has measured
 *     (`clearBeforeSend`: claude, codex). There, a composer that never shows
 *     the body means it did not arrive, and Enter would submit nothing while
 *     the caller printed `Message sent.`.
 *
 * `unseen` on any other tool proceeds, with a warning: those composers are
 * drawn in ways this module has not measured, and refusing on them would turn
 * "cannot see it" into "did not send it" for every long message they get.
 *
 * @throws Error when the body cannot be confirmed in the composer
 */
async function confirmPasteLanded(params: {
  sessionName: string;
  message: string;
  cliToolId: CLIToolType;
  composer: ComposerSpec;
  attempts: number;
}): Promise<void> {
  const { sessionName, message, cliToolId, composer, attempts } = params;
  let state: PasteLandedState = 'unseen';
  let output = '';
  for (let attempt = 0; attempt < Math.max(1, attempts); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, PASTE_LANDED_POLL_MS));
    output = await capturePane(sessionName, { startLine: -composer.verifyCaptureLines });
    state = classifyPasteLanded(output, cliToolId, message, composer);
    if (state === 'landed' || state === 'mismatch') break;
  }

  if (state === 'landed') return;
  if (state === 'unseen' && !composer.clearBeforeSend) {
    logger.warn('paste-landed-unverified', { sessionName, cliToolId, bytes: Buffer.byteLength(message, 'utf8') });
    return;
  }

  const bytes = Buffer.byteLength(message, 'utf8');
  const lineCount = message.split('\n').length;
  const shown = describeComposer(output, composer);
  await withdrawUnsentBody(sessionName, cliToolId, composer);
  invalidateCache(sessionName);
  logger.error('paste-not-landed', { sessionName, cliToolId, state, bytes, lines: lineCount, shown });

  const what =
    state === 'mismatch'
      ? `the composer does not hold the message as sent (it shows ${shown})`
      : state === 'pasting'
        ? `the paste had not finished arriving after ${attempts * PASTE_LANDED_POLL_MS}ms (the composer shows ${shown})`
        : `the message never appeared in the composer (${shown})`;
  throw new Error(
    `Message body did not arrive intact for session ${sessionName}: ${what}; the message is ${bytes} bytes / ${lineCount} lines. ` +
      'Enter was not pressed, so nothing was submitted (Issue #2464).'
  );
}

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
 *   - `unsupported_tool` — never reached (a tool only enters this path when
 *     its `ComposerSpec.clearBeforeSend` is true),
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
 * Which tools take part is {@link ComposerSpec.clearBeforeSend} since Issue
 * #1933. The gate is `extractComposerText`'s reach, not a preference: it
 * short-circuits every unmeasured tool to `unsupported_tool`, so for
 * gemini/copilot/opencode/vibe-local/antigravity {@link clearComposer} can never
 * observe an empty box and always returns `cleared: false`. Reading that as "the
 * clear failed" and refusing to send would take every one of those tools offline
 * while claude kept working and the unit tests stayed green — so those tools do
 * not enter the clear path at all: no read-back capture, no `C-e`+`C-u`, no new
 * failure mode. Byte-for-byte the pre-#1880 send. codex joined in #1890, and the
 * fix there was to measure codex's input box, not to relax the gate: adding the
 * next tool means a live 200x1000 capture of its box, its idle placeholder and
 * its dialogs, pinned as fixtures.
 *
 * @throws Error when the composer still holds text after the pass cap.
 */
export async function clearComposerBeforeSend(
  sessionName: string,
  cliToolId: CLIToolType,
  composerSpec: ComposerSpec = resolveComposerSpec(cliToolId)
): Promise<void> {
  if (!composerSpec.clearBeforeSend) return;

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
 * A body longer than {@link LITERAL_SEND_MAX_BYTES} is pasted instead of typed,
 * and Enter waits until the composer shows all of it (Issue #2464); a body that
 * does not arrive intact THROWS before Enter, with nothing submitted.
 *
 * @throws Error when the body does not arrive intact, or submit cannot be
 *   confirmed within the bounded attempts.
 */
export async function sendMessageWithSubmitVerification(
  params: SubmitVerifiedSendParams
): Promise<void> {
  const {
    sessionName,
    message,
    cliToolId,
    composer = resolveComposerSpec(cliToolId),
    textInputWaitMs = TUI_TEXT_INPUT_WAIT_MS,
    interEnterWaitMs = TUI_TEXT_INPUT_WAIT_MS,
    verifyAttempts = DEFAULT_VERIFY_ATTEMPTS,
    verifyDelayMs = TUI_MESSAGE_PROCESSED_WAIT_MS,
    pasteLandedAttempts = DEFAULT_PASTE_LANDED_ATTEMPTS,
  } = params;
  const submitEnterCount = params.submitEnterCount ?? composer.submitEnterCount;

  // 0. Empty the composer first (Issue #1880). The body below is typed at the
  //    TUI's current cursor position, so anything already in the box would be
  //    spliced into it. Throws for a claude composer that could not be emptied.
  await clearComposerBeforeSend(sessionName, cliToolId, composer);

  if (Buffer.byteLength(message, 'utf8') > LITERAL_SEND_MAX_BYTES) {
    // 1'. A body that would reach the TUI as more than one pty read is pasted
    //     as ONE bracketed paste, and Enter waits until the composer shows all
    //     of it (Issue #2464). Typed, Claude Code would keep only its last read.
    const pastedAt = Date.now();
    await pasteBody(sessionName, message);
    await confirmPasteLanded({ sessionName, message, cliToolId, composer, attempts: pasteLandedAttempts });
    // 2'. Keep the tool's own registration delay as a floor.
    const remaining = textInputWaitMs - (Date.now() - pastedAt);
    if (remaining > 0) {
      await new Promise((resolve) => setTimeout(resolve, remaining));
    }
  } else {
    // 1. Type the body only — never send Enter in the same tmux command.
    //
    //    `{ literal: true }` is Issue #1933 受入条件 S9 and it is not decoration.
    //    `tmux send-keys` resolves its argument against the key table first, so
    //    until this flag existed a message body of exactly `Escape` interrupted
    //    the agent (`1b`), `Enter` submitted an empty composer (`0d`) and `C-c`
    //    sent SIGINT — and a body starting with `-` was eaten by getopt and sent
    //    nowhere at all, with `rc 0`. All four measured on tmux 3.5a; the argv is
    //    built in `lib/tmux/key-sequence.ts`, which carries the table.
    await sendKeys(sessionName, message, false, { literal: true });

    // 2. Let the TUI register the input before pressing Enter.
    await new Promise((resolve) => setTimeout(resolve, textInputWaitMs));
  }

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

    const output = await capturePane(sessionName, { startLine: -composer.verifyCaptureLines });
    const state = classifySubmit(output, cliToolId, message, composer);

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
