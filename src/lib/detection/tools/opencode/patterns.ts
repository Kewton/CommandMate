/**
 * OpenCode pattern constants and helpers moved out of `../../cli-patterns.ts`
 * (Issue #3217 I-3). `cli-patterns.ts` re-exports every public name.
 */

import { PASTED_TEXT_PATTERN } from '../../shared/pasted-text';

/**
 * OpenCode prompt pattern (Issue #379)
 * OpenCode TUI shows "Ask anything..." in the input area when waiting for user input.
 * Unlike Claude/Codex (which use > or ❯), OpenCode uses a text-based prompt indicator.
 */
export const OPENCODE_PROMPT_PATTERN = /Ask anything(?:\.\.\.|\u2026)/;

/**
 * OpenCode idle composer pattern (Issue #1883).
 *
 * The `Ask anything...` placeholder as opencode actually draws it: **inside the
 * input box**, behind the box's own gutter (`\u2503`, or `\u2502` on a lighter
 * border style). Two measured facts make that row positive evidence that the
 * composer is empty, rather than the mere absence of a busy marker (design
 * principle D1 in `docs/design/multi-agent-state-architecture.md`):
 *
 * - opencode paints the placeholder **only while the input buffer is empty**.
 *   The first typed character replaces the whole row — measured live on
 *   opencode 1.18.20, pane 80x200 (`opencode-live-1883/composer-residual.txt`
 *   holds `\u2503  echo PREFILLED` where the idle frame holds the placeholder).
 * - the gutter says the row belongs to the input box. `Ask anything...` printed
 *   in a response body has no gutter, and reading that as an idle composer is
 *   the "the phrase is on screen somewhere" inference D1 forbids.
 *
 * **Match this against the ANSI-stripped frame BEFORE {@link stripBoxDrawing}**,
 * which strips the very gutter this pattern anchors on.
 *
 * The whitespace runs are `[^\S\n]` (horizontal only) on purpose: plain `\s`
 * crosses newlines under the `m` flag, which let the gutter of one row pair up
 * with the phrase several rows below it and matched frames that hold no
 * composer at all (measured on `phrase-in-response.txt`).
 *
 * {@link OPENCODE_PROMPT_PATTERN} stays as it is: `response-checker` and
 * `OPENCODE_SKIP_PATTERNS` want the bare phrase wherever it lands, because they
 * are deleting the row from an extracted response, not judging a session.
 *
 * opencode 1.18.31 以降は見本文を U+2026（`…`）で描く。ASCII の `...` も実行ファイルに
 * 残っているので両方を受け付ける（Issue #2915、2026-09-28 に実行ファイルから確認）。
 */
export const OPENCODE_IDLE_COMPOSER_PATTERN =
  /^[^\S\n]*[\u2502\u2503][^\S\n]*Ask anything(?:\.\.\.|\u2026)/m;

/**
 * OpenCode prompt pattern after response completion (Issue #379)
 * Shows "tab agents  ctrl+p commands" in the TUI status bar after a response finishes.
 * Used as extraction stop condition in response-poller.ts [D2-003].
 */
export const OPENCODE_PROMPT_AFTER_RESPONSE = /tab agents\s+ctrl\+p commands/;

/**
 * OpenCode thinking/processing pattern (Issue #379)
 * OpenCode TUI shows "Thinking:" prefix while the Ollama model is generating a response.
 * Used by detectThinking() to determine if the tool is actively processing.
 */
export const OPENCODE_THINKING_PATTERN = /Thinking:/;

/**
 * OpenCode loading indicator pattern (Issue #379)
 * Shows a series of 4+ filled square characters (U+2B1D) during initial loading/model warm-up.
 * Filtered from response extraction via OPENCODE_SKIP_PATTERNS.
 */
export const OPENCODE_LOADING_PATTERN = /\u2B1D{4,}/;

