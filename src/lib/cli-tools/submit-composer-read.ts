/**
 * Reading a captured pane's composer for the submit-verified sender
 * (Issue #3963: split out of `submit-verified-sender.ts`, which re-exports the
 * public names). Pure functions of the captured text: no tmux, no waiting.
 */

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
  codexDialogBelow,
  extractComposerText,
  findCodexInputBox,
  findCodexLiveComposerRow,
  readCodexComposerFrom,
} from '@/lib/detection/composer-text';

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
export const VERIFY_WINDOW_LINES = 12;

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
  | {
      kind: 'text';
      text: string;
      rows: string[];
      /**
       * Every row from the composer's `›` row down to the footer, ANSI and glyph
       * stripped — for every codex composer holding text ({@link readSubmitComposer},
       * Issue #3880). Read from the raw frame, not from `extractComposerText`,
       * whose text is a UI excerpt (cut at 2,000 characters, 40 rows and the
       * first blank row) and so cannot say the whole body is there.
       */
      region?: string;
      /**
       * The composer's `›` row is above the twelve-row window (Issue #3906), so
       * it was found by {@link findCodexLiveComposerRow} / `findCodexInputBox`
       * rather than by the marker reader. Text there that is neither the body
       * nor a `/…` command is not taken for an emptied composer:
       * {@link classifySubmit} answers `indeterminate` for it, not `submitted`.
       */
      outsideWindow?: boolean;
    };

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
export function withoutTrailingBlankRows(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === '') end--;
  return lines.slice(0, end);
}

/**
 * Classification of the read-back pane (Issue #1501).
 *
 *   submitted     - the message left the input box (or the tool is generating).
 *   pending       - the message is still verbatim on the input line -> resend Enter.
 *   replaced      - the input line holds DIFFERENT text than we typed (a TUI popup
 *                   autocompleted/replaced the command) -> clear the line and throw,
 *                   never resend Enter.
 *   indeterminate - a codex composer above the read window holds text that is
 *                   neither the body nor a command (Issue #3906): not evidence
 *                   that the message left, nor that Enter would send it. Read
 *                   again without Enter; throw if it never resolves.
 */
