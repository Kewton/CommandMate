/**
 * Composer (TUI input line) text extraction — Issue #1879.
 *
 * Answers one question about a captured pane: **is there text the user owns
 * sitting unsent in the CLI's input box, and what is it?** The Web UI cannot
 * type into the read-only terminal, so an agent that pre-fills the composer with
 * a recommended command (or a human who walked away mid-sentence) leaves text
 * that can only be executed by copy-pasting it into the message box. #1879
 * surfaces it with a one-click Enter / Clear bar; this module is the half that
 * decides what — if anything — that bar is allowed to show.
 *
 * ## Why this reads the RAW capture, before `stripAnsi`
 *
 * Claude Code v2.1 draws a **dim** (`ESC[2m`) suggestion into an *empty*
 * composer — a rotating hint (`Try "how do I log an error?"`) or a guess from
 * past input. After `stripAnsi` it is byte-for-byte indistinguishable from text
 * the user actually typed:
 *
 * ```text
 * ❯ echo PREFILLED/clear      ← ANSI-stripped. The composer is EMPTY.
 * ```
 *
 * With the attributes kept it is not ambiguous at all (measured live, pane
 * 200x1000, Claude Code v2.1.238 — see the fixtures under
 * `tests/unit/lib/detection/fixtures/claude-live-1879/`):
 *
 * ```text
 * ESC[39m❯<NBSP>ESC[2mTry "how do I log an error?"ESC[0m   ← dim  → ghost, composer empty
 * ESC[39m❯<NBSP>echo PREFILLED                             ← plain → real residual
 * ESC[39m❯<NBSP>ESC[38;5;153m/costESC[39m                  ← colored, not dim → real residual
 * ```
 *
 * Publishing a ghost as composer content would produce a bar whose Clear button
 * visibly does nothing (`C-u` does not remove what was never in the buffer) and
 * whose Enter button claims to run a command that does not exist. So the rule
 * is: **a character counts as composer content only when it is not dim.**
 *
 * `capturePane` already captures with `-e` (`src/lib/tmux/tmux.ts`), so the
 * attributes are present in every frame the poller and the WebSocket push
 * already fetch. The alternative discriminator measured in #1878 —
 * `tmux display-message -p '#{cursor_x}'`, where `cursor_x === 2` means the
 * buffer is empty — is equally reliable but costs one extra tmux round-trip per
 * poll tick per session, and cannot be applied to a frame after the fact (the
 * WebSocket push, `commandmate capture --json`, and every fixture-based test all
 * carry the frame and nothing else). SGR won on both counts.
 *
 * ## Scope: claude only, on purpose
 *
 * Every other supported CLI draws a different input box, and codex renders its
 * own idle placeholder (`Ask Codex to do anything`, `Use /skills to list
 * available skills`) with the same dim attribute a real value would not have —
 * see `tests/unit/lib/detection/fixtures/codex-live-1628/idle-ready.txt`. Rather
 * than guess at each layout, {@link extractComposerText} reports
 * `unsupported_tool` for everything but claude, so no other tool can ever
 * publish a placeholder as if it were the user's unsent text.
 *
 * This module is a leaf: it imports `./ansi` (itself dependency-free) and
 * nothing else, so the browser bundle can run the exact same extraction the
 * server does. That is deliberate — `useTerminalPanePolling` derives the
 * composer text client-side from the frame it already has, which keeps the
 * WebSocket push path and the HTTP poll path from disagreeing.
 */

import { stripAnsi } from './ansi';

/**
 * What the composer region of a captured frame turned out to hold.
 *
 * The four states the #1879 acceptance criteria require to be distinguishable
 * are `content` / `ghost` / `empty` / `unsupported_tool` (codex's placeholder);
 * `no_composer` is the fifth, honest answer for a frame whose input box is not
 * on screen at all (a full-screen dialog, a pager, a session that just started).
 */
export type ComposerTextState =
  /** Real, non-dim text is sitting in the input box. `text` is it. */
  | 'content'
  /** The input box holds only dim decoration (suggestion / placeholder). */
  | 'ghost'
  /** The input box is on screen and holds nothing. */
  | 'empty'
  /** This CLI's composer layout is not supported (everything except claude). */
  | 'unsupported_tool'
  /** No input box could be located in this frame. */
  | 'no_composer';

export interface ComposerTextResult {
  /** The user's unsent text, or `''` for every state other than `content`. */
  text: string;
  /** Why {@link text} is what it is. See {@link ComposerTextState}. */
  state: ComposerTextState;
}