/**
 * OpenCode's Build summary LINE, in either of the two forms it is drawn in
 * (Issue #379, corrected by Issue #1893).
 *
 * **This is a line filter, not completion evidence.** It matches
 * `▣ <Action> · <model>` with the duration OPTIONAL, and opencode 1.18 draws
 * that duration-less form on a step that is still in flight -- so a frame this
 * pattern matches may be mid-turn, waiting on a permission dialog, or aborted.
 * Use {@link OPENCODE_TURN_COMPLETE_PATTERN} to decide that a turn has finished.
 *
 * The docstring that stood here until #1893 claimed the opposite ("short
 * responses may omit the timing portion"). Measured against opencode 1.18.21 at
 * the production 80x200 geometry, that is wrong in both directions:
 *
 * - a 2.3-second answer still carries its duration
 *   (`▣  Build · GPT-5.6 Luna · 2.3s`, `opencode-live-1893/turn-complete-short.txt`),
 *   so no completed turn needs the duration-less branch;
 * - the duration-less form is what opencode leaves on screen while a tool call
 *   waits for permission and after a rejected one
 *   (`opencode-live-1893/permission-bash.txt`, `…/turn-aborted-no-duration.txt`).
 *
 * Kept loose because three callers want the LINE rather than the verdict:
 * `tui-accumulator.ts`, `response-cleaner.ts` and `polling/response-checker.ts`
 * all use it to drop the summary row from an extracted response, and the
 * mid-step row has to be dropped too. #1911 removed the one caller that used it
 * as a turn BOUNDARY rather than a line filter (the "second-to-last ▣" anchor,
 * replaced by {@link findOpenCodeUserEchoEnd}); the name is left alone because
 * the remaining three callers all want the line.
 */
export const OPENCODE_RESPONSE_COMPLETE = /\u25A3\s+\w+\s+·\s+\S+(?:\s+·\s+(?:[\d]+h\s*)?(?:[\d]+m\s*)?[\d.]+s)?/;

/**
 * OpenCode's finished-turn marker: the Build summary line WITH its duration
 * (Issue #1893).
 *
 * `▣  Build · GPT-5.6 Luna · 5.2s`. This is the one tool-specific completion
 * marker design rule D1 recognises today
 * (`docs/design/multi-agent-state-architecture.md` §4 D1 decision 1, item 1),
 * and the duration is the whole of what makes it positive evidence: opencode
 * prints the same row without a duration while a step is still open, which is
 * how a session parked on a permission dialog was published as
 * `ready`/`opencode_response_complete` (#1893) and how `isOpenCodeComplete`
 * saved the dialog body as if it were an answer.
 *
 * The model segment is `[^·\n]+` rather than `\S+` because real model names
 * carry spaces (`GPT-5.6 Luna`): with `\S+` the optional-duration group of
 * {@link OPENCODE_RESPONSE_COMPLETE} could never reach the duration on a
 * two-word model, so "with duration" and "without duration" were the same match
 * there. Excluding the middle dot rather than allowing anything keeps the
 * quantifier unable to swallow its own delimiter (no nested/ambiguous
 * quantifier -- ReDoS safe), and `.`/`[^·\n]` never cross a line without the
 * `m` flag, so the duration has to be on the marker's own row.
 *
 * Durations observed: `2.3s`, `5.2s`, `45.2s`; the `Nh`/`Nm` prefixes are
 * inherited from the #379 pattern and kept for long turns.
 */
export const OPENCODE_TURN_COMPLETE_PATTERN =
  /\u25A3\s+\w+\s+·\s+[^·\n]+·\s+(?:\d+h\s*)?(?:\d+m\s*)?[\d.]+s/;

