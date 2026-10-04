/**
 * Copilot pattern constants and helpers moved out of `../../cli-patterns.ts`
 * (Issue #3217). `cli-patterns.ts` re-exports every public name.
 */

import { stripAnsi } from '../../ansi';
import { PASTED_TEXT_PATTERN } from '../../shared/pasted-text';
import { stripBoxDrawing } from '../../shared/strip-box-drawing';

/**
 * Copilot prompt pattern (Issue #545)
 * Copilot CLI shows "❯" followed by cursor/text hint:
 *   - "❯ [7m [0mType @ to mention files, # for issues/PRs, / for commands, or ? for"
 *   - "❯ " (bare prompt)
 * Also matches "? " prefix for question prompts.
 */
export const COPILOT_PROMPT_PATTERN = /^[>❯]\s|^\?\s+/m;

/**
 * Copilot thinking/processing pattern (Issue #545)
 * Copilot CLI shows various action indicators during processing:
 *   - "Exploring repo (Esc to cancel · 2.3 KiB)"
 *   - "Reasoning ■■■ medium"
 *   - "... Thinking"
 *   - Tool use: "● Read package.json" / "◉ Mapping structure (Esc to cancel · 8.4 KiB)"
 * Note: "Esc to cancel" alone is not used because trust dialog footer also contains it.
 * Instead, match the action pattern with parenthesized context: "(Esc to cancel ·"
 * Braille spinner characters (U+2800-U+28FF) are also checked.
 *
 * Issue #1897: the bare words `Generating` and `Processing` were dropped. This
 * constant is also a member of {@link COPILOT_SKIP_PATTERNS}, so every
 * alternative here doubles as a "delete this line from the saved response" rule
 * and as the tail-window liveness test in `extractResponse`. Those two words are
 * ordinary English -- a reply whose last line reads "Processing complete." had
 * the line deleted AND pinned the turn to "still thinking" for as long as it was
 * on screen, so the response was never saved at all. The remaining alternatives
 * are all glyph- or punctuation-shaped and cannot occur in prose by accident.
 * Nothing is lost as a running signal either: #1885 measured 0 matches for this
 * whole pattern across 44 live generating frames of copilot 1.0.80, whose turn
 * state is read from the status bar by {@link readCopilotStatusBar} instead.
 */
