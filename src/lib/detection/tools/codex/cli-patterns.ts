/**
 * Codex's dialog rules, read off the frame's STRUCTURE rather than its wording
 * (Issue #2310).
 *
 * ## The defect these rules exist for
 *
 * Until #2310 the only thing that told `detect.ts` "a codex dialog is on screen"
 * was a footer whitelist — `CODEX_SELECTION_LIST_PATTERN`, i.e. the literal
 * words `press enter to confirm` / `press enter to select`. Every dialog codex
 * closes with any other sentence fell straight through to the two branches that
 * read `^›` as the idle composer (branch B of `afterThinking`, and the shared
 * chain's step 3), and those publish **`ready`**. Two live captures of
 * codex-cli 0.153.2 at the production 200x1000 geometry, both blocked on a
 * keypress and both reported `ready` before this module existed
 * (`tests/unit/lib/detection/fixtures/codex-live-2310/`):
 *
 * | screen | footer | why the whitelist missed it |
 * |---|---|---|
 * | `/experimental` | `Press space to select or enter to save for next conversation` | `press SPACE to select`, not `press enter to select` |
 * | `/keymap` | `left/right group · enter edit shortcut · … · esc close` | no `press … to …` clause at all |
 *
 * A `ready` there is not cosmetic: Auto-Yes concludes there is nothing to
 * answer, the sidebar dot goes green, and `commandmate wait` takes the frame as
 * its `scraper_ready` completion — a false "Completed" on a session that has not
 * moved since the operator's last keypress.
 *
 * Note what BOTH real leaks have in common and what the Issue's own analysis
 * assumed they would not: **neither list is numbered.** A rule written only
 * around `findNumberedOptionBlock` would still report both as `ready`, so the
 * primary rule here is the attribute one below and the numbered block is the
 * corroborating second reading, not the other way round.
 *
 * ## Why the attributes and not the text
 *
 * codex puts `›` (U+203A) at column 0 in three different places, and after
 * `stripAnsi` all three are the same byte. The measured separation (0.153.2,
 * cross-checked against the 0.148.0 / 0.151.0 captures already in the tree) is:
 *
 * ```text
 * ESC[1m›ESC[0m ESC[2mAsk Codex to do anythingESC[0m      composer, empty  → composer
 * ESC[1m›ESC[0m 1. buy milk                               composer, typed  → composer
 * ESC[1;2m› ESC[0mCreate a file scripts/greet.sh          transcript echo  → dim glyph
 * ESC[1mESC[38;5;6m› 1. Yes, proceed (y)ESC[0m             approval option  → bold label
 * ESC[1mESC[38;5;6m› [ ] Network proxy  Apply network…     /experimental    → bold label
 * ESC[1mESC[38;5;6m› Global  - Open Agents      unboundESC[0m  /keymap      → bold label
 * ESC[38;5;6m› 1. Yes, continueESC[39m                     trust dialog     → coloured glyph
 * ```
 *
 * `composer-residual-leading-number.txt` is the frame that rules out the cheap
 * text guard: it is a composer holding the hand-typed string `1. buy milk`, so
 * "a `›` followed by a digit and a dot is an option" would call an idle session
 * `waiting` — the shape #1883 turned into a send guard that rejected every send.
 *
 * {@link readCodexGlyphRowKind} therefore recognises an option **positively**
 * (bold label, or a non-default foreground on the glyph) instead of defining it
 * as "not the composer". Every unrecognised shape falls to `composer`, which is
 * the direction that costs nothing: it is what the code did before #2310.
 *
 * ## Why this duplicates a little of `composer-text.ts`
 *
 * That module has the same SGR scan and the same three-way measurement, and it
 * is the right module to share it from. It is outside this Issue's `scope.allow`
 * and its `isCodexComposerRow` is not exported, so the scan is re-stated here.
 * The two differ on purpose in one place — `composer-text.ts` accepts a row with
 * a plain glyph and a plain label as the composer, which is right when the job
 * is "find the input box near the bottom" and wrong here, where the same shape
 * is the 0.151+ trust dialog's option. If they are ever merged, that difference
 * is the one to carry across, not to smooth over.
 */

import { createLogger } from '@/lib/logger';
import { findNumberedOptionBlock } from '../dialog-block';

const logger = createLogger('codex-dialog-rules');

/** codex's selection-cursor / composer glyph, U+203A. */
export const CODEX_GLYPH = '›';

/**
 * The codex build these dialog rules were read off.
 *
 * Separate from `CODEX_VERIFIED_AGAINST` on purpose: that stamp is the whole
 * detector's (`tools/verified-against.ts`, outside this Issue's scope) and still
 * names 0.148.0, while the frames below are 0.153.2. Recording the newer
 * measurement here rather than leaving it unrecorded keeps a later reader able
 * to tell "this rule is wrong" from "this rule was right for 0.153.2"; the
 * detector-wide stamp should be raised to match the next time that file is in
 * scope.
 */