/**
 * OpenCode's permission dialog, anchored on its button row (Issue #1893).
 *
 * opencode 1.18 asks for tool permission with a bottom-anchored box whose last
 * interactive row is a horizontal button strip:
 *
 * ```
 *   ┃  △   Permission required
 *   ┃    # Shell command
 *   ┃  $ ls -la
 *   ┃   Allow once   Allow always   Reject  ctrl+f fullscreen  ⇆ select  enter con
 * ```
 *
 * Nothing in the detection layer saw it before #1893: it carries no number, no
 * `(y/n)`, and no "press enter to confirm" footer, so `detectPrompt` answers
 * `isPrompt: false` and the status detector fell through to the Build marker
 * above it. The row is matched as POSITIVE evidence that a decision is pending
 * (design rule D1) -- it is the affordance itself, not the absence of a busy
 * marker.
 *
 * **Match this against the ANSI-stripped frame BEFORE {@link stripBoxDrawing}**,
 * exactly like {@link OPENCODE_IDLE_COMPOSER_PATTERN}: the leading `┃` (or
 * `│` on a lighter border style) is what says the row belongs to the dialog box
 * rather than to a response body that happens to quote the labels -- the
 * "the phrase is on screen somewhere" inference #1883 had to remove.
 *
 * Deliberately NOT anchored on:
 *
 * - `enter confirm`, which is truncated to `enter con` at opencode's own 80
 *   column layout (measured);
 * - `△ Permission required` alone, which is a heading rather than an
 *   affordance and survives in the fullscreen (`ctrl+f`) view whose key handling
 *   was not measured.
 *
 * The three labels are the same for the `bash` and the `edit` dialog (measured:
 * `permission-bash.txt`, `permission-edit.txt`), and the strip is repainted away
 * the moment the dialog is answered, so a matched row is never scrollback
 * (`turn-aborted-no-duration.txt` holds no `Allow once`).
 *
 * The whitespace runs are `[^\S\n]` (horizontal only) for the reason #1883
 * documents: plain `\s` crosses newlines under the `m` flag and would pair a
 * gutter on one row with labels several rows below it.
 */
export const OPENCODE_PERMISSION_PATTERN =
  /^[^\S\n]*[\u2502\u2503][^\S\n]*Allow once[^\S\n]+Allow always[^\S\n]+Reject\b/m;

/**
 * OpenCode's busy footer, in BOTH of the spellings it is drawn in (Issue #379,
 * widened by Issue #1894).
 *
 * opencode 1.18 needs Escape TWICE to abort a turn, and the first press does not
 * abort anything -- it re-labels the footer:
 *
 * ```
 *    ⬝⬝⬝⬝⬝⬝⬝⬝  esc interrupt           6.5K (1%) · $0.00  ctrl+p commands
 *    ⬝■■■■■■⬝  esc again to interrupt  7.2K (1%) · $0.00  ctrl+p commands
 * ```
 *
 * Measured on opencode 1.18.21 at the production 80x200 geometry, sampling the
 * footer every ~360 ms after a single Escape: the second spelling is up from
 * 0.31 s to 4.71 s and the row is back to `esc interrupt` at 5.07 s -- a
 * five-second window, exactly as long as the second-press deadline
 * ({@link OPENCODE_INTERRUPT_SECOND_ESCAPE_DELAY_MS} is sized against it). The
 * generation continues throughout; the turn ran to a natural
 * `▣  Build · GPT-5.6 Luna · 11.3s`, 3 runs out of 3.
 *
 * Before #1894 those five seconds matched nothing at all: `detectSessionStatus`
 * lost branch A and fell through to `running`/`default` while the frame was
 * fresh, and to `ready`/`no_recent_output` once the poller's
 * `lastOutputTimestamp` aged past `STALE_OUTPUT_THRESHOLD_MS` -- both of them
 * `statusEvidence: 'none'`, i.e. a generating session
 * published with no evidence and, on the second path, as FINISHED. That is the
 * "vocabulary changed, so `ready` came back" failure design rule D1 names
 * (`docs/design/multi-agent-state-architecture.md` §4 D1, row #1894), and the
 * row is the same positive busy evidence in either spelling.
 *
 * The optional group is `(?:again to )?` rather than a looser `.*` on purpose:
 * it matches the two measured strings and nothing between an `esc` and an
 * `interrupt` several words apart. Linear, no nested quantifiers -- ReDoS safe.
 *
 * Filtered from response extraction via OPENCODE_SKIP_PATTERNS, which shares
 * this constant: the widened row is dropped from a saved answer for the same
 * reason the narrow one was.
 */