/**
 * Upper bound on the published composer text.
 *
 * The composer can hold a pasted document, and this value rides on every poll
 * tick and every WebSocket frame. Cutting it costs nothing that matters: the bar
 * shows an excerpt to identify what is about to run, and the Enter it sends
 * executes the buffer itself, not this string.
 */
export const COMPOSER_TEXT_MAX_CHARS = 2000;

/** How far above the last row the input box's closing separator may sit. */
const CLAUDE_STATUS_BAR_MAX_ROWS = 4;

/** How many rows the input box may span before the block stops looking like the footer. */
const CLAUDE_INPUT_BOX_MAX_ROWS = 40;

/** Claude's input-box prompt glyph: legacy `>` and current `❯` (U+276F). */
const CLAUDE_PROMPT_GLYPH = /^[>❯]/;

/**
 * The rows of Claude Code's bottom-pinned input box within a captured pane.
 *
 * Located structurally (closing separator → opening separator → prompt glyph)
 * rather than by matching hint text, because the hint strings are Claude Code's
 * to change — the reasoning is spelled out on `findClaudeChromeStart`, which is
 * this function's original caller and now its only other one.
 */
export interface ClaudeInputBox {
  /** Index of the `────` row above the input box. */
  openingSeparator: number;
  /** Index of the `────` row below the input box. */
  closingSeparator: number;
}

/**
 * Locate Claude Code's input box in a captured pane.
 *
 * Extracted verbatim from `findClaudeChromeStart` (Issue #1289) so the footer
 * trimmer and the composer reader cannot drift apart about where the box is;
 * that function now delegates here.
 *
 * @param lines - Captured pane lines, ANSI-bearing or not; trailing blank rows are tolerated
 * @returns The two separator indices, or null when no input box is present
 */
export function findClaudeInputBox(lines: string[]): ClaudeInputBox | null {
  const isSeparator = (line: string): boolean => /^─{10,}$/.test(stripAnsi(line).trimEnd());

  // Callers pass both trimmed panes and raw captures padded with blank rows.
  let lastRow = lines.length - 1;
  while (lastRow >= 0 && lines[lastRow].trim() === '') lastRow--;
  if (lastRow < 0) return null;

  // The input box's closing separator sits just above the status bar.
  let closingSeparator = -1;
  for (let i = lastRow; i >= Math.max(0, lastRow - CLAUDE_STATUS_BAR_MAX_ROWS); i--) {
    if (isSeparator(lines[i])) {
      closingSeparator = i;
      break;
    }
  }
  if (closingSeparator < 0) return null;

  // Walk up over the input box to the opening separator.
  let openingSeparator = -1;
  for (let i = closingSeparator - 1; i >= Math.max(0, closingSeparator - CLAUDE_INPUT_BOX_MAX_ROWS); i--) {
    if (isSeparator(lines[i])) {
      openingSeparator = i;
      break;
    }
  }
  if (openingSeparator < 0) return null;

  // Confirm the rows between the separators really are the input box rather than
  // a reply that happens to be fenced by two horizontal rules.
  if (!CLAUDE_PROMPT_GLYPH.test(stripAnsi(lines[openingSeparator + 1] ?? ''))) return null;

  return { openingSeparator, closingSeparator };
}

/** One rendered character plus the single SGR attribute this module cares about. */
interface AttributedChar {
  ch: string;
  dim: boolean;
}

/**
 * Apply one SGR parameter list to the running `dim` state.
 *
 * Only `0` (reset), `2` (faint/dim) and `22` (normal intensity) move it. The
 * extended-color introducers are consumed explicitly because their *arguments*
 * would otherwise be read as attributes: `ESC[38;5;2m` is "foreground = palette
 * colour 2", and a naive scan would see the `2` and mark the whole rest of the
 * line as a ghost — which is exactly the residual-`/cost` frame measured in
 * #1878 (`ESC[38;5;153m`).
 */
function applySgr(params: string, dim: boolean): boolean {
  const parts = params === '' ? ['0'] : params.split(';');
  let next = dim;
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i] === '' ? 0 : Number(parts[i]);
    if (Number.isNaN(code)) continue;
    if (code === 38 || code === 48 || code === 58) {
      const mode = parts[i + 1] === '' || parts[i + 1] === undefined ? -1 : Number(parts[i + 1]);
      // 5 = 256-colour (one argument), 2 = 24-bit RGB (three arguments).
      if (mode === 5) i += 2;
      else if (mode === 2) i += 4;
      else i += 1;
      continue;
    }
    if (code === 0 || code === 22) next = false;
    else if (code === 2) next = true;
  }
  return next;
}