export const COPILOT_THINKING_PATTERN = /[\u2800-\u28FF]|\(Esc to cancel|Reasoning\s+[■▪▮]|\.\.\.\s+Thinking/;

/**
 * Copilot CLI's bottom status bar while a turn is in flight (Issue #1885).
 *
 * Measured on copilot 1.0.80 at the production 200x1000 geometry
 * (`tests/unit/lib/detection/fixtures/copilot-live-1885/`). The bar is the
 * bottom row of the pane and reads, across 44 captured generating frames:
 *
 *   " ● Working esc interrupt                              GPT-5.6 Terra"
 *   " ◉ Working · 1.5 KiB esc interrupt                       GPT-5.6 Terra"
 *
 * The leading glyph cycles through ● ◉ ◎ ○ and the byte counter appears only
 * once the turn has produced output, so neither is anchored on. `esc interrupt`
 * is the affordance hint copilot draws for as long as the turn can be
 * interrupted -- it is on every generating frame and on every tool-execution
 * frame -- which makes it the same signal opencode's
 * {@link OPENCODE_PROCESSING_INDICATOR} rests on.
 *
 * It is matched against the STATUS BAR ROW ONLY, never a window
 * (see {@link readCopilotStatusBar}). `status-vocabulary-in-response.txt` is a
 * live frame where copilot was asked to print this vocabulary and answered
 * " ● Working esc interrupt" as body text: a window match would have pinned that
 * finished session to `running` for the rest of its life.
 *
 * No /g flag (S4-5: would make test() stateful). No quantifier over a
 * character class that can match its neighbour (SEC4-001: ReDoS safe).
 */
export const COPILOT_WORKING_STATUS_PATTERN = /\besc\s+interrupt\b/;

/**
 * Copilot CLI's bottom status bar while no turn is running (Issue #1885).
 *
 * The same row as {@link COPILOT_WORKING_STATUS_PATTERN}, in the state copilot
 * paints when it is NOT working:
 *
 *   " ← open sidebar · / commands · ? help · tab next tab            GPT-5.6 Terra"
 *
 * This is copilot's positive completion evidence under design rule D1
 * (`docs/design/multi-agent-state-architecture.md` §4 D1 decision 1, item 2):
 * the key-hint bar and the working bar are two renderings of one row, so seeing
 * the hints is an affirmative observation that the turn is over -- not the
 * absence of a busy marker somewhere on screen. The composer cannot carry that
 * evidence on copilot: `❯` between its two full-width rules is drawn during
 * generation too (measured on every frame of the running fixtures), which is
 * exactly why the always-visible prompt used to win at step 3 of
 * `detectSessionStatus` and report a generating session as ready.
 *
 * Two alternative spellings of one affordance, because copilot has reworded
 * this row before: 1.0.80 shows "? help", and the pre-1.0.79 wording survives
 * in {@link COPILOT_SKIP_PATTERNS} as "? for shortcuts". "/ commands" covers
 * the slash-command hint independently, so a rewording of either half alone
 * does not cost the tool its completion evidence.
 *
 * No /g flag (S4-5). Linear alternation, no nested quantifiers (SEC4-001).
 */
export const COPILOT_IDLE_STATUS_PATTERN = /\/\s+commands\b|\?\s+(?:help\b|for\s+shortcuts\b)/;

/**
 * The two states {@link readCopilotStatusBar} can positively identify.
 */
export type CopilotStatusBarState = 'working' | 'idle';

/**
 * Read copilot's bottom status bar out of a captured frame (Issue #1885).
 *
 * Takes the whole frame rather than a row so the positional anchor -- "the
 * status bar is the bottom row of the pane" -- cannot be lost at a call site.
 * The scan stops at the first non-blank row from the bottom: if that row is
 * neither state, this returns null and the caller has no evidence, which is the
 * D1-correct answer rather than a guess. Two measured frames rely on it:
 *
 *  - a permission dialog replaces the whole bottom of the pane with its box, so
 *    the bottom row is `╰───…` and neither pattern matches. The dialog then
 *    reaches `detectPrompt` and is reported as `waiting`, unchanged.
 *  - the `/model` picker ends in its own footer
 *    ("↑/↓ to navigate · … · enter to select · esc to cancel"), which is not the
 *    status bar either -- so this reports nothing about it and leaves that
 *    screen to the selection-list branch (Issue #1895's subject).
 *
 * @param contentLines - Frame rows, ANSI already stripped, in pane order
 * @returns The state the bottom row announces, or null when it announces neither
 */
export function readCopilotStatusBar(
  contentLines: readonly string[]
): CopilotStatusBarState | null {
  for (let i = contentLines.length - 1; i >= 0; i--) {
    const row = contentLines[i];
    if (row.trim() === '') continue;
    if (COPILOT_WORKING_STATUS_PATTERN.test(row)) return 'working';
    if (COPILOT_IDLE_STATUS_PATTERN.test(row)) return 'idle';
    return null;
  }
  return null;
}

/**
 * Copilot separator pattern (Issue #545)
 * Placeholder - to be updated after Phase 1 TUI investigation.
 */
export const COPILOT_SEPARATOR_PATTERN = /^─{10,}$/m;

/** How far above the bottom row copilot's closing rule may sit. */
const COPILOT_STATUS_BAR_MAX_ROWS = 2;

/** How many rows copilot's composer may span before the block stops looking like chrome. */
const COPILOT_COMPOSER_MAX_ROWS = 40;

/**
 * One of the two rows that fence copilot's composer.
 *
 * Two renderings of one thing, because copilot redrew its composer between the
 * builds this file is measured against (Issue #2269):
 *
 *  - **1.0.80** fences it with a full-width horizontal rule, `─` to the pane's
 *    width, above and below.
 *  - **1.0.82** fences it with a half-block frame instead: `╻` (U+257B) followed
 *    by `▄` to the pane's width above, `╹` (U+2579) followed by `▀` below.
 *
 * The corner glyph is REQUIRED on the 1.0.82 forms and that is load-bearing, not
 * decoration. 1.0.82 also boxes the echoed user prompt in the transcript between
 * two dividers of the same half blocks — `tests/unit/lib/detection/fixtures/
 * copilot-live-2269/turn-complete.txt` rows 10 and 12 — and those carry no
 * corner. Accepting a bare `▄`/`▀` run here would let the newest echo's box be
 * read as the composer, which would put `findCopilotChromeStart` ~985 rows too
 * high and delete the reply along with the chrome.
 */
const COPILOT_RULE_ROW = /^(?:─{10,}|╻▄{10,}|╹▀{10,})$/;

/**
 * copilot's composer glyph, at the pane's own indent.
 *
 * `>` is the legacy spelling, `❯` is 1.0.80's. 1.0.82 draws no prompt glyph in
 * the composer at all: the row is the frame's left edge, `┃` (U+2503), and the
 * operator's text follows it (`copilot-live-2269/boot-idle.txt` row 998 is the
 * bare glyph on an empty composer). `┃` is safe to accept here even though the
 * reasoning block's rows also start with a vertical — that one is `│` (U+2502,
 * {@link COPILOT_BOX_ROW_PATTERN}) — and in any case this test is only ever
 * applied to the single row between two fence rows, never to a window.
 */
const COPILOT_COMPOSER_GLYPH = /^ {0,2}[>❯┃]/;

/**
 * Locate the start of copilot CLI's bottom-pinned chrome within a captured pane
 * (Issue #1897).
 *
 * copilot 1.0.80 runs on the alternate screen and reserves the last five rows of
 * the pane. Measured at the production 200x1000 geometry
 * (`tests/unit/lib/detection/fixtures/copilot-live-1885/`), with the transcript
 * ~970 rows above and nothing but padding in between:
 *
 *     <cwd> [⎇ <branch>]                    Session: N AIC used
 *     ────────────────────  ← opening rule
 *     ❯ <composer>
 *     ────────────────────  ← closing rule
 *      ◉ Working · 1.5 KiB esc interrupt          GPT-5.6 Terra  ← status bar
 *
 * Issue #2269 re-measured the same five rows on 1.0.82, where the fence and the
 * composer are drawn differently but the layout is unchanged:
 *
 *     <cwd>                                          Session: N AIC used
 *     ╻▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄  ← opening frame
 *     ┃<composer>
 *     ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀  ← closing frame
 *      ← open sidebar · / commands · ? help · tab next tab   GPT-5.6 Terra
 *
 * Both spellings live in {@link COPILOT_RULE_ROW} and
 * {@link COPILOT_COMPOSER_GLYPH}; the search below is unchanged. Until they were
 * added this function returned -1 on every 1.0.82 frame, `contentEnd` fell back
 * to the whole pane, and the saved reply opened with 199 `▀` and ended with the
 * `← open sidebar …` footer -- #2269's headline symptom.
 *
 * The boundary is found structurally -- closing rule, opening rule, composer
 * glyph -- and never by matching the status bar's wording. That is the same
 * reasoning {@link findClaudeChromeStart} records (#1289) plus the measurement
 * behind {@link COPILOT_WORKING_STATUS_PATTERN}: copilot will print its own
 * status-bar vocabulary as body text when asked to
 * (`status-vocabulary-in-response.txt` holds ` ● Working esc interrupt` as a
 * reply), so a vocabulary rule strong enough to delete the real bar also deletes
 * that reply. Position is the only thing that separates them.
 *
 * Without this trim the bar is transcript as far as every consumer is concerned:
 * it reached the TUI accumulator on every poll and was saved to History as the
 * agent's answer (#1897's headline symptom, ` Working esc interrupt GPT-5.6
 * Terra`), and its spinner glyph and byte counter change on every tick, so it
 * also defeats the content dedup the alternate-screen tools rely on (#1268).
 *
 * @param lines - Captured pane rows, ANSI-bearing or not; trailing blanks tolerated
 * @returns Index of the first chrome row, or -1 when the pane carries no chrome
 *   (a permission dialog draws its box over the whole bottom of the pane, so
 *   there is no composer and no bar -- those frames return -1 and are left to
 *   `detectPrompt`, exactly as {@link readCopilotStatusBar} leaves them)
 */
export function findCopilotChromeStart(lines: readonly string[]): number {
  const isRule = (line: string): boolean => COPILOT_RULE_ROW.test(stripAnsi(line).trim());

  let lastRow = lines.length - 1;
  while (lastRow >= 0 && stripAnsi(lines[lastRow]).trim() === '') lastRow--;
  if (lastRow < 0) return -1;

  let closingRule = -1;
  for (let i = lastRow; i >= Math.max(0, lastRow - COPILOT_STATUS_BAR_MAX_ROWS); i--) {
    if (isRule(lines[i])) {
      closingRule = i;
      break;
    }
  }
  if (closingRule < 0) return -1;

  let openingRule = -1;
  for (let i = closingRule - 1; i >= Math.max(0, closingRule - COPILOT_COMPOSER_MAX_ROWS); i--) {
    if (isRule(lines[i])) {
      openingRule = i;
      break;
    }
  }
  if (openingRule < 0) return -1;

  // Confirm the fenced rows are the composer rather than a reply that happens to
  // sit between two horizontal rules.
  if (!COPILOT_COMPOSER_GLYPH.test(stripAnsi(lines[openingRule + 1] ?? ''))) return -1;

  // The row above the opening rule is copilot's cwd/branch/session header, which
  // an overlay (the `/model` picker) replaces with a blank rather than with
  // transcript -- measured on all five non-dialog fixtures.
  return Math.max(0, openingRule - 1);
}

/**
 * A row copilot draws as part of a box or a collapsed reasoning block
 * (Issue #1897).
 *
 * 1.0.80 renders the model's private reasoning as a `⌄ Thought for 41s` header
 * followed by rows that each begin `│ `, and draws dialogs inside `╭─╮`/`╰─╯`
 * frames. {@link COPILOT_SKIP_PATTERNS} already carries a `[╭╮╰╯│]` rule, but
 * `normalizeCopilotLine` deletes every U+2500..U+257F glyph *before* the skip
 * patterns are applied, so by the time that rule runs the row it is meant to
 * catch reads as ordinary prose -- which is how the TUI accumulator came to save
 * copilot's chain-of-thought as the reply. Matched against the ANSI-stripped row,
 * before normalisation.
 *
 * `─` is deliberately absent: a rule row is {@link COPILOT_SEPARATOR_PATTERN}'s
 * job, and `── heading ──` is content.
 */
export const COPILOT_BOX_ROW_PATTERN = /^\s*[│└╰╭╮╯├┤┬┴┼]/;

/**
 * copilot's collapsed-section header (Issue #1897).
 *
 * Measured on 1.0.80: `⌄ Thinking…` while the reasoning block is live, replaced
 * by `⌄ Thought for 41s` once the turn moves on. Anchored on the `⌄` disclosure
 * glyph rather than on the words, because "Thinking…" also occurs as body text
 * -- `status-vocabulary-in-response.txt` contains exactly that row as a reply,
 * and it must survive cleaning.
 */
export const COPILOT_REASONING_HEADER_PATTERN = /^\s*⌄\s/;

/**
 * copilot's echo of the operator's own prompt in the transcript (Issue #1897).
 *
 * 1.0.80 draws every transcript row at the pane's one-column indent -- ` ❯ Reply
 * with exactly the word: pong` -- while the composer at the bottom of the pane is
 * at column 0. The bare `^[>❯]` form therefore never matched the echo, so
 * `resolveExtractionStartIndex`'s copilot branch found no anchor, fell back to
 * line 0, and handed the launch banner to the cleaner as the turn's reply.
 *
 * Bounded to two leading spaces rather than `\s*` so a quoted `> …` line inside a
 * reply cannot be mistaken for a new turn boundary.
 */
export const COPILOT_USER_ECHO_PATTERN = /^ {0,2}[>❯]\s+\S/;

/**
 * One of the half-block dividers copilot 1.0.82 boxes a transcript row with
 * (Issue #2269).
 *
 * 1.0.80 drew the echoed prompt as a single bare ` ❯ <text>` row. 1.0.82 draws
 * a full-width `▄` run above it and a full-width `▀` run below it
 * (`copilot-live-2269/turn-complete.txt` rows 10 and 12):
 *
 *      ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄
 *       ❯ Reply with exactly the word: uat-run1   00:27
 *      ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
 *      ● uat-run1
 *
 * {@link COPILOT_SKIP_PATTERNS}' `/[█▘▝▖▗▔▄▌▐]/` rule already dropped the `▄`
 * row. `▀` (U+2580) was not in that class, so the row BELOW the echo survived --
 * and extraction starts one row past the echo, which made a wall of 199 `▀` the
 * first line of every saved 1.0.82 reply.
 *
 * Deliberately not "add `▀` to that character class": this requires a run of ten
 * or more and nothing else on the row, so a reply that happens to use a single
 * half block as a glyph is untouched. The optional leading corner accepts the
 * composer's own fence rows (`╻▄…` / `╹▀…`) as well, which is defence in depth
 * only -- {@link findCopilotChromeStart} cuts those structurally, and this rule
 * is what stops them reaching History if a future build moves the fence again.
 */
export const COPILOT_TRANSCRIPT_DIVIDER_PATTERN = /^\s*[╻╹]?[▀▄]{10,}\s*$/;

/**
 * The verbs copilot prints on a tool row, as a regex alternation source.
 *
 * One list, shared by {@link COPILOT_TOOL_ROW_PATTERN} here and by
 * `COPILOT_TOOL_ACTION_PATTERN` in `response-cleaner.ts`: the two match the same
 * vocabulary behind different markers, and a verb added to one and not the other
 * is a leak nothing fails on.
 *
 * `Asked user` / `Asking user` are Issue #2269's addition. copilot answers a
 * prompt it cannot act on by calling its ask-user tool, and the row it leaves in
 * the transcript (`● Asked user What would you like me to help with?`, measured
 * in `copilot-live-2269/turn-oneword-echo-askuser.txt`) was being saved as the
 * agent's reply -- the "launch screen as the answer" the Issue reports.
 */
export const COPILOT_TOOL_VERBS =
  'Get|Read|Run|Search|Write|Edit|Delete|List|Create|Fetch|Explore|Execute|Install|Asked user|Asking user|Model changed to:';

/**
 * copilot 1.0.82's tool row, whose marker is a file-type badge (Issue #2269).
 *
 * 1.0.80 drew every tool row as `● <Verb> …` and `COPILOT_TOOL_ACTION_PATTERN`
 * reads exactly that. 1.0.82 puts a short badge for the file the tool touched in
 * front of the verb instead, and only falls back to `●` for a type it has no
 * badge for. Measured verbatim over
 * `copilot-live-2269/turn-tool-badges.txt` and `turn-tool-rows.txt`:
 *
 *     / Search "a.ts" 1 file found
 *     MD Read note.md L1:1 (1 line read)
 *     TS Read a.ts 1 line read
 *     PY Read c.py 1 line read
 *     {} Read b.json 1 line read
 *     ● Read d.txt 1 line read          ← plain text keeps the 1.0.80 marker
 *
 * So the badge is `/`, `{}`, or two to four upper-case characters. Two is the
 * floor on purpose: a one-character class would also match the pronoun in an
 * English sentence ("I Read the file"), and no measured badge is one character.
 * `●` is left to `COPILOT_TOOL_ACTION_PATTERN`, which is the rule that already
 * owns it -- copilot's own prose is `● <text>` too (`● done`, `● 対象ファイルを
 * 確認して内容を読み込みます。`), and only the verb list separates the two.
 *
 * The `$` badge is absent for the same reason: `$ Shell Print requested text 2
 * lines…` opens a BLOCK whose command rows follow, which is
 * `COPILOT_TOOL_INVOCATION_PATTERN`'s job, and `Shell` is not in the verb list
 * anyway.
 *
 * No /g flag (S4-5: would make test() stateful). No quantifier nested inside
 * another (SEC4-001: ReDoS safe).
 */
export const COPILOT_TOOL_ROW_PATTERN = new RegExp(
  `^\\s*(?:\\/|\\{\\}|[A-Z][A-Z0-9+#]{1,3})\\s+(?:${COPILOT_TOOL_VERBS})[\\s:]`,
);

/**
 * A wrapped continuation of the copilot transcript row above it (Issue #1897).
 *
 * Marker rows (` ❯ `, ` ● `, ` $ `, ` ⌄ `) carry one leading space; the rows they
 * wrap onto are indented further and carry no marker, and a blank row separates
 * one block from the next (measured on 1.0.80 at 200x1000). Used to walk past the
 * tail of a long *user* prompt so the extracted reply does not open with the
 * second half of the operator's own question.
 */
export const COPILOT_TRANSCRIPT_CONTINUATION_PATTERN = /^ {2,}\S/;

/**
 * Rows that only copilot's first-launch screen draws (Issue #1897).
 *
 * The launch screen is a complete, idle frame: the composer is drawn, the status
 * bar shows key hints, and nothing about it says "no turn has happened yet". So
 * `extractResponse` classified it as a finished response and History opened with
 * the banner as the agent's first message -- before the operator's first prompt.
 *
 * These anchors are only ever consulted for a frame that carries no echoed user
 * prompt at all (see the copilot banner guard in `extractResponse`), which is
 * what keeps a reply that quotes any of this wording from being suppressed.
 */
export const COPILOT_BOOT_BANNER_ANCHORS: readonly RegExp[] = [
  /No copilot-instructions\.md found/,
  /Copilot uses AI, so always check for mistakes\./,
  /Copilot v\d[\w.]*\s+uses AI/,
  /^\s*(?:●\s+)?GitHub Copilot\s+v\d/m,
  /^\s*(?:●\s+)?Tip:\s*\//m,
  /Describe a task to get started/,
  /Prefer a visual workspace\?/,
  // Issue #2269: copilot's greeting for a prompt it cannot act on. It arrives
  // through the ask-user tool, so the row that reaches the transcript is
  // `● Asked user Hi — what would you like to work on?` and the dialog's own
  // body repeats the question. Both are chrome for a turn that produced no
  // answer, and the operator saw the greeting saved as the agent's reply.
  /what would you like to work on\?/i,
] as const;

/**
 * The key-hint footer copilot draws under a picker, matched one ROW at a time
 * (Issue #547; rewritten against live 1.0.80 frames by Issue #1895).
 *
 * The pattern this replaced --
 * `/Search\s+\w+\.\.\.|Select\s+Model|to (?:navigate|select).*Enter to (?:select|confirm)/`
 * -- matched **none** of the eleven pickers 1.0.80 opens (measured; the frames
 * are in `tests/unit/lib/detection/fixtures/copilot-picker-1895/`, and #1885 /
 * #1886 / #1913 reached the same result independently). `/model` renders
 * `❯  Search models…` with U+2026 rather than three periods, no picker carries
 * the words `Select Model`, and every footer spells its verbs in lower case.
 *
 * What all eleven footers do share is the shape of a key-hint bar: `·`-separated
 * hints carrying either arrow-key navigation or a lower-case dismiss verb.
 * Measured verbatim, bottom-most first:
 *
 *   /model       ↑/↓ to navigate · ←/→ reasoning effort · tab context window ·
 *                shift+tab group: recommended · enter to select · esc to cancel
 *   /agent       n new agent · ? learn more · esc cancel
 *   /theme       ↑/↓ to navigate · enter to select · esc to cancel
 *   /permissions 1-2 to select · ↑/↓ to navigate · enter to confirm · esc to cancel
 *   /skills      ↑/↓ to navigate · enter to toggle · esc to close
 *   /mcp         ↑/↓ to select · enter to show · a to add · esc to close
 *   /settings    / search · ↑/↓ navigate · tab switch scope · enter edit ·
 *                ctrl+r reset · ctrl+e editor · esc close
 *   /statusline  ↑/↓ nav · enter toggle · esc close
 *   /subagents   ↑/↓ to navigate · space on/off · r reset · enter to select · esc to cancel
 *   /resume      / search · ↑/↓ navigate · enter select · ←/→ switch tabs · r refresh ·
 *                x delete · s sort:relevance · esc cancel
 *   /session     / search · ↑/↓ navigate · enter open · n new · tab switch tabs · a filter:all
 *
 * Neither half of the alternation is universal -- `/agent` has no list to walk
 * so it prints no `↑/↓`, and `/session` offers no `esc` -- but every footer has
 * one of them, so the union covers 11/11 while each individual disjunct stays
 * specific enough to be worth requiring. The slash in `↑/↓` is optional only as
 * a rewording tolerance: the synthetic frames pinned since Issue #547 spell it
 * `↑↓`, and whether copilot ever drew it that way is not something this Issue
 * measured. Every 1.0.80 footer above has the slash.
 *
 * Three deliberate narrowings keep this off ordinary text:
 *  - the `·` lookahead, so a sentence such as "press esc to cancel" is not a
 *    footer unless it is also a hint bar;
 *  - lower case, which is what 1.0.80 draws. `(Esc to cancel · 2.3 KiB)` -- the
 *    capitalised spelling in {@link COPILOT_THINKING_PATTERN} -- is a *progress*
 *    row, and it would otherwise satisfy both halves of this pattern;
 *  - `cancel|close` only, so the status bar's `esc interrupt`
 *    ({@link COPILOT_WORKING_STATUS_PATTERN}) is not a footer either.
 *
 * The narrowings are defence in depth; the load-bearing guard is positional and
 * lives in {@link isCopilotSelectionFrame} -- copilot's own answer text can and
 * does contain these exact rows (`picker-vocabulary-in-response.txt` is a live
 * frame of it), so no window-scoped match on this vocabulary can be safe.
 *
 * No /g flag (S4-5: would make test() stateful). `[^\n]*` cannot cross a row and
 * no quantifier is nested inside another (SEC4-001: ReDoS safe).
 */
export const COPILOT_SELECTION_FOOTER_PATTERN =
  /^(?=[^\n]*·)[^\n]*(?:↑\/?↓|\besc\s+(?:to\s+)?(?:cancel|close)\b)/m;

/**
 * How many non-blank rows up from the bottom of the pane may carry the footer.
 *
 * Nine of the eleven pickers put it on the bottom row itself; `/agent` and
 * `/subagents` draw their panel with a closing full-width rule underneath it,
 * which puts the footer two non-blank rows up. Three is that measurement plus
 * one row of slack -- deliberately far short of a window that could reach the
 * transcript, which on the production 200x1000 geometry sits ~950 rows above.
 */
const COPILOT_SELECTION_FOOTER_SCAN_ROWS = 3;

/**
 * Whether the pane is sitting on one of copilot's pickers (Issue #1895).
 *
 * Takes the whole frame rather than a window for the same reason
 * {@link readCopilotStatusBar} does: the evidence is positional, and a call site
 * cannot be trusted to preserve "near the bottom of the pane" on its own. Two
 * facts, both measured on 1.0.80, make the position sufficient:
 *
 *  - **A picker replaces copilot's chrome.** In the idle and generating states
 *    the bottom five rows are cwd / rule / composer / rule / status bar; while a
 *    picker is up, none of them are drawn. So a frame whose bottom row is a
 *    status bar is not a picker, whatever its transcript says -- which is the
 *    whole of the false-positive half of Issue #1895. `detectSessionStatus`
 *    reads the same row for the running verdict at step 0.5, so checking it
 *    first here also fixes the order between the two branches: the status bar
 *    wins, and the picker branch only speaks when copilot has taken it away.
 *  - **An answerable dialog is drawn inside a box; a picker is not.** The
 *    folder-trust and permission dialogs wear the same lower-case
 *    `↑/↓ to navigate · enter to select · esc to cancel` footer, but every one of
 *    their rows reads `│ … │` and the bottom row is `╰─…─╯`. Skipping boxed rows
 *    keeps those on the prompt branch, where they belong: they are the agent
 *    blocked on the human (`hasActivePrompt: true`, exit 10 for `wait`), not a
 *    list the operator opened.
 *
 * @param contentLines - Frame rows, ANSI already stripped, in pane order
 * @returns True when the bottom of the pane is a picker's key-hint footer
 */
export function isCopilotSelectionFrame(contentLines: readonly string[]): boolean {
  if (readCopilotStatusBar(contentLines) !== null) return false;

  let scanned = 0;
  for (let i = contentLines.length - 1; i >= 0; i--) {
    const row = contentLines[i];
    const trimmed = row.trim();
    if (trimmed === '') continue;
    if (++scanned > COPILOT_SELECTION_FOOTER_SCAN_ROWS) break;
    // A boxed row belongs to a dialog, not a picker (see above).
    if (trimmed.startsWith('│') || trimmed.endsWith('│')) continue;
    if (COPILOT_SELECTION_FOOTER_PATTERN.test(row)) return true;
  }
  return false;
}

/**
 * Anchors of Copilot CLI's first-launch "Confirm folder trust" dialog (Issue #1886).
 *
 * Recorded from copilot 1.0.80 (`tests/fixtures/copilot-folder-trust-1080.ts`):
 * copilot asks this once per untrusted git repository, before anything else runs,
 * and the whole dialog is drawn inside a box — every row reads `│ <content>`.
 * That is why `COPILOT_PROMPT_PATTERN` (`^[>❯]\s`) does not match the frame at
 * all and `waitForReady` used to spin its full 30-second window against it.
 *
 * Both anchors are required. One of them alone would also match this dialog's
 * text quoted back inside a model response, and a false positive here does not
 * merely mis-report a status: it sends a bare `1` into a live composer.
 *
 * The anchors live here rather than in `cli-tools/copilot` for the same reason
 * codex's do (Issue #1829): the Auto-Yes poller judges the same screen through
 * `detectPrompt`, and two copies of the wording would be two chances to disagree
 * about what this dialog is.
 */
export const COPILOT_FOLDER_TRUST_ANCHORS: readonly string[] = [
  'Confirm folder trust',
  'Do you trust the files in this folder?',
] as const;

/**
 * The one option CommandMate may answer on the operator's behalf: `1. Yes`,
 * which grants trust for THIS SESSION only.
 *
 * Matching the option text — not just the dialog — is the fail-safe. Option 2
 * ("Yes, and remember this folder for future sessions") writes `trustedFolders`
 * into `~/.copilot/config.json`, one file shared by every checkout on the
 * machine (measured: answering `1` leaves that file byte-identical). If copilot
 * ever reorders the list so that `1` is the remembering variant, this stops
 * matching, nothing is sent, and the launch degrades to the pre-#1886 stall
 * instead of silently persisting a trust grant.
 *
 * Written against the box-stripped frame, where the row reads `❯ 1. Yes`.
 * `[ \t]*$` rather than `\s*$` so the trailing anchor cannot roll onto a later
 * line and accept `1. Yes, and remember ...`.
 */
export const COPILOT_FOLDER_TRUST_SESSION_OPTION_PATTERN = /^[ \t]*(?:[>❯][ \t]*)?1\.[ \t]+Yes[ \t]*$/m;

/**
 * Key that selects {@link COPILOT_FOLDER_TRUST_SESSION_OPTION_PATTERN}.
 * Measured on 1.0.80: the digit confirms on its own — sending a trailing Enter
 * would land on the composer that the dialog's dismissal reveals.
 */
export const COPILOT_FOLDER_TRUST_ANSWER_KEY = '1';

/**
 * Whether the pane is sitting on the folder-trust dialog with the session-only
 * option in first position.
 *
 * @param output - ANSI-stripped pane capture (box drawing still present)
 * @returns True when both anchors and the `1. Yes` option row are present
 */
export function isCopilotFolderTrustDialog(output: string): boolean {
  if (!COPILOT_FOLDER_TRUST_ANCHORS.every((anchor) => output.includes(anchor))) {
    return false;
  }
  return COPILOT_FOLDER_TRUST_SESSION_OPTION_PATTERN.test(stripBoxDrawing(output));
}

/**
 * Copilot skip patterns for response cleaning (Issue #545)
 * Placeholder patterns - to be refined after Phase 1 TUI investigation.
 */
export const COPILOT_SKIP_PATTERNS: readonly RegExp[] = [
  PASTED_TEXT_PATTERN,
  COPILOT_SEPARATOR_PATTERN,
  COPILOT_THINKING_PATTERN,
  // Issue #1895 replaced COPILOT_SELECTION_LIST_PATTERN with the row-scoped
  // picker footer; the vocabulary it carried (`Search \w+...` / `Select Model`)
  // is copilot's prose, not its chrome.
  COPILOT_SELECTION_FOOTER_PATTERN,
  // Collapsed reasoning header (Issue #1897): "⌄ Thinking…" / "⌄ Thought for 41s"
  COPILOT_REASONING_HEADER_PATTERN,
  // 1.0.82's transcript dividers and badge-marked tool rows (Issue #2269)
  COPILOT_TRANSCRIPT_DIVIDER_PATTERN,
  COPILOT_TOOL_ROW_PATTERN,
  // Issue #2269: the anchored box-row rule, so the raw-row consumer agrees with
  // the accumulator. `[╭╮╰╯│]` below is unanchored and omits `└`, which is the
  // glyph copilot opens a detail row with (`   └ Enable all permissions (tools,
  // paths, and URLs)` under the launch screen's tip). `normalizeCopilotLine`
  // deletes every U+2500..U+257F glyph, so by the time the skip patterns run in
  // `cleanCopilotResponse` that row reads as prose -- which is how the ONE row
  // of the 1.0.82 launch screen that no other rule caught became the agent's
  // first reply. `extractCopilotContentLines` already tests this pattern before
  // normalising (#1897); adding it here is what gives `extractResponse`, which
  // never normalises, the same answer.
  COPILOT_BOX_ROW_PATTERN,
  // Logo/banner lines
  /^GitHub Copilot\s+v/,
  /[█▘▝▖▗▔▄▌▐]/,
  /[╭╮╰╯│]/,
  // Status bar (branch + model display)
  /\[⎇\s+\w[^\]]*\]/,
  // Operation guide lines
  /^shift\+tab\s/,
  /^\?\s+for\s+shortcuts/,
  /^ctrl\+[a-z]\s+\w/,
  // Prompt lines
  /^[❯>]\s*(Type\s+@|$)/,
  // Tip/hint lines. Issue #2269 added the `●` marker: 1.0.82 draws the launch
  // screen's tip as `● Tip: /allow-all`, and `cleanCopilotResponse` strips the
  // bullet only AFTER the skip patterns have run, so the bare form never
  // matched and the tip was the one banner row that reached History.
  /^\s*(?:●\s+)?Tip:\s*\//,
  // Issue #2269: copilot's own tab bar, the top row of every 1.0.82 frame. It is
  // the second banner row the launch screen leaked (the logo, the disclaimer and
  // the tip's `└ …` detail row are all caught by the glyph rules above), and
  // between them they are the whole difference between "the launch screen cleans
  // to nothing and cannot be saved" and "History opens with the banner". Spelled
  // out in full rather than as a keyword so a reply that mentions one of these
  // words is untouched.
  /^\s*Current\s+Sessions\s+Issues\s+Pull requests\s+Gists\s*$/,
  // Initial display text
  /^Describe a task to get started/,
  // Issue #571: Disclaimer, initialization message, environment info
  /^Copilot uses AI, so always check for mistakes\.$/,  // Disclaimer (full-line match to avoid filtering user content mentioning Copilot)
  /^● 💡/,                                              // Initialization hint message
  /^● Environment loaded:/,                              // Environment info
] as const;