export const OPENCODE_PROCESSING_INDICATOR = /esc (?:again to )?interrupt/;

/**
 * OpenCode's composer bottom border: `  ╹▀▀▀▀▀▀…` (Issue #1911).
 *
 * `╹` (heavy up) is the corner opencode joins the input box's `┃`
 * gutter to, and the `▀` run is the box's bottom edge. It is the one row of
 * the bottom-anchored chrome that can never appear inside a response body, which
 * makes it the anchor {@link findOpenCodeChromeStart} walks up from.
 */
export const OPENCODE_COMPOSER_BOTTOM_BORDER = /^[^\S\n]*╹▀{4,}/;

/**
 * A row that belongs to one of opencode's boxes, matched by its own gutter
 * (Issue #1911).
 *
 * opencode draws three different boxes with the same `┃` gutter (`│`
 * on a lighter border style): the echoed USER PROMPT in the transcript, the
 * COMPOSER pinned to the bottom of the pane, and the PERMISSION DIALOG that
 * replaces the composer. Which one a matched row belongs to is decided by where
 * it sits, not by what it says — see {@link findOpenCodeChromeStart} and
 * {@link findOpenCodeUserEchoEnd}.
 *
 * **Match against the ANSI-stripped frame BEFORE {@link stripBoxDrawing}**,
 * which removes the very gutter this anchors on.
 */
export const OPENCODE_GUTTER_ROW_PATTERN = /^[^\S\n]*[│┃]/;

/**
 * An echoed user prompt row: a gutter row that carries text (Issue #1911).
 *
 * The echo block opencode draws for a submitted message is a blank gutter row,
 * one or more gutter rows holding the message, and another blank gutter row.
 * This matches the middle ones.
 */
export const OPENCODE_USER_ECHO_PATTERN = /^[^\S\n]*[│┃][^\S\n]*\S/;

/**
 * The status cell of opencode's bottom footer (Issue #1911).
 *
 * Measured at the production 80x200 geometry the footer reads
 * `<cwd>    6.4K (1%) · $ctrl+p` / `commands` while idle and
 * `⬝⬝⬝⬝⬝⬝⬝⬝  esc interrupt   6.3K (1%) · $0.00  ctrl+p commands` while running:
 * a context-usage cell followed by the cost sigil. Neither
 * {@link OPENCODE_PROMPT_AFTER_RESPONSE} (`tab agents  ctrl+p commands`, which
 * opencode only prints on the FIRST idle frame, before any turn has run) nor
 * {@link OPENCODE_PROCESSING_INDICATOR} covers the idle form, so this row used
 * to be saved as part of the assistant's reply.
 *
 * This is a SECONDARY net. The cwd that shares the row wraps over up to three
 * further rows that carry no signature at all, so the footer is removed
 * structurally by {@link findOpenCodeChromeStart}; this pattern only catches the
 * signed row when that boundary is not available (e.g. a caller holding a
 * fragment rather than a whole pane).
 *
 * Linear, no nested quantifiers — ReDoS safe.
 */
export const OPENCODE_FOOTER_STATUS_PATTERN =
  /\d+(?:\.\d+)?[KMGT]?\s+\(\d+%\)\s+·\s+\$/;