export const CODEX_DIALOG_RULES_VERIFIED_AGAINST = {
  version: '0.153.2',
  capturedAt: '2026-09-04',
  paneGeometry: '200x1000',
} as const;

/**
 * The footer vocabulary codex closes its dialogs with — a SECONDARY signal.
 *
 * Deliberately not a gate. #2310 exists because a footer whitelist was load
 * bearing, and widening the whitelist would only move the next wording change
 * one sentence further away. What this pattern is for is the opposite: when
 * {@link readCodexDialogFrame} recognises a dialog by structure and this pattern
 * does NOT recognise its footer, that is a codex rewording worth a line in the
 * log ({@link reportCodexDialogFooterDrift}) rather than a silent miss.
 *
 * Every measured footer matches one of the two alternatives:
 *
 * | footer | screen | alternative |
 * |---|---|---|
 * | `Press enter to confirm or esc to cancel` | approval | both |
 * | `Press enter to confirm or esc to go back` | `/model`, `/permissions` | both |
 * | `Press enter to continue` | trust, sign-in | 1st |
 * | `Press t to trust all; enter to review hooks; esc to close` | hooks list | both |
 * | `Press t to trust; esc to go back` | hooks detail | both |
 * | `Press space to select or enter to save for next conversation` | `/experimental` | 1st |
 * | `left/right group · enter edit shortcut · … · esc close` | `/keymap` | 2nd |
 *
 * No `/g` (keeps `.test()` stateless) and no nested quantifiers (ReDoS-safe).
 */
export const CODEX_DIALOG_FOOTER_PATTERN =
  /press\s+\S+\s+to\s+\S|esc\s+(?:to\s+)?(?:cancel|close|dismiss|quit|exit|back|go\s+back)/i;

/** What one `›` row of a raw codex frame turned out to be. */
export type CodexGlyphRowKind =
  /** The input box: the operator can type here, so the session is idle. */
  | 'composer'
  /** The transcript's echo of a message that was already sent (dim glyph). */
  | 'transcript-echo'
  /** The highlighted row of a dialog: the session is blocked on a keypress. */
  | 'option';

/** The SGR attributes these rules read, tracked while scanning one row. */
interface GlyphSgrState {
  bold: boolean;
  dim: boolean;
  /** Whether a non-default foreground colour is in effect (SGR 30-37/38/90-97). */
  coloured: boolean;
}

const INITIAL_SGR: GlyphSgrState = { bold: false, dim: false, coloured: false };

/**
 * Apply one SGR parameter list to the running attribute state.
 *
 * The extended-colour introducers are consumed with their arguments because
 * those arguments would otherwise be read as attributes: `ESC[38;5;2m` is
 * "foreground = palette colour 2", and a naive scan sees the `2` and marks the
 * rest of the row dim — which is exactly codex's own option colouring
 * (`ESC[38;5;6m`) and would turn every dialog row into a transcript echo.
 */
function applySgr(params: string, state: GlyphSgrState): GlyphSgrState {
  const parts = params === '' ? ['0'] : params.split(';');
  let { bold, dim, coloured } = state;
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i] === '' ? 0 : Number(parts[i]);
    if (Number.isNaN(code)) continue;
    if (code === 38) {
      const mode = parts[i + 1] === '' || parts[i + 1] === undefined ? -1 : Number(parts[i + 1]);
      // 5 = 256-colour (one argument), 2 = 24-bit RGB (three arguments).
      if (mode === 5) i += 2;
      else if (mode === 2) i += 4;
      else i += 1;
      coloured = true;
      continue;
    }
    if (code === 48 || code === 58) {
      // Background / underline colour: same argument shapes, no bearing here.
      const mode = parts[i + 1] === '' || parts[i + 1] === undefined ? -1 : Number(parts[i + 1]);
      if (mode === 5) i += 2;
      else if (mode === 2) i += 4;
      else i += 1;
      continue;
    }
    if (code === 0) {
      bold = false;
      dim = false;
      coloured = false;
    } else if (code === 1) bold = true;
    else if (code === 2) dim = true;
    else if (code === 22) {
      bold = false;
      dim = false;
    } else if (code === 39) coloured = false;
    else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) coloured = true;
  }
  return { bold, dim, coloured };
}

/** One rendered character plus the attributes these rules read. */
interface AttributedChar {
  ch: string;
  attrs: GlyphSgrState;
}

/**
 * Split one raw pane row into rendered characters tagged with their attributes.
 *
 * Escape sequences are consumed, never emitted: CSI (`ESC[…letter`) updates the
 * attribute state when it ends in `m` and is otherwise skipped, and OSC
 * (`ESC]…BEL` or `ESC]…ESC\`, which tmux emits for hyperlinks) is skipped whole.
 */
