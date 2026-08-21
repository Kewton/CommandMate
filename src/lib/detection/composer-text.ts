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
 * ## Scope: claude and codex, one measured layout at a time
 *
 * Every supported CLI draws a different input box, so each one has to be
 * measured before it is read; {@link extractComposerText} reports
 * `unsupported_tool` for the rest, and no unmeasured tool can publish a
 * placeholder as if it were the user's unsent text.
 *
 * codex was added in Issue #1890, because the pre-send clear that #1880 built
 * on top of this module is gated on the same reach and so was silently
 * claude-only: a codex composer with residual text still spliced that residual
 * into the next message. Its layout has no box at all — the composer is a
 * bottom-pinned run of rows introduced by `›` (U+203A), with the model/cwd
 * footer or a completion popup below it — so it is located by
 * {@link findCodexInputBox} rather than by claude's separator walk, which finds
 * no closing separator on a codex frame.
 *
 * codex paints its own dim placeholder into an EMPTY composer, exactly as
 * claude does (`Ask Codex to do anything`, `Use /skills to list available
 * skills`, `Find and fix a bug in @filename`), so the dim rule carries over
 * unchanged. What does NOT carry over is the glyph: codex reuses `›` at column 0
 * for two other things, and reading either as the composer is the expensive
 * mistake (#1880's clear would then hammer `C-e`+`C-u` into a dialog and finally
 * refuse to send at all). Measured live on codex-cli 0.148.0, pane 200x1000 —
 * fixtures under `tests/unit/lib/detection/fixtures/codex-live-1890/`:
 *
 * ```text
 * ESC[1m›ESC[0m ESC[2mAsk Codex to do anythingESC[0m   ← composer, dim  → ghost
 * ESC[1m›ESC[0m echo PREFILLED                         ← composer, plain → content
 * ESC[1;2m› ESC[0mCreate a file scripts/greet.sh       ← the transcript echo of a
 *                                                        SENT message: DIM glyph
 * ESC[1mESC[38;5;6m› 1. Yes, proceed (y)ESC[0m         ← a dialog's selected
 *                                                        option: BOLD text
 * ```
 *
 * So a codex row is the composer only when its `›` is not dim (that rules out
 * the transcript echo) and the text after it is not bold (that rules out the
 * highlighted option of an approval dialog, the model picker, and the hooks
 * review screen — on all of which the composer is genuinely off-screen and
 * `no_composer` is the honest answer). Both are read from the same SGR scan the
 * dim rule already needs; `tmux display-message -p '#{cursor_x}'` corroborates
 * every fixture (2 = empty buffer) but is not used, for the same reason as on
 * claude — it cannot be applied to a frame after the fact.
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
 * are `content` / `ghost` / `empty` / `unsupported_tool`; `no_composer` is the
 * fifth, honest answer for a frame whose input box is not on screen at all (a
 * full-screen dialog, a pager, a session that just started).
 */
export type ComposerTextState =
  /** Real, non-dim text is sitting in the input box. `text` is it. */
  | 'content'
  /** The input box holds only dim decoration (suggestion / placeholder). */
  | 'ghost'
  /** The input box is on screen and holds nothing. */
  | 'empty'
  /** This CLI's composer layout has not been measured (see SUPPORTED_COMPOSER_TOOLS). */
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

/** Codex's input-box prompt glyph, `\u203A`. */
const CODEX_PROMPT_GLYPH = '\u203A';

/** {@link CODEX_PROMPT_GLYPH} in the form {@link stripGutter} matches with. */
const CODEX_PROMPT_GLYPH_PATTERN = /^\u203A/;