/**
 * Locate the start of opencode's bottom-anchored chrome within a captured pane
 * (Issue #1911).
 *
 * opencode runs in the alternate screen and reserves the last rows of the pane
 * for chrome that is never transcript content:
 *
 * ```
 *   ┃                              ← composer box (blank rows + model row),
 *   ┃  Build · GPT-5.6 Luna …        or the permission dialog that replaces it
 *   ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀   ← composer bottom border
 *   /private/tmp/…-share-    6.4K (1%) · $ctrl+p   ← footer, cwd wrapped
 *   work-github-kewton-…                 commands     over up to three rows
 * ```
 *
 * Everything from the returned index down is chrome. This is the opencode twin
 * of {@link findClaudeChromeStart} and exists for the same reason (#1289): the
 * footer's cwd rows and the composer's model row were reaching saved responses,
 * which is defect 1 of #1911.
 *
 * Found structurally rather than by matching footer text, because the footer's
 * text is opencode's to change and two of its four rows (the cwd continuations)
 * are an arbitrary filesystem path with no signature at all.
 *
 * @param lines - Captured pane lines, ANSI-stripped, box drawing intact.
 *   Trailing blank rows are tolerated.
 * @returns Index of the first chrome row, or -1 when no chrome is recognisable.
 */
export function findOpenCodeChromeStart(lines: string[]): number {
  let last = lines.length - 1;
  while (last >= 0 && lines[last].trim() === '') last--;
  if (last < 0) return -1;

  const walkUpGutter = (from: number): number => {
    let top = from;
    while (top - 1 >= 0 && OPENCODE_GUTTER_ROW_PATTERN.test(lines[top - 1])) top--;
    return top;
  };

  // The composer's bottom border. Searched from the last row upwards over the
  // WHOLE pane rather than over the few rows the footer occupies: on the boot
  // screen opencode centres the composer under its banner (row ~99 of 200) while
  // the footer stays pinned to the bottom, so a window sized for the footer
  // misses the border entirely (measured, `opencode-live-1883/boot-idle.txt`).
  for (let i = last; i >= 0; i--) {
    if (OPENCODE_COMPOSER_BOTTOM_BORDER.test(lines[i])) {
      return walkUpGutter(i);
    }
  }

  // No border: the permission dialog draws over the composer and its own box
  // runs to the last row of the pane (measured, `opencode-live-1893/permission-*.txt`).
  if (OPENCODE_GUTTER_ROW_PATTERN.test(lines[last])) {
    return walkUpGutter(last);
  }

  return -1;
}

/**
 * Locate the last row of the NEWEST echoed user prompt in a captured pane
 * (Issue #1911).
 *
 * The turn currently being answered starts on the row after this one, so it is
 * both the extraction anchor (`resolveExtractionStartIndex`'s opencode branch)
 * and the floor the finished-turn marker has to sit below before a frame counts
 * as a completed turn (`isOpenCodeComplete`).
 *
 * Before #1911 the anchor was "the second-to-last `▣ Build` row", which has two
 * measured failure modes: on the first turn of a session there is no second row,
 * so extraction fell back to line 0 and saved the whole pane; and the row it
 * anchors on belongs to the PREVIOUS turn, so the echoed prompt of the current
 * one was always included in the reply.
 *
 * @param lines - Captured pane lines, ANSI-stripped, box drawing intact.
 * @param chromeStart - Result of {@link findOpenCodeChromeStart}; the search
 *   stops above it so the composer's and the permission dialog's own gutter rows
 *   are never read as an echoed prompt. Pass -1 when no chrome was found.
 * @returns Index of the echo block's last row, or -1 when no echo is on screen
 *   (a turn whose head has scrolled out of the alternate-screen pane).
 */
export function findOpenCodeUserEchoEnd(lines: string[], chromeStart: number): number {
  const limit = chromeStart >= 0 ? chromeStart : lines.length;

  for (let i = limit - 1; i >= 0; i--) {
    if (!OPENCODE_USER_ECHO_PATTERN.test(lines[i])) continue;
    // The block's trailing blank gutter row(s) belong to the echo, not to the reply.
    let end = i;
    while (end + 1 < limit && OPENCODE_GUTTER_ROW_PATTERN.test(lines[end + 1])) end++;
    return end;
  }

  return -1;
}