function scanAttributedChars(row: string): AttributedChar[] {
  const out: AttributedChar[] = [];
  let state = INITIAL_SGR;
  let i = 0;
  while (i < row.length) {
    const ch = row[i];
    if (ch !== '\x1b') {
      out.push({ ch, attrs: state });
      i++;
      continue;
    }
    const next = row[i + 1];
    if (next === '[') {
      let j = i + 2;
      while (j < row.length && !/[A-Za-z]/.test(row[j])) j++;
      if (j >= row.length) break; // truncated sequence: nothing renderable follows
      if (row[j] === 'm') state = applySgr(row.slice(i + 2, j), state);
      i = j + 1;
      continue;
    }
    if (next === ']') {
      let j = i + 2;
      while (j < row.length) {
        if (row[j] === '\x07') {
          j++;
          break;
        }
        if (row[j] === '\x1b' && row[j + 1] === '\\') {
          j += 2;
          break;
        }
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
 * Classify one RAW pane row whose first rendered glyph is `›`.
 *
 * @param rawRow - One row of the capture, ANSI intact
 * @returns the row's kind, or `null` when the row is not a `›` row at all or
 *   carries no attributes to read it by
 *
 * `null` for an attribute-free row is the load-bearing case, not a formality:
 * Auto-Yes hands the detection layer a capture that has already been through
 * `stripAnsi`, and on that input every one of the three `›` uses is the same
 * text. Answering `'option'` there would call an idle composer `waiting`, so the
 * absence of attributes is reported as "cannot tell" and the callers fall back
 * to the reading they had before #2310.
 */
export function readCodexGlyphRowKind(rawRow: string): CodexGlyphRowKind | null {
  if (!rawRow.includes('\x1b')) return null;
  const chars = scanAttributedChars(rawRow);
  const glyphIndex = chars.findIndex(c => c.ch.trim() !== '');
  if (glyphIndex < 0 || chars[glyphIndex].ch !== CODEX_GLYPH) return null;

  const glyph = chars[glyphIndex].attrs;
  // The transcript echo of a message the operator already sent. Checked first:
  // codex draws it `ESC[1;2m`, so it is bold as well as dim.
  if (glyph.dim) return 'transcript-echo';

  const label = chars.slice(glyphIndex + 1).find(c => c.ch.trim() !== '');
  // Positively recognised: the two shapes every measured dialog row has.
  if (label?.attrs.bold || glyph.coloured) return 'option';

  return 'composer';
}

/** The bottom-most `›` row of a raw capture, and what it is. */
export interface CodexGlyphRow {
  kind: CodexGlyphRowKind;
  /** Index into `raw.split('\n')`. */
  row: number;
}

/**
 * Find and classify the bottom-most `›` row of a raw capture.
 *
 * "Bottom-most" is the whole point, and it is the same rule `isCodexPromptReady`
 * and `codexActiveRegionLines` already apply for their own questions: codex
 * draws on the normal screen, so a dialog the operator answered minutes ago is
 * still in the frame with its options intact (Issue #1160). Only the LAST `›`
 * row says what the pane is doing now — and when a turn is generating, that row
 * is the composer, which is why this reads `running` frames as `composer` and
 * leaves them to the thinking branches.
 *
 * @param raw - The capture exactly as it arrived, ANSI intact
 */
export function findCodexBottomGlyphRow(raw: string): CodexGlyphRow | null {
  const rows = raw.split('\n');
  for (let i = rows.length - 1; i >= 0; i--) {
    const kind = readCodexGlyphRowKind(rows[i]);
    if (kind !== null) return { kind, row: i };
  }
  return null;
}

/** What {@link readCodexDialogFrame} recognised, and how. */
export interface CodexDialogFrame {
  /**
   * The rule that fired.
   *
   * `'glyph'` — the bottom-most `›` row is a dialog's highlighted row.
   * `'numbered-block'` — a `›`-selected numbered option block sits at the bottom
   * of the content region. The second is what still answers on a capture whose
   * ANSI has been stripped, where the first cannot.
   */
  readonly by: 'glyph' | 'numbered-block';
  /** Option labels, when a numbered block was parsed; empty otherwise. */
  readonly options: readonly string[];
  /** The non-blank rows below the dialog, up to the content end. */
  readonly footer: string;
  /** Whether {@link CODEX_DIALOG_FOOTER_PATTERN} recognised {@link footer}. */
  readonly footerRecognised: boolean;
}

/** How many non-blank rows below the dialog are read as its footer. */
const FOOTER_SCAN_ROWS = 8;

function readFooterBelow(
  contentLines: readonly string[],
  fromExclusive: number,
  endExclusive: number,
): string {
  const rows: string[] = [];
  for (let i = fromExclusive + 1; i < endExclusive && rows.length < FOOTER_SCAN_ROWS; i++) {
    const row = contentLines[i].trim();
    if (row === '') continue;
    rows.push(row);
  }
  return rows.join('\n');
}

/**
 * Does this frame show a codex dialog the operator has to answer?
 *
 * Two independent readings, either of which is enough:
 *
 *  1. **the glyph rule** — the bottom-most `›` row of the RAW capture is an
 *     option row ({@link readCodexGlyphRowKind}). This is the one that catches
 *     the unnumbered menus #2310 was raised for.
 *  2. **the numbered block** — `findNumberedOptionBlock` found a `›`-selected
 *     run of options ending within a few rows of the content end. This is the
 *     reading that survives `stripAnsi`, and it is vetoed by the glyph rule when
 *     that positively says the row is the composer, so a composer holding the
 *     hand-typed text `1. buy milk` cannot be adopted as a dialog.
 *
 * Neither reading consults the footer. The footer is reported back so the caller
 * can log a codex rewording; see {@link CODEX_DIALOG_FOOTER_PATTERN}.
 *
 * @param raw - The capture with ANSI intact (`NormalizedFrame.raw`)
 * @param contentLines - The ANSI-stripped rows with trailing padding removed
 * @param contentEnd - Exclusive end of the conversation region (the row above
 *   codex's status bar, or `contentLines.length` when the bar is not on screen)
 */
export function readCodexDialogFrame(
  raw: string,
  contentLines: readonly string[],
  contentEnd: number,
): CodexDialogFrame | null {
  const glyphRow = findCodexBottomGlyphRow(raw);
  const block = findNumberedOptionBlock(contentLines, contentEnd);
  const blockIsDialog = block !== null && block.selectedGlyph === CODEX_GLYPH;

  const by: CodexDialogFrame['by'] | null =
    glyphRow?.kind === 'option'
      ? 'glyph'
      : blockIsDialog && glyphRow?.kind !== 'composer' && glyphRow?.kind !== 'transcript-echo'
        ? 'numbered-block'
        : null;
  if (by === null) return null;

  // The block's own footer when there is a block; otherwise the rows under the
  // highlighted row. `block.lastRow` and the glyph row are indices into the same
  // ANSI-stripped `contentLines`, so both spellings read the same rows.
  const footer =
    block !== null
      ? block.footer
      : readFooterBelow(contentLines, findLastGlyphContentRow(contentLines, contentEnd), contentEnd);

  return {
    by,
    options: block?.options ?? [],
    footer,
    footerRecognised: CODEX_DIALOG_FOOTER_PATTERN.test(footer),
  };
}

/** Index of the bottom-most `›` row within the content region, or -1. */
function findLastGlyphContentRow(contentLines: readonly string[], endExclusive: number): number {
  for (let i = Math.min(endExclusive, contentLines.length) - 1; i >= 0; i--) {
    if (contentLines[i].trimStart().startsWith(CODEX_GLYPH)) return i;
  }
  return -1;
}

/**
 * Footers already reported, so a rewording costs one log line and not one per
 * poll tick.
 *
 * Bounded because the key is frame text: a footer that varies (a countdown, a
 * path) would otherwise grow the set without bound. At the cap the tracker stops
 * recording rather than evicting — the point is the FIRST sighting of a new
 * wording, and a process that has already seen 64 of them has been told.
 */
const reportedFooters = new Set<string>();
const REPORTED_FOOTER_CAP = 64;

/**
 * Record that a structurally recognised codex dialog closed with a footer this
 * layer does not know (Issue #2310).
 *
 * The detection still stands — that is the whole point of judging the structure
 * — so this is not a warning about the verdict. It is the tripwire on the thing
 * that actually rots: codex's wording. #2310 was reported months after
 * `/experimental` and `/keymap` started falling through, because nothing in the
 * pipeline said so out loud.
 */
export function reportCodexDialogFooterDrift(footer: string): void {
  const key = footer.slice(0, 200);
  if (reportedFooters.has(key)) return;
  if (reportedFooters.size >= REPORTED_FOOTER_CAP) return;
  reportedFooters.add(key);
  logger.warn('codexDialogFooterUnrecognised', {
    footer: key,
    verifiedAgainst: CODEX_DIALOG_RULES_VERIFIED_AGAINST.version,
    hint: 'codex reworded a dialog footer; widen CODEX_DIALOG_FOOTER_PATTERN after re-capturing the frame',
  });
}

/** Test-only: forget the footers already reported. */
export function resetCodexDialogFooterDriftForTests(): void {
  reportedFooters.clear();
}