/**
 * How many bottom blocks of a codex frame may be searched for the composer.
 *
 * codex separates every screen region with a blank row, so the frame's tail is a
 * short stack of blank-row-delimited blocks. Measured live (0.148.0, 200x1000):
 * the composer is the 2nd block from the bottom when the model/cwd footer is
 * below it (idle, generating, multi-row residual) and when a slash-completion
 * popup has replaced that footer, and the 3rd when an `@`-mention popup adds its
 * own hint row. Four is that worst case plus one.
 *
 * It is a bound, not a convenience. Without it the walk would keep climbing past
 * a full-screen dialog into the scrollback, where a composer row from BEFORE the
 * dialog opened is still rendered (see
 * `fixtures/codex-live-1671/turn-running-command.txt`, which carries one 28 rows
 * up) — and reporting that stale row as the live composer is how a clear ends up
 * firing `C-e`+`C-u` at a dialog.
 */
const CODEX_TRAILING_BLOCK_SCAN = 4;

/** How many rows a codex composer may span before the reader stops following it. */
const CODEX_INPUT_BOX_MAX_ROWS = 40;

/** The rows of codex's bottom-pinned composer within a captured pane. */
export interface CodexInputBox {
  /** Index of the `\u203A` row. */
  firstRow: number;
  /** Index of the composer's last row (inclusive). */
  lastRow: number;
}

/** Whether a raw pane row renders as blank (ANSI-only rows count as blank). */
function isBlankRow(line: string | undefined): boolean {
  return line === undefined || stripAnsi(line).trim() === '';
}

/**
 * Whether one raw row is codex's composer line rather than a look-alike.
 *
 * codex puts `\u203A` at column 0 in three different places, and only one of them
 * is the input box. All three are separated by attributes alone, which is why
 * this reads the raw row (measured on codex-cli 0.148.0):
 *
 * | Row | Raw form | Verdict |
 * |---|---|---|
 * | composer | `ESC[1m\u203AESC[0m ` + text | yes |
 * | transcript echo of a SENT message | `ESC[1;2m\u203A ESC[0m` + text | no — glyph is dim |
 * | selected option of a dialog | `ESC[1mESC[38;5;6m\u203A 1. Yes, proceed (y)ESC[0m` | no — text is bold |
 *
 * The two rejections are not symmetric in cost. Missing a real composer costs
 * the #1879 bar and leaves #1880's residual splice in place — the status quo.
 * Accepting a dialog row costs a `C-e`+`C-u` volley into that dialog followed by
 * a refusal to send at all, so both guards are written to fail closed.
 *
 * A bare `\u203A` with nothing after it is accepted: `capture-pane` trims trailing
 * whitespace, so that is what a composer with neither text nor placeholder looks
 * like, and calling it `no_composer` would be a worse answer than `empty`.
 */
function isCodexComposerRow(line: string | undefined): boolean {
  if (line === undefined) return false;
  const chars = scanAttributedChars(line);
  if (chars.length === 0 || chars[0].ch !== CODEX_PROMPT_GLYPH) return false;
  // The transcript echo of a message the user already sent.
  if (chars[0].dim) return false;
  // The gutter is exactly one ASCII space (measured; codex does not pad with NBSP
  // the way claude does). Absent entirely on a trailing-trimmed empty composer.
  if (chars.length > 1 && chars[1].ch !== ' ') return false;
  // A dialog renders its selected option bold; composer text never is.
  const firstText = chars.slice(2).find(c => c.ch !== ' ');
  return firstText === undefined || !firstText.bold;
}

/**
 * Locate codex's composer in a captured pane (Issue #1890).
 *
 * codex draws no box, so there is no separator pair to walk: the composer is a
 * run of non-blank rows whose first row is {@link isCodexComposerRow}, sitting
 * near the bottom of the frame under the model/cwd footer or a completion popup.
 * The search therefore walks the frame's trailing blank-row-delimited blocks
 * from the bottom, bounded by {@link CODEX_TRAILING_BLOCK_SCAN}, and takes the
 * first block that opens with a composer row.
 *
 * Continuation rows are the block's remaining rows; codex indents them by the
 * two columns the glyph and its gutter occupy. The block ends where codex's next
 * blank row starts, which also means a composer holding a blank LINE is read
 * only down to it — that truncates the reported text but still reports
 * `content`, so the clear loop and the bar both still do the right thing.
 *
 * @param lines - Captured pane lines, ANSI-bearing; trailing blank rows are tolerated
 * @returns The composer's row span, or null when no composer is on screen
 */