/**
 * Split one raw pane row into rendered characters tagged with their dim state.
 *
 * Escape sequences are consumed, never emitted: CSI (`ESC[…letter`) updates the
 * attribute state when it ends in `m` and is otherwise skipped, and OSC
 * (`ESC]…BEL` or `ESC]…ESC\`, which tmux emits for hyperlinks in the status bar)
 * is skipped whole.
 */
function scanAttributedChars(line: string, initialDim = false): AttributedChar[] {
  const out: AttributedChar[] = [];
  let dim = initialDim;
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch !== '\x1b') {
      out.push({ ch, dim });
      i++;
      continue;
    }
    const next = line[i + 1];
    if (next === '[') {
      let j = i + 2;
      while (j < line.length && !/[A-Za-z]/.test(line[j])) j++;
      if (j >= line.length) break; // truncated sequence: nothing renderable follows
      if (line[j] === 'm') dim = applySgr(line.slice(i + 2, j), dim);
      i = j + 1;
      continue;
    }
    if (next === ']') {
      let j = i + 2;
      while (j < line.length) {
        if (line[j] === '\x07') { j++; break; }
        if (line[j] === '\x1b' && line[j + 1] === '\\') { j += 2; break; }
        j++;
      }
      i = j;
      continue;
    }
    // Any other two-byte escape (charset switch, etc.): drop it.
    i += 2;
  }
  return out;
}

/**
 * Strip the input box's left gutter from one composer row.
 *
 * The first row is `❯<separator><text>`, where the separator is U+00A0 in the
 * live captures (Claude Code pads with a NO-BREAK SPACE, not an ASCII space —
 * measured, and the reason this drops "one whitespace character" rather than
 * matching `' '`). Continuation rows of a multi-line composer are indented by
 * the two columns the glyph and its separator occupy.
 */
function stripGutter(chars: AttributedChar[], isFirstRow: boolean): AttributedChar[] {
  if (isFirstRow) {
    const glyphIndex = chars.findIndex(c => CLAUDE_PROMPT_GLYPH.test(c.ch));
    if (glyphIndex < 0) return chars;
    let start = glyphIndex + 1;
    if (start < chars.length && /\s/.test(chars[start].ch)) start++;
    return chars.slice(start);
  }
  let start = 0;
  while (start < 2 && start < chars.length && chars[start].ch === ' ') start++;
  return chars.slice(start);
}

/**
 * Read the unsent text out of a captured pane's composer.
 *
 * @param rawCapture - A pane capture **with ANSI attributes intact** (`capture-pane -p -e`).
 *   Passing a `stripAnsi`-ed frame is not an error and will not throw — it will
 *   silently report Claude's dim suggestions as real content, which is the
 *   defect this function exists to prevent. Tests must use raw fixtures.
 * @param cliToolId - The CLI whose session was captured. Anything but `claude`
 *   short-circuits to `unsupported_tool`.
 */
export function extractComposerText(rawCapture: string, cliToolId: string): ComposerTextResult {
  if (cliToolId !== 'claude') return { text: '', state: 'unsupported_tool' };

  const lines = rawCapture.split('\n');
  const box = findClaudeInputBox(lines);
  if (box === null) return { text: '', state: 'no_composer' };

  const realRows: string[] = [];
  const renderedRows: string[] = [];
  for (let i = box.openingSeparator + 1; i < box.closingSeparator; i++) {
    const chars = stripGutter(scanAttributedChars(lines[i] ?? ''), i === box.openingSeparator + 1);
    realRows.push(chars.filter(c => !c.dim).map(c => c.ch).join('').trimEnd());
    renderedRows.push(chars.map(c => c.ch).join('').trimEnd());
  }

  const real = trimTrailingBlankRows(realRows).join('\n');
  if (real.trim() !== '') {
    return { text: real.slice(0, COMPOSER_TEXT_MAX_CHARS), state: 'content' };
  }
  // Nothing survived the dim filter. Whether the box looked occupied decides
  // between "Claude drew a suggestion there" and "it is genuinely blank" — a
  // distinction the UI never shows, but `capture --json` and the tests do.
  const rendered = trimTrailingBlankRows(renderedRows).join('\n');
  return { text: '', state: rendered.trim() === '' ? 'empty' : 'ghost' };
}

function trimTrailingBlankRows(rows: string[]): string[] {
  let end = rows.length;
  while (end > 0 && rows[end - 1].trim() === '') end--;
  return rows.slice(0, end);
}