/**
 * The rows of opencode's composer that hold the INPUT BUFFER (Issue #1906).
 *
 * opencode has no prompt marker — no `>` / `❯` / `›` anywhere near its input —
 * so "is the message still sitting in the composer?" cannot be asked the way it
 * is asked of every other TUI. What opencode has instead is a box, and the box
 * has a fixed shape, measured at the production 80x200 geometry across every
 * frame in `opencode-live-1883/`, `opencode-live-1893/` and
 * `opencode-live-1906/`:
 *
 * ```
 *   ┃                                     ← buffer rows: blank when empty,
 *   ┃  Review the send path.                one row per (wrapped) line of the
 *   ┃  Check newline handling.              typed message, or the
 *   ┃  Report findings.                     `Ask anything...` placeholder on a
 *   ┃                                       session that has not answered yet
 *   ┃  Build · GPT-5.6 Luna GitHub Copilot ← the agent/model row, ALWAYS last
 *   ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀ ← the box's bottom border
 * ```
 *
 * The agent/model row is what makes a naive "any guttered row with text" read
 * wrong: it always carries text, so the composer would never look empty. It is
 * identified structurally — the last gutter row before the border — rather than
 * by matching `Build ·` or a model name, both of which are opencode's to change
 * and neither of which is stable across agents (`Build`, `Plan`, a custom agent).
 *
 * Anchored on the border, not on the bottom of the pane, because opencode
 * centres the whole box under its banner before the first turn (row ~100 of 200)
 * and only pins it to the bottom afterwards — see {@link findOpenCodeChromeStart},
 * whose upward walk this shares.
 *
 * Returns `null` when no composer is on screen at all. That is the permission
 * dialog (it replaces the composer and draws no bottom border — measured,
 * `opencode-live-1893/permission-*.txt`), a full-screen overlay, or a session
 * still starting.
 *
 * @param lines - Captured pane lines, ANSI-stripped, box drawing intact. Must be
 *   the WHOLE pane: a tail window sized for the other tools does not contain the
 *   box on a pre-first-turn frame.
 * @returns The buffer rows with their gutters intact, or `null` when the
 *   composer is not on screen. An empty array means a box with no buffer row,
 *   which no measured frame produces.
 */
export function findOpenCodeComposerRows(lines: string[]): string[] | null {
  let border = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (OPENCODE_COMPOSER_BOTTOM_BORDER.test(lines[i])) {
      border = i;
      break;
    }
  }
  if (border < 0) return null;

  let top = border;
  while (top - 1 >= 0 && OPENCODE_GUTTER_ROW_PATTERN.test(lines[top - 1])) top--;

  // `top .. border - 1` are the box's gutter rows; the last of them is the
  // agent/model row, which belongs to the chrome rather than to the buffer.
  const modelRow = border - 1;
  if (modelRow < top) return null;
  return lines.slice(top, modelRow);
}

/**
 * A composer row with its gutter (and the padding either side) removed
 * (Issue #1906). Blank for an empty buffer row.
 */
export function stripOpenCodeGutter(row: string): string {
  return row.replace(OPENCODE_GUTTER_ROW_PATTERN, '').trim();
}