export function findCodexInputBox(lines: string[]): CodexInputBox | null {
  let row = lines.length - 1;
  while (row >= 0 && isBlankRow(lines[row])) row--;
  if (row < 0) return null;

  for (let block = 0; block < CODEX_TRAILING_BLOCK_SCAN && row >= 0; block++) {
    const blockEnd = row;
    let blockStart = row;
    while (blockStart > 0 && !isBlankRow(lines[blockStart - 1])) blockStart--;

    if (isCodexComposerRow(lines[blockStart])) {
      return {
        firstRow: blockStart,
        lastRow: Math.min(blockEnd, blockStart + CODEX_INPUT_BOX_MAX_ROWS - 1),
      };
    }

    row = blockStart - 1;
    while (row >= 0 && isBlankRow(lines[row])) row--;
  }

  return null;
}

/** One rendered character plus the SGR attributes this module cares about. */
interface AttributedChar {
  ch: string;
  dim: boolean;
  /**
   * SGR 1. Only codex needs it, and only to tell its composer glyph apart from
   * the identical glyph a dialog puts in front of its highlighted option — see
   * {@link isCodexComposerRow}. Claude's reader ignores it.
   */
  bold: boolean;
}

/** The running SGR state a row is scanned with. */
interface SgrState {
  dim: boolean;
  bold: boolean;
}

/**
 * Apply one SGR parameter list to the running attribute state.
 *
 * Only `0` (reset), `1` (bold), `2` (faint/dim) and `22` (normal intensity —
 * which cancels BOTH bold and faint) move it. The extended-color introducers are
 * consumed explicitly because their *arguments* would otherwise be read as
 * attributes: `ESC[38;5;2m` is "foreground = palette colour 2", and a naive scan
 * would see the `2` and mark the whole rest of the line as a ghost — which is
 * exactly the residual-`/cost` frame measured in #1878 (`ESC[38;5;153m`). The
 * same trap bites bold from the other side on codex, whose footer is coloured
 * `ESC[38;2;246;226;183m`.
 */
function applySgr(params: string, state: SgrState): SgrState {
  const parts = params === '' ? ['0'] : params.split(';');
  let { dim, bold } = state;
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
    if (code === 0 || code === 22) { dim = false; bold = false; }
    else if (code === 1) bold = true;
    else if (code === 2) dim = true;
  }
  return { dim, bold };
}

/**
 * Split one raw pane row into rendered characters tagged with their dim state.
 *
 * Escape sequences are consumed, never emitted: CSI (`ESC[…letter`) updates the
 * attribute state when it ends in `m` and is otherwise skipped, and OSC
 * (`ESC]…BEL` or `ESC]…ESC\`, which tmux emits for hyperlinks in the status bar)
 * is skipped whole.
 */