export type SubmitState = 'submitted' | 'pending' | 'replaced' | 'indeterminate';

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
export function findPasteTokens(text: string): { tokens: PasteToken[]; rest: string } {
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
 * The composer as {@link classifySubmit} reads it (Issue #3205).
 *
 * {@link readComposer}'s marker reader takes the bottom-most `›` row of the
 * tail as the input line. A codex composer holding several lines draws its
 * continuation rows under the `›` row, and when one of them itself begins with
 * `›` — a body quoting a dialog's `› 1. Yes, proceed (y)` — that continuation
 * row was read as the input line: its text is not the body's first line, so a
 * body still sitting in the composer was classified `submitted` (F). Measured:
 * `tests/fixtures/codex-multiline-composer-3205/tc104-raw-pane.txt`.
 *
 * So for codex a composer of two or more rows is read with
 * `extractComposerText` — the #1890 reader `awaitTypedBody` already uses —
 * and its first line is the input line. Every other frame (a one-row
 * composer, an empty or ghost one, none at all, another tool) is read exactly
 * as before.
 *
 * Issue #3880 (H-2): this is also the reader before Enter
 * ({@link classifyPasteLanded}) and in the error text ({@link describeComposer}).
 * The paste check used to read the twelve-row tail with {@link readComposer}
 * alone, so a codex composer taller than that window (a 20-line paste, or 600
 * bytes wrapped in a narrow pane) put its `›` row above the window — `unseen`,
 * and the body that was in the composer was withdrawn and reported as not
 * landed — and a continuation row starting with `>` (a Markdown quote) was taken
 * for the input line — `mismatch`. The same frame read after Enter was
 * `pending`. One reader on both sides of Enter keeps the two verdicts about the
 * same composer.
 */
/**
 * Everything a codex composer holds, for deciding that a pasted body arrived in
 * full (Issue #3880).
 *
 * `extractComposerText` answers for the UI: its text stops at 2,000 characters,
 * at 40 rows and at the composer's first blank row, so a composer that matches
 * it may still be missing the rest of the body — or hold something after it.
 * This reads the raw rows instead, from the `›` row down to the last block of
 * the frame (codex's model / cwd footer), so a body with blank lines, more than
 * 40 rows or more than 2,000 characters is compared whole, and anything typed
 * after the body is part of what is compared.
 */
function codexComposerRegion(output: string): string | null {
  const raw = output.split('\n');
  const box = findCodexInputBox(raw);
  if (box === null) return null;
  return codexRegionFrom(raw, box.firstRow, box.lastRow);
}

/**
 * {@link codexComposerRegion} from a known `›` row (Issue #3906): the rows from
 * `firstRow` down to the frame's last block (the footer), ANSI and glyph
 * stripped. `lastRow` is the end of the `›` row's own block, so a composer that
 * is itself the frame's last block is read to the end.
 */
function codexRegionFrom(raw: string[], firstRow: number, lastRow: number): string {
  const isBlank = (row: string): boolean => stripAnsi(row).trim() === '';
  let end = raw.length - 1;
  while (end >= 0 && isBlank(raw[end])) end--;
  let lastBlockStart = end;
  while (lastBlockStart > 0 && !isBlank(raw[lastBlockStart - 1])) lastBlockStart--;
  const stop = lastBlockStart > lastRow ? lastBlockStart - 1 : end;
  const rows = raw.slice(firstRow, stop + 1).map((row) => stripAnsi(row));
  rows[0] = rows[0].replace(/^\s*\u203A ?/, '');
  return rows.join('\n');
}

/** End (inclusive) of the blank-row-delimited block that starts at `row`. */
function blockEndFrom(raw: string[], row: number): number {
  let end = row;
  while (end + 1 < raw.length && stripAnsi(raw[end + 1]).trim() !== '') end++;
  return end;
}

/** The bottom-most row of `windowLines` the marker reader takes as the input line, as a frame index. */
function markerRowIndex(windowLines: string[], windowStart: number): number {
  for (let i = windowLines.length - 1; i >= 0; i--) {
    if (INPUT_LINE_MARKER.test(windowLines[i])) return windowStart + i;
  }
  return -1;
}

export function readSubmitComposer(
  output: string,
  cliToolId: CLIToolType,
  reader: ComposerSpec['reader'],
  lines: string[],
  windowLines: string[],
  message?: string
): ComposerRead {
  if (cliToolId === 'codex' && reader === 'input-line-marker') {
    const raw = output.split('\n');
    const windowStart = lines.length - windowLines.length;
    const read = extractComposerText(output, cliToolId);
    if (read.state === 'content') {
      const box = findCodexInputBox(raw);
      // Issue #3906: a dialog option drawn below the composer the extractor
      // located means the dialog is what the pane shows now, on every branch
      // below — that composer is one left from before, not this send's.
      if (box !== null && codexDialogBelow(raw, box.firstRow)) return { kind: 'absent' };
      const outsideWindow = box !== null && box.firstRow < windowStart;
      const region = codexComposerRegion(output) ?? read.text;
      if (read.text.includes('\n')) {
        // Issue #3906: a composer of many rows with no blank line (20 lines) has
        // its `›` row above the window too, and is marked so like the others.
        return {
          kind: 'text',
          text: firstNonBlankLine(read.text),
          rows: read.text.split('\n'),
          region,
          ...(outsideWindow ? { outsideWindow } : {}),
        };
      }
      // Issue #3906 (1): the `›` row sits above the twelve-row window (a one-line
      // paragraph, a blank line, then a tall one). The marker reader would see no
      // input line there — `unseen` before Enter, `submitted` after it — so the
      // composer `extractComposerText` located is read instead, whole.
      if (outsideWindow && findCodexLiveComposerRow(raw) === box.firstRow) {
        return { kind: 'text', text: read.text.trim(), rows: [raw[box.firstRow]], region, outsideWindow: true };
      }
      // Issue #3880 (N1): a one-row excerpt is read as before for its verdict
      // after Enter, but still carries the whole region — `head` with the rest of
      // the body under a blank row is one excerpt row and must not pass for the
      // whole body before Enter.
      const single = readComposer(reader, lines, windowLines);
      return single.kind === 'text' ? { ...single, region } : single;
    }
    if (read.state === 'no_composer') {
      // Issue #3906 (2): more paragraphs than the four blocks the extractor
      // searches. Whatever the marker reader takes must carry the whole region,
      // so the composer's first line alone never passes for the body. The row is
      // the live composer only when no dialog option is drawn below it
      // ({@link findCodexLiveComposerRow}, the order `findCodexBottomGlyphRow`
      // reads a frame in): a composer row left above an approval dialog is
      // never this send's composer, however its text reads.
      const composerRow = findCodexLiveComposerRow(raw);
      if (composerRow >= 0) {
        const region = codexRegionFrom(raw, composerRow, blockEndFrom(raw, composerRow));
        const text = stripInputMarker(stripAnsi(raw[composerRow]));
        if (composerRow >= windowStart) {
          const single = readComposer(reader, lines, windowLines);
          if (single.kind === 'text' && markerRowIndex(windowLines, windowStart) === composerRow) {
            return { ...single, region };
          }
          return single;
        }
        // Above the window as well, with no dialog below it.
        if (message !== undefined && text.length > 0 && inputMatchesBody(text, message)) {
          return { kind: 'text', text, rows: [raw[composerRow]], region, outsideWindow: true };
        }
        // Not the body's first line. A composer whose own block is empty or
        // placeholder-only is empty; real text is read too — a `/…` command
        // there is `replaced` as it is inside the window, and anything else is
        // not proof that the message left ({@link classifySubmit}: `indeterminate`).
        const held = readCodexComposerFrom(raw.slice(0, blockEndFrom(raw, composerRow) + 1), composerRow);
        if (held.state !== 'content') return { kind: 'empty' };
        return {
          kind: 'text',
          text: firstNonBlankLine(held.text),
          rows: [raw[composerRow]],
          region,
          outsideWindow: true,
        };
      }
    }
  }
  return readComposer(reader, lines, windowLines);
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
 *      pre-#1501 permissive default, so normal sends never spuriously fail) —
 *      except in a codex composer above the read window -> indeterminate
 *      (Issue #3906).
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
  return classifySubmitWithRule(output, cliToolId, message, composerSpec).state;
}

/**
 * Which of {@link classifySubmit}'s rules decided a frame (Issue #4035). B is
 * split into its two readings — no composer on screen (`B-absent`) and an empty
 * one (`B-empty`) — and F into the window's (`F`) and the codex composer above
 * it (`F-outside`), because the sender trusts them differently.
 */
export type SubmitRule = 'A' | 'B-absent' | 'B-empty' | 'C' | 'D' | 'E' | 'F' | 'F-outside';

/** {@link classifySubmit}'s verdict and the rule that gave it (Issue #4035). */
export interface SubmitVerdict {
  state: SubmitState;
  rule: SubmitRule;
}

/**
 * {@link classifySubmit} with the rule that decided the frame (Issue #4035).
 * The sender logs the rule with every verdict, and treats a `submitted` from B
 * or F — the screen saying only "the body is not in the composer" — as weaker
 * evidence than A on a tool whose own hook reports the prompt.
 */
export function classifySubmitWithRule(
  output: string,
  cliToolId: CLIToolType,
  message: string,
  composerSpec: ComposerSpec = resolveComposerSpec(cliToolId)
): SubmitVerdict {
  const clean = stripAnsi(output);
  const lines = withoutTrailingBlankRows(clean.split('\n'));
  const windowLines = lines.slice(-VERIFY_WINDOW_LINES);
  const windowStr = windowLines.join('\n');

  // A. Actively generating a response => the message was accepted. Read from the
  //    tail window for every tool: each one's busy marker lives in a status bar
  //    pinned to the bottom of the pane, and widening it to opencode's whole
  //    frame would match `esc interrupt` printed inside a reply.
  if (detectThinking(cliToolId, windowStr)) {
    return { state: 'submitted', rule: 'A' };
  }

  const composer = readSubmitComposer(output, cliToolId, composerSpec.reader, lines, windowLines, message);

  // B. No composer visible (scrolled off / dialog / still starting), or the
  //    composer is empty => the message left the box => submitted.
  if (composer.kind !== 'text') {
    return { state: 'submitted', rule: composer.kind === 'absent' ? 'B-absent' : 'B-empty' };
  }

  // C. A paste placeholder is still folded into the composer => body is there.
  if (composer.rows.some((row) => PASTE_PLACEHOLDER_PATTERN.test(row) || findPasteTokens(row).tokens.length > 0)) {
    return { state: 'pending', rule: 'C' };
  }

  // D. The typed body is still sitting in the composer => resend Enter.
  if (inputMatchesBody(composer.text, message)) {
    return { state: 'pending', rule: 'D' };
  }

  // E. A different slash command is in the composer => a completion popup
  //    replaced what we typed. (Scoped to `/…` so idle-prompt placeholders that
  //    some TUIs paint on an empty composer are never mistaken for this.)
  if (REPLACEMENT_COMMAND_PATTERN.test(composer.text)) {
    return { state: 'replaced', rule: 'E' };
  }

  // F. Non-empty, non-command steady-state text (idle placeholder / hint) =>
  //    submitted, preserving the pre-#1501 permissive default. Not for a codex
  //    composer above the window (Issue #3906): before #3906 that frame was
  //    read as no composer at all; text there that is not the body says
  //    neither that the message left nor that Enter would send it.
  return composer.outsideWindow ? { state: 'indeterminate', rule: 'F-outside' } : { state: 'submitted', rule: 'F' };
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
 * Reads the composer the way {@link classifySubmit} does
 * ({@link readSubmitComposer}), so a history echo of an earlier message above the
 * composer is never mistaken for this one, and a frame both functions see holds
 * the same composer for both (Issue #3880). A multi-row codex composer is
 * compared as a whole ({@link codexComposerRegion}), whitespace removed
 * (wrapping and continuation indent proof): only the WHOLE body is `landed`;
 * the body's beginning alone is `pasting` (never enough to press Enter on), the
 * body plus anything else or text from inside it is `mismatch`. The whole body
 * is checked before placeholders, so a body that itself quotes
 * `[Pasted Content 600 chars]` is its own text, not codex's placeholder; a real
 * placeholder is only ever the composer's first row.
 *
 * Issue #3906: a codex composer outside the twelve-row window, or split into
 * more blocks than `extractComposerText` searches, is still read with its whole
 * region ({@link readSubmitComposer}), so neither `unseen` for a body that is
 * there nor `landed` on its first line alone.
 */
export function classifyPasteLanded(
  output: string,
  cliToolId: CLIToolType,
  message: string,
  composerSpec: ComposerSpec = resolveComposerSpec(cliToolId)
): PasteLandedState {
  const lines = withoutTrailingBlankRows(stripAnsi(output).split('\n'));
  const composer = readSubmitComposer(
    output,
    cliToolId,
    composerSpec.reader,
    lines,
    lines.slice(-VERIFY_WINDOW_LINES),
    message
  );
  if (composer.kind !== 'text') return 'unseen';

  if (composer.region !== undefined) {
    const shown = compactText(composer.region);
    const body = compactText(message);
    if (shown === body) return 'landed';
    const placeholder = findPasteTokens(composer.text);
    if (placeholder.tokens.length > 0) {
      // A placeholder plus anything else — on its row or under it — is not the body as sent.
      const below = compactText(composer.region.split('\n').slice(1).join('\n'));
      if (placeholder.tokens.length > 1 || placeholder.rest !== '' || below !== '') return 'mismatch';
      return comparePasteToken(placeholder.tokens[0], message);
    }
    if (body.startsWith(shown)) return 'pasting';
    // The body's beginning followed by something else, the body plus more, or a
    // piece from inside it: the composer holds something other than the body.
    if (inputMatchesBody(composer.text, message) || shown.startsWith(body) || body.includes(shown)) {
      return 'mismatch';
    }
    return 'unseen';
  }

  // The whole body on one row is the body, even when it quotes a placeholder.
  if (compactText(composer.text) === compactText(message)) return 'landed';
  const { tokens, rest } = findPasteTokens(composer.text);
  if (tokens.length === 0) {
    if (inputMatchesBody(composer.text, message)) return 'landed';
    if (message.includes(composer.text)) return 'mismatch';
    return 'unseen';
  }
  if (tokens.length > 1 || rest !== '') return 'mismatch';
  return comparePasteToken(tokens[0], message);
}

/** The text with every whitespace character removed — wrapping and indent proof. */
export function compactText(text: string): string {
  return text.replace(/\s+/g, '');
}