/**
 * OpenCode TUI selection list pattern (Issue #473, narrowed by Issue #1896).
 *
 * Detects the fuzzy-search picker overlay opencode draws for `/models`,
 * `/providers` and `/connect`, anchored on its HEADER ROW COMPLETE WITH the
 * right-aligned `esc` hatch:
 *
 * ```
 *               Select model                                     esc
 *
 *               Search
 *
 *               Recent
 *             ● GPT-5.6 Luna GitHub Copilot
 * ```
 *
 * The `esc` is the picker's own dismiss affordance -- positive evidence that an
 * overlay is open (design rule D1), rather than the presence of two English
 * words somewhere on the pane. Until #1896 the pattern was the bare phrase, and
 * `status-detector.ts` tests it against the WHOLE content area (up to ~200 rows,
 * because the header can sit far above the last row when the list is long), so
 * an agent that merely wrote `Select model to continue:` in its answer parked the
 * session on `waiting` / `opencode_selection_list` for the rest of the session
 * -- measured live on opencode 1.18.21,
 * `opencode-live-1896/select-model-in-response.txt`.
 *
 * Requiring two or more spaces before `esc` is what separates the header row
 * from prose: the picker right-aligns the hatch across the overlay's width
 * (37 spaces in the measured frame), while a sentence that happens to end in
 * "esc" would not.
 *
 * NOT additionally anchored on the `Search` row below the header: its distance
 * from the header is unmeasured for the `Connect a provider` variant (that
 * overlay needs an unconfigured provider to open, which the live probe could not
 * produce without touching the operator's real credentials), and the header's
 * own hatch is already the affordance.
 *
 * The header allowlist is deliberately unchanged, and Issue #2112 kept it that
 * way rather than adding the five headings it found missing (`Select agent`,
 * `Sessions`, `Timeline`, `Commands`, and the palette's). #1896 left the
 * question as "a separate change with its own live frames"; #2046 supplied the
 * frames and the answer they gave is that a WIDER WORD LIST is the wrong shape.
 * Three of those dialogs published `ready` / `opencode_response_complete` — the
 * marker of the previous turn, still on the pane behind the overlay — so the
 * damage was a false COMPLETION, not a missing NavigationButtons row, and no
 * heading added here would have changed that ordering. The fix is a gate ahead
 * of the completion branch that reads the overlay's LAYOUT
 * (`lib/detection/opencode-modal-overlay.ts`, branch C2 of
 * `tools/opencode/detect.ts`), which is also what keeps the prose false
 * positives this pattern was narrowed for from coming back through a longer
 * list.
 *
 * This pattern still runs, and still first: it is the reading that survives ANSI
 * stripping, where the layout rule cannot see anything at all.
 *
 * The whitespace runs are `[^\S\n]` (horizontal only) for the reason Issue #1883
 * documents: plain `\s` crosses newlines under the `m` flag, which would let a
 * header on one row pair up with an `esc` several rows below it.
 *
 * Linear pattern, no nested quantifiers -- ReDoS safe (S4-001).
 */
export const OPENCODE_SELECTION_LIST_PATTERN =
  /^[^\S\n]*(?:Select[^\S\n]+(?:model|provider)|Connect[^\S\n]+a[^\S\n]+provider)[^\S\n]{2,}esc[^\S\n]*$/m;

/**
 * OpenCode TUI separator pattern (Issue #379)
 * Matches lines composed entirely of box-drawing / TUI decoration characters.
 * Covers: vertical lines (U+2503), box corners, horizontal lines, and other TUI elements.
 */
export const OPENCODE_SEPARATOR_PATTERN = /^[\u2503\u2579\u25A3\u2580\u2500\u250C\u2510\u2514\u2518\u251C\u2524\u252C\u2534\u253C]+$/;

/**
 * OpenCode skip patterns for response cleaning (Issue #379)
 * Lines matching any of these patterns are filtered from extracted responses.
 * Includes: TUI separators, loading indicators, Build summary prefix,
 * status bar prompts, processing indicators, input prompt, the footer's
 * context/cost status cell (Issue #1911), and pasted text markers.
 */
export const OPENCODE_SKIP_PATTERNS: readonly RegExp[] = [
  OPENCODE_SEPARATOR_PATTERN,
  OPENCODE_LOADING_PATTERN,
  /^Build\s+/,
  OPENCODE_PROMPT_AFTER_RESPONSE,
  OPENCODE_PROCESSING_INDICATOR,
  OPENCODE_PROMPT_PATTERN,
  OPENCODE_FOOTER_STATUS_PATTERN,
  PASTED_TEXT_PATTERN,
] as const;