function scanAttributedChars(line: string): AttributedChar[] {
  const out: AttributedChar[] = [];
  let state: SgrState = { dim: false, bold: false };
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch !== '\x1b') {
      out.push({ ch, dim: state.dim, bold: state.bold });
      i++;
      continue;
    }
    const next = line[i + 1];
    if (next === '[') {
      let j = i + 2;
      while (j < line.length && !/[A-Za-z]/.test(line[j])) j++;
      if (j >= line.length) break; // truncated sequence: nothing renderable follows
      if (line[j] === 'm') state = applySgr(line.slice(i + 2, j), state);
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
 * The first row is `<glyph><separator><text>`. On claude the separator is U+00A0
 * in the live captures (Claude Code pads with a NO-BREAK SPACE, not an ASCII
 * space — measured, and the reason this drops "one whitespace character" rather
 * than matching `' '`); on codex it is an ASCII space. Continuation rows of a
 * multi-line composer are indented by the two columns the glyph and its
 * separator occupy, on both.
 */
function stripGutter(
  chars: AttributedChar[],
  isFirstRow: boolean,
  glyph: RegExp,
): AttributedChar[] {
  if (isFirstRow) {
    const glyphIndex = chars.findIndex(c => glyph.test(c.ch));
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
 * The CLIs whose composer layout has been measured and can therefore be read.
 *
 * Membership is the reach of this module, and — through
 * `cli-tools/submit-verified-sender.ts` — the reach of #1880's pre-send clear.
 * Adding an id here without a live 200x1000 capture of its input box, its idle
 * placeholder and its dialogs is how the residual-splice defect gets traded for
 * a data-loss one; see the codex measurement table on
 * {@link isCodexComposerRow}.
 */
export const SUPPORTED_COMPOSER_TOOLS: ReadonlySet<string> = new Set(['claude', 'codex']);

/** Where one CLI's composer sits in a frame, and how its rows are gutter-stripped. */
interface ComposerRegion {
  /** Index of the composer's first row. */
  firstRow: number;
  /** Index of the composer's last row (inclusive). */
  lastRow: number;
  /** Prompt glyph, used to strip the first row's gutter. */
  glyph: RegExp;
}

function locateComposer(lines: string[], cliToolId: string): ComposerRegion | null {
  if (cliToolId === 'claude') {
    const box = findClaudeInputBox(lines);
    if (box === null) return null;
    return {
      firstRow: box.openingSeparator + 1,
      lastRow: box.closingSeparator - 1,
      glyph: CLAUDE_PROMPT_GLYPH,
    };
  }

  const box = findCodexInputBox(lines);
  if (box === null) return null;
  return { firstRow: box.firstRow, lastRow: box.lastRow, glyph: CODEX_PROMPT_GLYPH_PATTERN };
}

/**
 * Read the unsent text out of a captured pane's composer.
 *
 * @param rawCapture - A pane capture **with ANSI attributes intact** (`capture-pane -p -e`).
 *   Passing a `stripAnsi`-ed frame is not an error and will not throw — it will
 *   silently report the CLI's dim placeholder as real content, which is the
 *   defect this function exists to prevent. Tests must use raw fixtures.
 * @param cliToolId - The CLI whose session was captured. Anything outside
 *   {@link SUPPORTED_COMPOSER_TOOLS} short-circuits to `unsupported_tool`.
 */
export function extractComposerText(rawCapture: string, cliToolId: string): ComposerTextResult {
  if (!SUPPORTED_COMPOSER_TOOLS.has(cliToolId)) return { text: '', state: 'unsupported_tool' };

  const lines = rawCapture.split('\n');
  const region = locateComposer(lines, cliToolId);
  if (region === null) return { text: '', state: 'no_composer' };

  const realRows: string[] = [];
  const renderedRows: string[] = [];
  for (let i = region.firstRow; i <= region.lastRow; i++) {
    const chars = stripGutter(
      scanAttributedChars(lines[i] ?? ''),
      i === region.firstRow,
      region.glyph,
    );
    realRows.push(chars.filter(c => !c.dim).map(c => c.ch).join('').trimEnd());
    renderedRows.push(chars.map(c => c.ch).join('').trimEnd());
  }

  const real = trimTrailingBlankRows(realRows).join('\n');
  if (real.trim() !== '') {
    return { text: real.slice(0, COMPOSER_TEXT_MAX_CHARS), state: 'content' };
  }
  // Nothing survived the dim filter. Whether the box looked occupied decides
  // between "the CLI drew a placeholder there" and "it is genuinely blank" — a
  // distinction the UI never shows, but `capture --json` and the tests do.
  const rendered = trimTrailingBlankRows(renderedRows).join('\n');
  return { text: '', state: rendered.trim() === '' ? 'empty' : 'ghost' };
}

function trimTrailingBlankRows(rows: string[]): string[] {
  let end = rows.length;
  while (end > 0 && rows[end - 1].trim() === '') end--;
  return rows.slice(0, end);
}
